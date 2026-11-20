/**
 * Profile advice: the lead agent reads a person's behaviour (`behaviour.ts`) and proposes at most
 * three next steps: place them in a journey, apply a tag, or a task for a colleague. Code, not the
 * model, enforces the limits: only journeys BEAM allowed in `settings.assistant.advice.flows` that
 * are active, never one the person is already in, and never a marketing journey without newsletter
 * consent (the automation engine checks consent again before every email). The advice is one
 * `assistant_actions` row (`profile_advice`); carrying out a step updates it and logs what happened.
 * With `advice.auto_apply` the agent carries out journeys and tags itself; tasks always wait for a
 * click, so the sales list never fills up unasked.
 */
import "server-only";
import { z } from "zod";
import { assistantActions, automations } from "@beam/db/schema";
import { and, desc, eq, inArray, sql, type Ctx, type DbOrTx, type Tx } from "@/lib/ctx";
import type { JobCtx } from "@/lib/job-runner";
import { rowsOf } from "@/lib/sensitive";
import { getSetting } from "@/lib/settings";
import type { AssistantSettingValue } from "../config";
import { parseJsonObject } from "./analyse";
import { loadBehaviour, type BehaviourFacts } from "./behaviour";
import { chatClient } from "./client";
import { costCentsOf } from "./cost";
import { logAction, logModelCall } from "./store";

export const ADVICE_TAGS = ["interest:day", "interest:night", "interest:package", "interest:membership", "interest:gift_card", "lead:hot", "lead:warm"] as const;

export type Flow = { slug: string; name: string; description: string; isMarketing: boolean };

export type Recommendation = {
  type: "enrol" | "tag" | "task";
  flow?: string;
  tag?: string;
  title: string;
  reason: string;
  status: "open" | "done" | "skipped";
  result?: string;
};

export type ProfileAdvice = { facts: BehaviourFacts; persona: string; summary: string; recommendations: Recommendation[]; model: string; source: "model" | "rules" };

const Output = z.object({
  persona: z.string().transform((s) => s.slice(0, 60)),
  summary: z.string().transform((s) => s.slice(0, 500)),
  recommendations: z
    .array(z.object({ type: z.enum(["enrol", "tag", "task"]), flow: z.string().optional().nullable(), tag: z.string().optional().nullable(), title: z.string(), reason: z.string() }))
    .max(6),
});

export const ADVISOR_SYSTEM = `You are the lead agent of BEAM Vitality Center (day and night sessions in an EESystem room, packages, memberships, gift vouchers). You get one person's behaviour as JSON facts and the journeys you may use. Decide what BEAM should do next for this person. Return ONLY JSON:
{"persona": "two or three Dutch words that name this kind of customer", "summary": "two short Dutch sentences for BEAM's staff: how this person behaves and what the opportunity or risk is", "recommendations": [{"type": "enrol" | "tag" | "task", "flow": "<journey slug, for enrol>", "tag": "<tag key, for tag>", "title": "short Dutch action", "reason": "one Dutch sentence that cites the facts (numbers, dates)"}]}
Rules:
- At most three recommendations, the most valuable first. Fewer is fine; none when nothing would help.
- "enrol" only with a slug from JOURNEYS, never one listed in facts.activeFlows.
- A journey marked marketing needs newsletter consent (facts.newsletter). Without it, recommend a "task" to ask for consent at the next visit instead.
- "tag" only with a key from TAGS.
- "task" is something a colleague does (a call, an offer at the desk). Use it for things no journey covers.
- Use only the facts given. Do not guess about health, income or anything not in the facts.
- Write for colleagues at the front desk, in plain Dutch: never show field names, English keys, code or JSON (not "newsletter: false" but "geen toestemming voor de nieuwsbrief"; not "favouriteKind" but "kiest meestal nachten"). Dates as "20 november", amounts as "€ 1.385".`;

export async function flowCatalog(db: DbOrTx, allowed: readonly string[]): Promise<Flow[]> {
  if (!allowed.length) return [];
  const rows = await db
    .select({ slug: automations.slug, name: automations.name, description: automations.description, isMarketing: automations.isMarketing })
    .from(automations)
    .where(and(inArray(automations.slug, [...allowed]), eq(automations.status, "active")));
  return rows.map((r) => ({ ...r, description: r.description ?? "" }));
}

