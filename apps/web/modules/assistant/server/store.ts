/**
 * The assistant's rows: visitors (by token hash), conversations, messages, the agent log, and the
 * spend the caps are checked against (every model call of the assistant is an `ai_requests` row
 * with a feature `assistant.*`, so the existing AI usage screens and retention cover it).
 */
import "server-only";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ChatMessage, ChatUsage } from "@beam/integrations/anthropic";
import { aiRequests, assistantActions, assistantConversations, assistantMessages, assistantVisitors } from "@beam/db/schema";
import { actorJson, and, asc, desc, eq, sql, type Actor, type DbOrTx } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";

export const newToken = () => `bv_${randomBytes(32).toString("base64url")}`;
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const TOKEN = /^bv_[A-Za-z0-9_-]{43}$/;

export type VisitorRow = typeof assistantVisitors.$inferSelect;
export type ConversationRow = typeof assistantConversations.$inferSelect;

export async function findVisitor(db: DbOrTx, token: string | null): Promise<VisitorRow | null> {
  if (!token || !TOKEN.test(token)) return null;
  const [row] = await db.select().from(assistantVisitors).where(eq(assistantVisitors.tokenHash, hashToken(token)));
  return row ?? null;
}

export async function createVisitor(db: DbOrTx, input: { locale: string; page: string | null; origin: Record<string, string> | null; personId: string | null }): Promise<{ visitor: VisitorRow; token: string }> {
  const token = newToken();
  const [visitor] = await db
    .insert(assistantVisitors)
    .values({ tokenHash: hashToken(token), locale: input.locale, firstPage: input.page, origin: input.origin, personId: input.personId })
    .returning();
  return { visitor: visitor!, token };
}

/** The visitor's open conversation of this role (the one asked for, if it is theirs), else a new one. */
export async function openConversation(
  db: DbOrTx,
  input: { visitor: VisitorRow; conversationId: string | null; role: "guide" | "coach"; locale: string; page: string | null; personId: string | null },
): Promise<ConversationRow> {
  if (input.conversationId) {
    const [found] = await db
      .select()
      .from(assistantConversations)
      .where(and(eq(assistantConversations.id, input.conversationId), eq(assistantConversations.visitorId, input.visitor.id), eq(assistantConversations.role, input.role)));
    if (found && found.status !== "closed") return found;
  }
  const [created] = await db
    .insert(assistantConversations)
    .values({ visitorId: input.visitor.id, role: input.role, locale: input.locale, page: input.page, personId: input.personId ?? input.visitor.personId })
    .returning();
  return created!;
}

/**
 * The last `limit` messages as model history: visitor -> user, assistant and staff -> assistant
 * (staff lines marked), merged so roles alternate and the history starts with the person.
 */
export async function historyOf(db: DbOrTx, conversationId: string, limit = 12): Promise<ChatMessage[]> {
  const rows = await db
    .select({ author: assistantMessages.author, body: assistantMessages.body, tools: assistantMessages.tools })
    .from(assistantMessages)
    .where(eq(assistantMessages.conversationId, conversationId))
    .orderBy(desc(assistantMessages.createdAt), desc(assistantMessages.id))
    .limit(limit);
  const out: { role: "user" | "assistant"; content: string }[] = [];
  for (const r of rows.reverse()) {
    const role = r.author === "visitor" ? "user" : "assistant";
    // Earlier answers rest on live tool results that are not replayed as tool rounds: a short note
    // keeps the model from doubting its own earlier facts (and keeps the replay cheap).
    const facts = r.author === "assistant" && r.tools?.length ? `\n\n[Live data behind this answer: ${r.tools.map(toolFact).join(" | ")}]` : "";
    const content = r.author === "staff" ? `(BEAM colleague) ${r.body}` : `${r.body}${facts}`;
    const last = out.at(-1);
    if (last && last.role === role) last.content = `${last.content}\n\n${content}`;
    else out.push({ role, content });
  }
  while (out.length && out[0]!.role !== "user") out.shift();
  return out;
}

