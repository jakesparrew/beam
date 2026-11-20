/**
 * The analyst (docs/plan/modules/assistant.md section 5.4 and 5.5): reads a conversation and
 * returns, as JSON, what the person is looking for. Every value except the summary must quote the
 * person literally; a value whose quote is not in their own messages is dropped, so the model
 * cannot invent an interest. Then the rule-based score, the CRM tags (`interest:*`, `intent:*`,
 * `objection:*`, `lead:hot|warm`), the timeline events and the agent log.
 *
 * Runs ten minutes after the last message (each new message enqueues a later run; a run that is
 * not the latest skips), right away after a contact card or a handoff (`force`).
 */
import "server-only";
import { z } from "zod";
import { assistantConversations, assistantMessages, type AssistantAnalysis } from "@beam/db/schema";
import { asc, eq } from "@/lib/ctx";
import type { JobCtx } from "@/lib/job-runner";
import { getSetting } from "@/lib/settings";
import { applyTag, getPerson } from "@/modules/crm/api";
import type { AssistantSettingValue } from "../config";
import { chatClient } from "./client";
import { costCentsOf } from "./cost";
import { LEAD_INTENTS, LEAD_INTERESTS, LEAD_OBJECTIONS, QUALIFIED_SCORE, scoreLead, scoreReason, type LeadIntent } from "./score";
import { logAction, logModelCall } from "./store";

const QUIET_MS = 9 * 60_000;

/** Models sometimes answer a quote as a list or `null`: keep the first usable string. */
const Quotes = z
  .record(z.string(), z.unknown())
  .default({})
  .transform((q) =>
    Object.fromEntries(
      Object.entries(q)
        .map(([k, v]) => [k, Array.isArray(v) ? v.find((x) => typeof x === "string") : v] as const)
        .filter((e): e is readonly [string, string] => typeof e[1] === "string" && e[1].trim().length > 0)
        .map(([k, v]) => [k, v.slice(0, 300)]),
    ),
  );

const Output = z.object({
  summary: z.string().transform((s) => s.slice(0, 400)),
  intent: z.enum(LEAD_INTENTS),
  interests: z.array(z.enum(LEAD_INTERESTS)).max(8),
  urgency: z.enum(["low", "medium", "high"]).nullable(),
  sentiment: z.enum(["positive", "neutral", "negative"]).nullable(),
  objections: z.array(z.enum(LEAD_OBJECTIONS)).max(6),
  quotes: Quotes,
});
export type AnalystOutput = z.infer<typeof Output>;

export const ANALYST_SYSTEM = `You read a chat between a visitor of BEAM Vitality Center (a wellbeing centre with day and night sessions in a large EESystem room, packages, memberships and gift vouchers) and BEAM's assistant. Return ONLY a JSON object, no prose, with these keys:
- "summary": two short sentences in Dutch for BEAM's staff: who this is and what they want.
- "intent": the main intent, one of ${LEAD_INTENTS.join(", ")}.
- "interests": zero or more of ${LEAD_INTERESTS.join(", ")} the visitor showed interest in.
- "urgency": "high" (this week or a fixed date), "medium" (this month), "low", or null when unclear.
- "sentiment": "positive", "neutral", "negative", or null.
- "objections": zero or more of ${LEAD_OBJECTIONS.join(", ")} the visitor raised.
- "quotes": for each of intent, interests, urgency, sentiment and objections that is not empty or null, the exact words of the VISITOR (copied character for character from a line starting with "V:") that show it. Keys: "intent", "interests", "urgency", "sentiment", "objections".
Use only what the visitor wrote. Lines of the assistant (A:) or staff (S:) are context, never evidence.`;

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Drops every value whose quote is not literally in the visitor's own words. */
export function validateAnalysis(out: AnalystOutput, visitorText: string): { analysis: AnalystOutput; dropped: string[] } {
  const haystack = norm(visitorText);
  const has = (key: string) => {
    const q = out.quotes[key];
    return !!q && norm(q).length >= 2 && haystack.includes(norm(q));
  };
  const dropped: string[] = [];
  const keep = <T>(key: string, value: T, empty: T): T => {
    const isEmpty = value == null || (Array.isArray(value) && value.length === 0);
    if (isEmpty || has(key)) return value;
    dropped.push(key);
    return empty;
  };
  const analysis: AnalystOutput = {
    summary: out.summary,
    intent: out.intent === "other" ? "other" : keep<LeadIntent>("intent", out.intent, "other"),
    interests: keep("interests", out.interests, []),
    urgency: keep("urgency", out.urgency, null),
    sentiment: out.sentiment === "neutral" ? "neutral" : keep("sentiment", out.sentiment, null),
    objections: keep("objections", out.objections, []),
    quotes: Object.fromEntries(Object.entries(out.quotes).filter(([k]) => !dropped.includes(k) && has(k))),
  };
  return { analysis, dropped };
}