/** Keeps only what the rules allow; the model's wording stays, its liberties do not. */
export function validateAdvice(raw: z.infer<typeof Output>, facts: BehaviourFacts, flows: readonly Flow[]): Recommendation[] {
  const out: Recommendation[] = [];
  const seen = new Set<string>();
  for (const r of raw.recommendations) {
    const title = r.title.trim().slice(0, 160);
    const reason = r.reason.trim().slice(0, 300);
    if (!title) continue;
    if (r.type === "enrol") {
      const flow = flows.find((f) => f.slug === r.flow);
      if (!flow || facts.activeFlows.includes(flow.slug) || (flow.isMarketing && !facts.newsletter) || seen.has(`e:${flow.slug}`)) continue;
      seen.add(`e:${flow.slug}`);
      out.push({ type: "enrol", flow: flow.slug, title, reason, status: "open" });
    } else if (r.type === "tag") {
      if (!r.tag || !(ADVICE_TAGS as readonly string[]).includes(r.tag) || seen.has(`t:${r.tag}`)) continue;
      seen.add(`t:${r.tag}`);
      out.push({ type: "tag", tag: r.tag, title, reason, status: "open" });
    } else {
      out.push({ type: "task", title, reason, status: "open" });
    }
    if (out.length === 3) break;
  }
  return out;
}

/** Advice from the signals alone: used when the model's answer cannot be read, and in tests. */
export function ruleAdvice(facts: BehaviourFacts, flows: readonly Flow[]): z.infer<typeof Output> {
  const has = (s: BehaviourFacts["signals"][number]) => facts.signals.includes(s);
  const flow = (slug: string) => flows.some((f) => f.slug === slug);
  const recs: z.infer<typeof Output>["recommendations"] = [];
  if ((has("lapsing") || has("lost")) && flow("inactivity")) recs.push({ type: "enrol", flow: "inactivity", title: "Zet in het we-missen-je-traject", reason: `Laatste bezoek ${facts.daysSinceLastVisit} dagen geleden, gewoonlijk om de ${facts.rhythmDays ?? "?"} dagen.` });
  if (has("never_visited") && facts.status === "lead" && flow("welcome-lead")) recs.push({ type: "enrol", flow: "welcome-lead", title: "Start het welkomsttraject", reason: "Lead zonder bezoek; de welkomstmails leggen BEAM uit." });
  if (has("never_visited") && facts.status === "lead" && flow("lead-sales-follow-up")) recs.push({ type: "enrol", flow: "lead-sales-follow-up", title: "Laat sales opvolgen", reason: "Lead zonder boeking of aankoop." });
  if (has("credits_expiring")) recs.push({ type: "task", title: "Bel: tegoed vervalt binnenkort", reason: `Tegoed vervalt op ${facts.credits.find((c) => c.expiresOn)?.expiresOn ?? "korte termijn"}.` });
  if (has("loyal") && !facts.isMember) recs.push({ type: "task", title: "Stel een lidmaatschap voor", reason: `${facts.visits90} bezoeken in 90 dagen zonder lidmaatschap.` });
  if (has("no_newsletter") && facts.visits >= 1) recs.push({ type: "task", title: "Vraag toestemming voor de nieuwsbrief bij het volgende bezoek", reason: "Klant zonder nieuwsbrief-toestemming; marketingtrajecten kunnen nu niet." });
  const persona = has("loyal") ? "Trouwe bezoeker" : has("lapsing") || has("lost") ? "Afhaker" : has("never_visited") ? "Nieuwe lead" : has("new_visitor") ? "Eerste bezoek" : "Af en toe";
  return { persona, summary: `${facts.visits} bezoeken, waarvan ${facts.visits90} in de laatste 90 dagen. Signalen: ${facts.signals.join(", ") || "geen"}.`, recommendations: recs };
}

async function execute(tx: Tx, ctx: Pick<Ctx, "actor" | "now" | "requestId" | "enqueue" | "recordEvent">, personId: string, rec: Recommendation): Promise<{ status: "done" | "skipped"; result: string }> {
  // Loaded on use, for the same import-cycle reason as in `behaviour.ts`.
  const [{ enrolPersonBySlug }, { applyTag, createTask }] = await Promise.all([import("@/modules/automation/api"), import("@/modules/crm/api")]);
  if (rec.type === "enrol" && rec.flow) {
    const r = await enrolPersonBySlug(tx, { slug: rec.flow, personId });
    return r.status === "enrolled" ? { status: "done", result: "enrolled" } : { status: "skipped", result: r.outcome };
  }
  if (rec.type === "tag" && rec.tag) {
    const r = await applyTag(tx, ctx, personId, rec.tag, "automation");
    return { status: "done", result: r.applied ? "applied" : "already" };
  }
  const task = await createTask(tx, ctx, {
    title: rec.title,
    kind: "follow_up",
    ownerRole: "sales",
    priority: "normal",
    dueAt: new Date(ctx.now.getTime() + 86_400_000),
    personId,
    source: "system",
    notes: rec.reason,
    dedupeKey: `assistant:advice:${personId}:${rec.title}`.slice(0, 200),
  });
  return { status: "done", result: task.created ? "task_created" : "task_exists" };
}

const LOG_KIND = { enrol: "automation_enrolled", tag: "tags_applied", task: "task_created" } as const;

