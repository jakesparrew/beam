/**
 * `POST /api/public/assistant/chat`: one message in, the answer streamed out as NDJSON events
 * (`session`, `delta`, `card`, `relayed`, `done`, `error`). In order:
 *  1. switched on, same origin, a customer session for the coach;
 *  2. visitor limits (per minute, per day, per IP) before anything is stored, so a flood writes
 *     nothing; the spend caps and the per-conversation cap answer with the contact form instead;
 *  3. the message is stored; a conversation a colleague took over gets no AI answer;
 *  4. the model streams; tools run; the answer, its cost, the tool trace, the `ai_requests` row,
 *     the agent log, a handoff task and the delayed analysis job are written after the stream.
 */
import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { LOCALES, type Locale } from "@beam/core/i18n";
import { assistantConversations, assistantMessages, assistantVisitors, type AssistantCard } from "@beam/db/schema";
import { eq, sql, type Actor, type Ctx, type Db, type Tx } from "@/lib/ctx";
import { reportError } from "@/lib/logger";
import { rateLimit } from "@/lib/rate-limit";
import { getSetting } from "@/lib/settings";
import { getNextBooking, getPersonBookingSummary } from "@/modules/booking/api";
import { createTask, getCurrentConsents, getPerson } from "@/modules/crm/api";
import { getPersonCreditSummary } from "@/modules/credits/api";
import type { AssistantSettingValue } from "../config";
import { runTurn, type TurnResult } from "./agent";
import { ZERO_USAGE } from "./cost";
import { fail, inTx, NO_STORE, openRequest, parseBody, visitorToken } from "./http";
import { contextText, knowledgeText, systemPrompt } from "./prompt";
import { assistantSpend, createVisitor, findVisitor, historyOf, logAction, logModelCall, openConversation, type ConversationRow, type VisitorRow } from "./store";
import type { ToolEffects } from "./tools";

const Body = z.object({
  message: z.string().trim().min(1).max(2000),
  conversationId: z.uuid().nullable().optional(),
  locale: z.enum(LOCALES),
  role: z.enum(["guide", "coach"]).default("guide"),
  page: z.string().max(300).nullable().optional(),
  origin: z.record(z.string().max(40), z.string().max(200)).nullable().optional(),
  website: z.string().max(200).optional(),
});

type Canned = "limited" | "busy" | "error";
const CANNED: Record<Canned, Record<Locale, string>> = {
  limited: {
    "nl-BE": "Ik kan in dit gesprek niet verder antwoorden. Laat je gegevens achter, dan neemt een collega van BEAM contact met je op.",
    "fr-BE": "Je ne peux plus répondre dans cette conversation. Laissez vos coordonnées et un collègue de BEAM vous recontactera.",
    en: "I can't answer any further in this conversation. Leave your details and a BEAM colleague will get back to you.",
  },
  busy: {
    "nl-BE": "Ik ben even niet beschikbaar. Laat je gegevens achter, dan antwoordt een collega van BEAM je persoonlijk.",
    "fr-BE": "Je ne suis pas disponible pour le moment. Laissez vos coordonnées et un collègue de BEAM vous répondra personnellement.",
    en: "I'm not available right now. Leave your details and a BEAM colleague will answer you personally.",
  },
  error: {
    "nl-BE": "Sorry, er liep iets mis bij het antwoorden. Probeer het zo meteen opnieuw, of laat je gegevens achter voor een collega.",
    "fr-BE": "Désolé, un problème est survenu. Réessayez dans un instant ou laissez vos coordonnées pour un collègue.",
    en: "Sorry, something went wrong while answering. Try again in a moment, or leave your details for a colleague.",
  },
};

const ANALYSE_AFTER_MS = 10 * 60_000;

type Plan = {
  token: string | null;
  visitor: VisitorRow;
  conversation: ConversationRow;
  blocked: Canned | "relayed" | null;
  cannedMessageId: string | null;
};

const ipKey = (ip: string) => createHash("sha256").update(`assistant:${ip}`).digest("hex").slice(0, 24);

async function insertAssistantMessage(tx: Tx, conversationId: string, body: string, kind: string, cards: AssistantCard[]): Promise<string> {
  const [row] = await tx.insert(assistantMessages).values({ conversationId, author: "assistant", body, kind, cards }).returning({ id: assistantMessages.id });
  return row!.id;
}