export function parseJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}

/** Tags for a reading and a score: only intents worth acting on, every interest and objection. */
export function tagsFor(a: AnalystOutput, temperature: "hot" | "warm" | "cold"): string[] {
  const tags = [
    ...(["booking", "pricing", "membership", "gift", "b2b"].includes(a.intent) ? [`intent:${a.intent}`] : []),
    ...a.interests.map((i) => `interest:${i}`),
    ...a.objections.map((o) => `objection:${o}`),
    ...(temperature === "cold" ? [] : [`lead:${temperature}`]),
  ];
  return [...new Set(tags)];
}

export async function runAnalyse(ctx: JobCtx, input: { conversation_id: string; force?: boolean }): Promise<void> {
  const tx = ctx.tx;
  const [conv] = await tx.select().from(assistantConversations).where(eq(assistantConversations.id, input.conversation_id));
  if (!conv) return;
  const now = ctx.now;
  if (!input.force && conv.lastMessageAt.getTime() > now.getTime() - QUIET_MS) return;
  if (!input.force && conv.analysedMessageCount >= conv.messageCount) return;
  const messages = await tx
    .select({ author: assistantMessages.author, body: assistantMessages.body })
    .from(assistantMessages)
    .where(eq(assistantMessages.conversationId, conv.id))
    .orderBy(asc(assistantMessages.createdAt), asc(assistantMessages.id));
  const visitorText = messages.filter((m) => m.author === "visitor").map((m) => m.body).join("\n");
  if (!visitorText.trim()) return;
  const transcript = messages.map((m) => `${m.author === "visitor" ? "V" : m.author === "staff" ? "S" : "A"}: ${m.body.replace(/\n+/g, " ")}`).join("\n");

  const settings = (await getSetting(tx, "assistant")) as AssistantSettingValue;
  const cfg = settings.roles.analyst;
  const started = Date.now();
  const result = await chatClient().stream(
    { model: cfg.model, fallbackModel: cfg.fallback, system: ANALYST_SYSTEM, messages: [{ role: "user", content: transcript.slice(-24_000) }], maxTokens: cfg.max_tokens, effort: cfg.effort },
    () => {},
  );
  const cost = costCentsOf(settings.models, result.model, result.usage);
  const parsed = Output.safeParse(parseJsonObject(result.text) ?? fakeReading(visitorText, result.text));
  await logModelCall(tx, {
    feature: "assistant.analyse",
    model: result.model,
    actor: ctx.actor,
    personId: conv.personId,
    prompt: `[system: assistant.analyse]\n${transcript.slice(-24_000)}`,
    output: result.text,
    usage: result.usage,
    costCents: cost,
    status: parsed.success ? "ok" : "error",
    error: parsed.success ? null : "invalid_output",
    durationMs: Date.now() - started,
  });
  if (!parsed.success) {
    await tx.update(assistantConversations).set({ analysedAt: now, analysedMessageCount: conv.messageCount }).where(eq(assistantConversations.id, conv.id));
    return;
  }

  const { analysis, dropped } = validateAnalysis(parsed.data, visitorText);
  const person = conv.personId ? await getPerson(tx, conv.personId) : null;
  const scored = scoreLead({
    hasEmail: !!person?.email,
    hasPhone: !!person?.phone,
    intent: analysis.intent,
    urgency: analysis.urgency,
    sentiment: analysis.sentiment,
    interests: analysis.interests,
    bookingLinkClicked: !!conv.bookingLinkClickedAt,
  });
  const tags = tagsFor(analysis, scored.temperature);
  const stored: AssistantAnalysis = { ...analysis, tags };
  const reason = scoreReason(scored.parts);
  await tx
    .update(assistantConversations)
    .set({ analysis: stored, score: scored.score, scoreReason: reason, analysedAt: now, analysedMessageCount: conv.messageCount, updatedAt: now })
    .where(eq(assistantConversations.id, conv.id));
  await logAction(tx, { conversationId: conv.id, personId: conv.personId, kind: "analysed", detail: { intent: analysis.intent, interests: analysis.interests, score: scored.score, reason, dropped } });

  if (!conv.personId) return;
  // A fresh reading of what they want is the moment to renew the profile advice.
  await ctx.enqueue({ kind: "assistant.advise_person", payload: { person_id: conv.personId }, key: `assistant.advise:${conv.personId}:chat:${conv.id}:${conv.messageCount}` });
  const applied: string[] = [];
  for (const tag of tags) {
    try {
      if ((await applyTag(tx, ctx, conv.personId, tag, "automation")).applied) applied.push(tag);
    } catch {
      // A tag missing from the catalogue (renamed by staff) is skipped, never fatal.
    }
  }
  if (applied.length) await logAction(tx, { conversationId: conv.id, personId: conv.personId, kind: "tags_applied", detail: { tags: applied } });
  await ctx.recordEvent({
    kind: "assistant.conversation_analysed",
    personId: conv.personId,
    data: { conversation_id: conv.id, intent: analysis.intent, interests: analysis.interests, score: scored.score, tags },
    dedupeKey: `assistant:analysed:${conv.id}:${conv.messageCount}`,
  });
  if (scored.qualified && (conv.score ?? 0) < QUALIFIED_SCORE) {
    await ctx.recordEvent({ kind: "assistant.lead_qualified", personId: conv.personId, data: { conversation_id: conv.id, score: scored.score, reason }, dedupeKey: `assistant:qualified:${conv.id}` });
    await logAction(tx, { conversationId: conv.id, personId: conv.personId, kind: "lead_qualified", detail: { score: scored.score } });
  }
}