/** Carries out one recommendation of an advice row and records the outcome on the row. */
export async function applyRecommendation(tx: Tx, ctx: Pick<Ctx, "actor" | "now" | "requestId" | "enqueue" | "recordEvent">, input: { actionId: string; index: number }): Promise<Recommendation | null> {
  const [row] = await tx.select().from(assistantActions).where(and(eq(assistantActions.id, input.actionId), eq(assistantActions.kind, "profile_advice"))).for("update");
  if (!row?.personId) return null;
  const advice = row.detail as unknown as ProfileAdvice;
  const rec = advice.recommendations[input.index];
  if (!rec || rec.status !== "open") return rec ?? null;
  const done = await execute(tx, ctx, row.personId, rec);
  const updated: Recommendation = { ...rec, ...done };
  advice.recommendations[input.index] = updated;
  await tx.update(assistantActions).set({ detail: advice as unknown as Record<string, unknown> }).where(eq(assistantActions.id, row.id));
  await logAction(tx, { conversationId: null, personId: row.personId, kind: LOG_KIND[rec.type], detail: { ...(rec.flow ? { flow: rec.flow } : {}), ...(rec.tag ? { tags: [rec.tag] } : {}), title: rec.title, result: done.result, by: ctx.actor.kind === "staff" ? "staff" : "agent" } });
  return updated;
}

export async function latestAdvice(db: DbOrTx, personId: string): Promise<{ actionId: string; at: Date; advice: ProfileAdvice } | null> {
  const [row] = await db
    .select({ id: assistantActions.id, at: assistantActions.createdAt, detail: assistantActions.detail })
    .from(assistantActions)
    .where(and(eq(assistantActions.personId, personId), eq(assistantActions.kind, "profile_advice")))
    .orderBy(desc(assistantActions.createdAt))
    .limit(1);
  return row ? { actionId: row.id, at: row.at, advice: row.detail as unknown as ProfileAdvice } : null;
}

export async function runAdvise(ctx: JobCtx, input: { person_id: string }): Promise<void> {
  const tx = ctx.tx;
  const facts = await loadBehaviour(tx, input.person_id, ctx.now);
  if (!facts) return;
  const settings = (await getSetting(tx, "assistant")) as AssistantSettingValue;
  const flows = await flowCatalog(tx, settings.advice.flows);
  const cfg = settings.roles.analyst;
  const prompt = `FACTS\n${JSON.stringify(facts)}\n\nJOURNEYS\n${JSON.stringify(flows.map((f) => ({ slug: f.slug, name: f.name, what: f.description, marketing: f.isMarketing })))}\n\nTAGS\n${ADVICE_TAGS.join(", ")}`;
  const started = Date.now();
  const result = await chatClient().stream({ model: cfg.model, fallbackModel: cfg.fallback, system: ADVISOR_SYSTEM, messages: [{ role: "user", content: prompt }], maxTokens: cfg.max_tokens, effort: cfg.effort }, () => {});
  const parsed = Output.safeParse(parseJsonObject(result.text));
  await logModelCall(tx, {
    feature: "assistant.analyse",
    model: result.model,
    actor: ctx.actor,
    personId: input.person_id,
    prompt: `[system: assistant.advise]\n${prompt}`,
    output: result.text,
    usage: result.usage,
    costCents: costCentsOf(settings.models, result.model, result.usage),
    status: parsed.success ? "ok" : "error",
    error: parsed.success ? null : "invalid_output",
    durationMs: Date.now() - started,
  });
  const raw = parsed.success ? parsed.data : ruleAdvice(facts, flows);
  const advice: ProfileAdvice = { facts, persona: raw.persona, summary: raw.summary, recommendations: validateAdvice(raw, facts, flows), model: result.model, source: parsed.success ? "model" : "rules" };
  const [row] = await tx
    .insert(assistantActions)
    .values({ personId: input.person_id, kind: "profile_advice", detail: advice as unknown as Record<string, unknown> })
    .returning({ id: assistantActions.id });
  if (!settings.advice.auto_apply) return;
  for (let i = 0; i < advice.recommendations.length; i++) {
    if (advice.recommendations[i]!.type !== "task") await applyRecommendation(tx, ctx, { actionId: row!.id, index: i });
  }
}

/** The daily sweep: people who visited or chatted in the last day get fresh advice (at most 50). */
export async function runAdviseRecent(ctx: JobCtx): Promise<void> {
  const since = new Date(ctx.now.getTime() - 86_400_000).toISOString();
  const rows = rowsOf<{ person_id: string }>(
    await ctx.tx.execute(sql`
      select person_id from (
        select person_id from bookings where attended_at > ${since}
        union
        select person_id from assistant_conversations where analysed_at > ${since} and person_id is not null
      ) p where person_id is not null limit 50`),
  );
  const day = ctx.now.toISOString().slice(0, 10);
  for (const r of rows) await ctx.enqueue({ kind: "assistant.advise_person", payload: { person_id: r.person_id }, key: `assistant.advise:${r.person_id}:${day}` });
}