async function admit(tx: Tx, input: { req: Request; body: z.infer<typeof Body>; settings: AssistantSettingValue; personId: string | null; ip: string }): Promise<Plan> {
  const { body, settings } = input;
  let token: string | null = null;
  let visitor = await findVisitor(tx, visitorToken(input.req));
  if (!visitor) {
    const made = await createVisitor(tx, { locale: body.locale, page: body.page ?? null, origin: body.origin ?? null, personId: input.personId });
    visitor = made.visitor;
    token = made.token;
  } else {
    const patch: Partial<VisitorRow> = { lastSeenAt: new Date(), locale: body.locale };
    if (input.personId && visitor.personId !== input.personId) patch.personId = input.personId;
    await tx.update(assistantVisitors).set(patch).where(eq(assistantVisitors.id, visitor.id));
    visitor = { ...visitor, ...patch };
  }

  // A flood writes nothing: the visitor limits are checked before the message is stored.
  const limits = [
    { key: `assistant:v:${visitor.id}:m`, limit: settings.limits.per_minute, windowSeconds: 60 },
    { key: `assistant:v:${visitor.id}:d`, limit: settings.limits.per_day, windowSeconds: 86_400 },
    { key: `assistant:ip:${ipKey(input.ip)}:m`, limit: settings.limits.per_ip_minute, windowSeconds: 60 },
  ];
  let limited = false;
  for (const l of limits) if (!(await rateLimit(tx, l)).ok) limited = true;

  const conversation = await openConversation(tx, { visitor, conversationId: body.conversationId ?? null, role: body.role, locale: body.locale, page: body.page ?? null, personId: input.personId });
  if (limited) {
    const cannedMessageId = await insertAssistantMessage(tx, conversation.id, CANNED.limited[body.locale], "limited", [{ type: "contact" }]);
    return { token, visitor, conversation, blocked: "limited", cannedMessageId };
  }

  await tx.insert(assistantMessages).values({ conversationId: conversation.id, author: "visitor", body: body.message });
  const [updated] = await tx
    .update(assistantConversations)
    .set({ messageCount: sql`${assistantConversations.messageCount} + 1`, lastMessageAt: new Date(), updatedAt: new Date(), ...(conversation.personId ? {} : visitor.personId ? { personId: visitor.personId } : {}) })
    .where(eq(assistantConversations.id, conversation.id))
    .returning();
  const conv = updated!;

  if (conv.takenOverByUserId) return { token, visitor, conversation: conv, blocked: "relayed", cannedMessageId: null };

  const spend = await assistantSpend(tx);
  const busy = spend.todayCents >= settings.daily_budget_cents || spend.monthCents >= settings.monthly_budget_cents;
  const tooLong = conv.messageCount > settings.limits.per_conversation;
  if (busy || tooLong) {
    const kind: Canned = busy ? "busy" : "limited";
    const cannedMessageId = await insertAssistantMessage(tx, conv.id, CANNED[kind][body.locale], "limited", [{ type: "contact" }]);
    if (busy) await logAction(tx, { conversationId: conv.id, personId: conv.personId, kind: "budget_reached", detail: { today_cents: spend.todayCents, month_cents: spend.monthCents } });
    return { token, visitor, conversation: conv, blocked: kind, cannedMessageId };
  }
  return { token, visitor, conversation: conv, blocked: null, cannedMessageId: null };
}

/** A few lines about the customer for the coach (no sensitive data). */
async function coachProfile(db: Db, personId: string, now: Date): Promise<string> {
  const [person, credits, next, summary] = await Promise.all([
    getPerson(db, personId),
    getPersonCreditSummary(db, personId).catch(() => null),
    getNextBooking(db, personId).catch(() => null),
    getPersonBookingSummary(db, personId).catch(() => null),
  ]);
  const lines = [
    `First name: ${person?.firstName ?? "unknown"}. Status: ${person?.status ?? "unknown"}. Language: ${person?.locale ?? "nl-BE"}.`,
    summary ? `Visits so far: ${summary.attended}; nights booked: ${summary.nightsBooked}; last visit: ${summary.lastVisitAt?.toISOString().slice(0, 10) ?? "none"}.` : "",
    next ? `Next booking: ${next.kind} on ${next.startsAt.toISOString()} (UTC).` : "No upcoming booking.",
    credits ? `Credits and membership (JSON): ${JSON.stringify(credits).slice(0, 1200)}` : "",
    `Today: ${now.toISOString().slice(0, 10)}.`,
  ];
  return lines.filter(Boolean).join("\n");
}