/**
 * The scripted fake answers in prose; locally and in tests a reading is derived from keywords so
 * the whole pipeline (quotes, score, tags) runs without a model.
 */
function fakeReading(visitorText: string, modelText: string): unknown {
  if (parseJsonObject(modelText)) return null;
  const lines = visitorText.split("\n");
  const find = (re: RegExp) => lines.find((l) => re.test(l));
  const night = find(/nacht|night|nuit/i);
  const day = find(/\bdag|day\b|journée/i);
  const price = find(/prijs|kost|duur|price|cost|prix|cher/i);
  const book = find(/boek|book|réserv|plaats|place/i);
  const soon = find(/morgen|vandaag|deze week|tomorrow|today|this week|demain/i);
  const interests = [night ? "night" : null, day ? "day" : null].filter(Boolean);
  return {
    summary: "Bezoeker met vragen over BEAM (testanalyse zonder model).",
    intent: book ? "booking" : price ? "pricing" : "information",
    interests,
    urgency: soon ? "high" : null,
    sentiment: null,
    objections: price && /duur|cher|expensive/i.test(price) ? ["price"] : [],
    quotes: { ...(book || price ? { intent: (book ?? price)!.slice(0, 120) } : {}), ...(interests.length ? { interests: (night ?? day)!.slice(0, 120) } : {}), ...(soon ? { urgency: soon.slice(0, 120) } : {}), ...(price && /duur|cher|expensive/i.test(price) ? { objections: price.slice(0, 120) } : {}) },
  };
}