type SessionFact = { when?: string; kind?: string; free_places?: number; price_eur?: number | null };

/** One tool result in a line: sessions compactly (every one of them), anything else as short JSON. */
export function toolFact(t: { name: string; output: unknown }): string {
  const out = t.output as { sessions?: SessionFact[] } | null;
  if (t.name === "get_availability" && Array.isArray(out?.sessions)) {
    return `get_availability: ${out.sessions.length ? out.sessions.map((s) => `${s.when} ${s.kind} ${s.free_places} free${s.price_eur != null ? ` €${s.price_eur}` : ""}`).join("; ") : "no free places"}`;
  }
  return `${t.name} ${JSON.stringify(t.output).slice(0, 400)}`;
}

/** Brussels-day and -month spend of the assistant, in cents. */
export async function assistantSpend(db: DbOrTx): Promise<{ todayCents: number; monthCents: number }> {
  const rows = rowsOf<{ today: number | string | null; month: number | string | null }>(
    await db.execute(sql`
      select
        coalesce(sum(cost_cents) filter (where created_at >= (date_trunc('day', now() at time zone 'Europe/Brussels') at time zone 'Europe/Brussels')), 0)::float8 as today,
        coalesce(sum(cost_cents), 0)::float8 as month
      from ai_requests
      where feature like 'assistant.%'
        and created_at >= (date_trunc('month', now() at time zone 'Europe/Brussels') at time zone 'Europe/Brussels')`),
  );
  return { todayCents: Number(rows[0]?.today ?? 0), monthCents: Number(rows[0]?.month ?? 0) };
}

export async function logModelCall(
  db: DbOrTx,
  input: {
    feature: "assistant.guide" | "assistant.coach" | "assistant.analyse" | "assistant.eval";
    model: string;
    actor: Actor;
    personId: string | null;
    prompt: string;
    output: string | null;
    usage: ChatUsage;
    costCents: number;
    status: "ok" | "error";
    error?: string | null;
    durationMs: number;
  },
): Promise<string> {
  const id = randomUUID();
  await db.insert(aiRequests).values({
    id,
    feature: input.feature,
    model: input.model,
    actor: actorJson(input.actor),
    personId: input.personId,
    fieldsSent: [],
    prompt: input.prompt.slice(0, 20_000),
    output: input.output?.slice(0, 20_000) ?? null,
    inputTokens: input.usage.inputTokens + input.usage.cacheWriteTokens,
    outputTokens: input.usage.outputTokens,
    cacheReadTokens: input.usage.cacheReadTokens,
    costCents: String(input.costCents),
    status: input.status,
    error: input.error ?? null,
    durationMs: input.durationMs,
  });
  return id;
}

export async function logAction(db: DbOrTx, input: { conversationId: string | null; personId: string | null; kind: string; detail?: Record<string, unknown> }): Promise<void> {
  await db.insert(assistantActions).values({ conversationId: input.conversationId, personId: input.personId, kind: input.kind, detail: input.detail ?? {} });
}

export type PublicMessage = { id: string; author: "visitor" | "assistant" | "staff"; body: string; cards: unknown[]; createdAt: string; rating: number | null };

export async function publicMessages(db: DbOrTx, conversationId: string, after?: Date): Promise<PublicMessage[]> {
  const rows = await db
    .select({ id: assistantMessages.id, author: assistantMessages.author, body: assistantMessages.body, cards: assistantMessages.cards, createdAt: assistantMessages.createdAt, rating: assistantMessages.rating })
    .from(assistantMessages)
    .where(and(eq(assistantMessages.conversationId, conversationId), after ? sql`${assistantMessages.createdAt} > ${after.toISOString()}` : undefined))
    .orderBy(asc(assistantMessages.createdAt), asc(assistantMessages.id))
    .limit(100);
  return rows.map((r) => ({ ...r, cards: r.cards ?? [], createdAt: r.createdAt.toISOString() }));
}