async function checkinsState(db: Db, personId: string): Promise<"allowed" | "no_consent" | "unavailable"> {
  const [consents, ai] = await Promise.all([getCurrentConsents(db, personId), getSetting(db, "ai")]);
  if (consents.ai_processing?.status !== "granted") return "no_consent";
  return (ai as { sensitive_enabled?: boolean }).sensitive_enabled === true ? "allowed" : "unavailable";
}

async function persistTurn(tx: Tx, ctx: Ctx, input: { plan: Plan; result: TurnResult; effects: ToolEffects; role: "guide" | "coach"; actor: Actor; prompt: string }): Promise<string> {
  const { plan, result, effects } = input;
  const conv = plan.conversation;
  const personId = conv.personId ?? plan.visitor.personId;
  const kind = effects.handoff ? "handoff" : effects.unanswered.length ? "unknown" : "answered";
  const aiRequestId = await logModelCall(tx, {
    feature: input.role === "coach" ? "assistant.coach" : "assistant.guide",
    model: result.model,
    actor: input.actor,
    personId,
    prompt: input.prompt,
    output: result.text,
    usage: result.usage,
    costCents: result.costCents,
    status: "ok",
    durationMs: result.durationMs,
  });
  const [msg] = await tx
    .insert(assistantMessages)
    .values({
      conversationId: conv.id,
      author: "assistant",
      body: result.text.slice(0, 8000) || "…",
      kind,
      cards: result.cards,
      tools: result.tools,
      model: result.model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cacheReadTokens: result.usage.cacheReadTokens,
      cacheWriteTokens: result.usage.cacheWriteTokens,
      costCents: String(result.costCents),
      durationMs: result.durationMs,
    })
    .returning({ id: assistantMessages.id });
  await tx
    .update(assistantConversations)
    .set({
      costCents: sql`${assistantConversations.costCents} + ${String(result.costCents)}::numeric`,
      unansweredCount: sql`${assistantConversations.unansweredCount} + ${effects.unanswered.length}`,
      ...(effects.contactOffered && !conv.contactOfferedAt ? { contactOfferedAt: new Date() } : {}),
      ...(effects.handoff ? { status: "handoff" as const } : {}),
      updatedAt: new Date(),
    })
    .where(eq(assistantConversations.id, conv.id));

  for (const question of effects.unanswered) await logAction(tx, { conversationId: conv.id, personId, kind: "unanswered", detail: { question, ai_request_id: aiRequestId } });
  if (effects.contactOffered) await logAction(tx, { conversationId: conv.id, personId, kind: "contact_offered" });
  if (effects.handoff) {
    await logAction(tx, { conversationId: conv.id, personId, kind: "handoff_opened", detail: { reason: effects.handoff } });
    if (personId) {
      await ctx.recordEvent({ kind: "assistant.handoff_requested", personId, data: { conversation_id: conv.id, reason: effects.handoff }, dedupeKey: `assistant:handoff:${conv.id}` });
      const task = await createTask(tx, ctx, {
        title: `Chat overnemen: ${effects.handoff}`.slice(0, 200),
        kind: "follow_up",
        priority: "high",
        dueAt: new Date(),
        personId,
        source: "system",
        ref: { type: "assistant_conversation", id: conv.id },
        dedupeKey: `assistant:handoff:${conv.id}`,
      });
      if (task.created) await logAction(tx, { conversationId: conv.id, personId, kind: "task_created", detail: { task_id: task.taskId, reason: effects.handoff } });
    }
  }
  const analyseNow = !!effects.handoff;
  await ctx.enqueue({
    kind: "assistant.analyse_conversation",
    payload: { conversation_id: conv.id },
    key: `assistant.analyse:${conv.id}:${conv.messageCount}${analyseNow ? ":now" : ""}`,
    ...(analyseNow ? {} : { runAt: new Date(Date.now() + ANALYSE_AFTER_MS) }),
  });
  return msg!.id;
}

export async function handleChat(req: Request): Promise<Response> {
  const open = await openRequest(req);
  if (!open.ok) return open.response;
  const body = await parseBody(req, Body);
  if (!body) return fail(400, "validation");
  const { db, actor, ip } = open;
  const settings = (await getSetting(db, "assistant")) as AssistantSettingValue;
  if (!settings.enabled || (body.role === "coach" && !settings.coach_enabled)) return fail(403, "disabled");
  if (body.role === "coach" && actor.kind !== "customer") return fail(401, "unauthorized");
  const sessionPerson = actor.kind === "customer" ? actor.personId : null;
  const encoder = new TextEncoder();

  // A bot that filled the hidden field gets an ordinary-looking empty answer and nothing is stored.
  if (body.website) {
    return new Response(encoder.encode(`${JSON.stringify({ t: "done", messageId: null })}\n`), { headers: { "content-type": "application/x-ndjson; charset=utf-8", ...NO_STORE } });
  }

  let plan: Plan;
  try {
    plan = await inTx(db, actor, ip, (tx) => admit(tx, { req, body, settings, personId: sessionPerson, ip }));
  } catch (error) {
    reportError(error, { tags: { module: "assistant", route: "chat" } });
    return fail(500, "internal");
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: Record<string, unknown>) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      send({ t: "session", conversationId: plan.conversation.id, ...(plan.token ? { token: plan.token } : {}) });

      if (plan.blocked) {
        if (plan.blocked === "relayed") send({ t: "relayed" });
        else {
          send({ t: "delta", text: CANNED[plan.blocked][body.locale] });
          send({ t: "card", card: { type: "contact" } });
        }
        send({ t: "done", messageId: plan.cannedMessageId });
        controller.close();
        return;
      }

      const personId = plan.conversation.personId ?? plan.visitor.personId;
      const contactKnown = !!personId;
      const effects: ToolEffects = { contactOffered: false, handoff: null, unanswered: [], bookingLinks: 0, shownLinks: [] };
      let prompt = `[user]\n${body.message}`;
      try {
        const now = new Date();
        const [knowledge, history, profile, allowed] = await Promise.all([
          knowledgeText(db, body.locale),
          historyOf(db, plan.conversation.id),
          body.role === "coach" && sessionPerson ? coachProfile(db, sessionPerson, now) : Promise.resolve(null),
          body.role === "coach" && sessionPerson ? checkinsState(db, sessionPerson) : Promise.resolve("no_consent" as const),
        ]);
        const system = systemPrompt(body.role, body.locale, settings.tone, knowledge);
        const context = await contextText(db, {
          now,
          locale: body.locale,
          page: body.page ?? null,
          messageCount: plan.conversation.messageCount,
          contactKnown,
          contactOffered: !!plan.conversation.contactOfferedAt,
          contactAfterMessages: settings.contact_after_messages,
          profile,
        });
        prompt = `[system: assistant.${body.role} ${body.locale}, ${system.length} chars, cached]\n[context]\n${context}\n\n${history.map((m) => `[${m.role}]\n${typeof m.content === "string" ? m.content : "(tool round)"}`).join("\n\n")}`;
        const result = await runTurn({
          settings,
          role: body.role,
          locale: body.locale,
          system,
          context,
          history,
          toolCtx: { db, locale: body.locale, role: body.role, personId, contactKnown, checkins: allowed, now, effects },
          emit: (event) => send(event),
          signal: req.signal,
        });
        // The visitor already has the answer: a failed write is reported, never shown as an error.
        let messageId: string | null = null;
        try {
          messageId = await inTx(db, actor, ip, (tx, ctx) => persistTurn(tx, ctx, { plan, result, effects, role: body.role, actor, prompt }));
        } catch (error) {
          reportError(error, { tags: { module: "assistant", route: "chat", stage: "persist" } });
        }
        send({ t: "done", messageId });
      } catch (error) {
        reportError(error, { tags: { module: "assistant", route: "chat" } });
        const message = error instanceof Error ? error.message : String(error);
        const messageId = await inTx(db, actor, ip, async (tx) => {
          await logModelCall(tx, {
            feature: body.role === "coach" ? "assistant.coach" : "assistant.guide",
            model: settings.roles[body.role].model,
            actor,
            personId,
            prompt,
            output: null,
            usage: ZERO_USAGE,
            costCents: 0,
            status: "error",
            error: message.slice(0, 1000),
            durationMs: 0,
          });
          return insertAssistantMessage(tx, plan.conversation.id, CANNED.error[body.locale], "error", [{ type: "contact" }]);
        }).catch(() => null);
        send({ t: "error" });
        send({ t: "delta", text: CANNED.error[body.locale] });
        send({ t: "card", card: { type: "contact" } });
        send({ t: "done", messageId });
      }
      controller.close();
    },
  });

  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "x-accel-buffering": "no", ...NO_STORE } });
}
