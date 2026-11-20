/**
 * Reads of the assistant's back-office (`/admin/assistant/*`). Internal to the module; other
 * modules read through `api.ts`.
 */
import "server-only";
import { assistantActions, assistantConversations, assistantEvalCases, assistantEvalRuns, assistantMessages, persons, users } from "@beam/db/schema";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, sql, type DbOrTx } from "@/lib/ctx";
import { getSetting } from "@/lib/settings";
import { rowsOf } from "@/lib/sensitive";
import type { AssistantSettingValue } from "./config";
import { assistantSpend } from "./server/store";

const DAY = 86_400_000;

export type Overview = {
  today: number;
  week: number;
  coachWeek: number;
  answeredShare: number | null;
  leadsWeek: number;
  qualifiedWeek: number;
  openHandoffs: number;
  bookingsAfterChat: number;
  spend: { todayCents: number; monthCents: number; dailyCap: number; monthlyCap: number };
  avgCostCents: number | null;
  unanswered: { question: string; at: Date; conversationId: string | null }[];
  actions: { id: string; kind: string; detail: Record<string, unknown>; at: Date; conversationId: string | null; personId: string | null; personName: string | null }[];
  enabled: boolean;
  models: { guide: string; coach: string; analyst: string };
};

export async function getOverview(db: DbOrTx, now = new Date()): Promise<Overview> {
  const settings = (await getSetting(db, "assistant")) as AssistantSettingValue;
  const dayStart = new Date(now.getTime() - DAY);
  const weekStart = new Date(now.getTime() - 7 * DAY);
  const [counts] = rowsOf<{ today: number; week: number; coach_week: number; answered: number; assistant_msgs: number; open_handoffs: number; avg_cost: number | null }>(
    await db.execute(sql`
      select
        count(*) filter (where c.created_at >= ${dayStart.toISOString()} and c.role = 'guide')::int as today,
        count(*) filter (where c.created_at >= ${weekStart.toISOString()} and c.role = 'guide')::int as week,
        count(*) filter (where c.created_at >= ${weekStart.toISOString()} and c.role = 'coach')::int as coach_week,
        (select count(*) from assistant_messages m join assistant_conversations c2 on c2.id = m.conversation_id where m.author = 'assistant' and m.kind = 'answered' and m.created_at >= ${weekStart.toISOString()})::int as answered,
        (select count(*) from assistant_messages m where m.author = 'assistant' and m.kind in ('answered','unknown','handoff') and m.created_at >= ${weekStart.toISOString()})::int as assistant_msgs,
        (select count(*) from assistant_conversations h where h.status = 'handoff' and h.taken_over_by_user_id is null)::int as open_handoffs,
        (select avg(cost_cents)::float8 from assistant_conversations a where a.created_at >= ${weekStart.toISOString()} and a.message_count > 0) as avg_cost
      from assistant_conversations c
      where c.created_at >= ${weekStart.toISOString()}`),
  );
  const [leads] = rowsOf<{ leads: number; qualified: number }>(
    await db.execute(sql`
      select count(*) filter (where kind = 'contact_saved')::int as leads, count(*) filter (where kind = 'lead_qualified')::int as qualified
      from assistant_actions where created_at >= ${weekStart.toISOString()}`),
  );
  const [booked] = rowsOf<{ n: number }>(
    await db.execute(sql`
      select count(distinct b.id)::int as n
      from bookings b
      join assistant_conversations c on c.person_id = b.person_id
      where b.created_at >= c.created_at and b.created_at < c.created_at + interval '30 days'
        and b.created_at >= ${new Date(now.getTime() - 30 * DAY).toISOString()}`),
  );
  const unanswered = await db
    .select({ detail: assistantActions.detail, at: assistantActions.createdAt, conversationId: assistantActions.conversationId })
    .from(assistantActions)
    .where(and(eq(assistantActions.kind, "unanswered"), gte(assistantActions.createdAt, new Date(now.getTime() - 30 * DAY))))
    .orderBy(desc(assistantActions.createdAt))
    .limit(12);
  const actions = await db
    .select({ id: assistantActions.id, kind: assistantActions.kind, detail: assistantActions.detail, at: assistantActions.createdAt, conversationId: assistantActions.conversationId, personId: assistantActions.personId, first: persons.firstName, last: persons.lastName })
    .from(assistantActions)
    .leftJoin(persons, eq(persons.id, assistantActions.personId))
    .orderBy(desc(assistantActions.createdAt))
    .limit(25);
  const spend = await assistantSpend(db);
  return {
    today: counts?.today ?? 0,
    week: counts?.week ?? 0,
    coachWeek: counts?.coach_week ?? 0,
    answeredShare: counts?.assistant_msgs ? (counts.answered ?? 0) / counts.assistant_msgs : null,
    leadsWeek: leads?.leads ?? 0,
    qualifiedWeek: leads?.qualified ?? 0,
    openHandoffs: counts?.open_handoffs ?? 0,
    bookingsAfterChat: booked?.n ?? 0,
    spend: { ...spend, dailyCap: settings.daily_budget_cents, monthlyCap: settings.monthly_budget_cents },
    avgCostCents: counts?.avg_cost ?? null,
    unanswered: unanswered.map((u) => ({ question: String((u.detail as { question?: string }).question ?? ""), at: u.at, conversationId: u.conversationId })),
    actions: actions.map((a) => ({ id: a.id, kind: a.kind, detail: a.detail, at: a.at, conversationId: a.conversationId, personId: a.personId, personName: [a.first, a.last].filter(Boolean).join(" ") || null })),
    enabled: settings.enabled,
    models: { guide: settings.roles.guide.model, coach: settings.roles.coach.model, analyst: settings.roles.analyst.model },
  };
}

export const CONVERSATION_FILTERS = ["all", "handoff", "unknown", "leads", "coach"] as const;
export type ConversationFilter = (typeof CONVERSATION_FILTERS)[number];

export type ConversationListRow = {
  id: string;
  role: "guide" | "coach";
  status: "open" | "handoff" | "closed";
  personId: string | null;
  personName: string | null;
  page: string | null;
  messageCount: number;
  unansweredCount: number;
  score: number | null;
  intent: string | null;
  summary: string | null;
  lastMessageAt: Date;
  lastText: string | null;
  costCents: number;
  takenOver: boolean;
};

export async function listConversations(db: DbOrTx, filter: ConversationFilter, limit = 60): Promise<ConversationListRow[]> {
  const c = assistantConversations;
  const where =
    filter === "handoff"
      ? eq(c.status, "handoff")
      : filter === "unknown"
        ? sql`${c.unansweredCount} > 0`
        : filter === "leads"
          ? and(isNotNull(c.personId), eq(c.role, "guide"))
          : filter === "coach"
            ? eq(c.role, "coach")
            : undefined;
  const rows = await db
    .select({ c, first: persons.firstName, last: persons.lastName })
    .from(c)
    .leftJoin(persons, eq(persons.id, c.personId))
    .where(and(where, sql`${c.messageCount} > 0`))
    .orderBy(desc(c.lastMessageAt))
    .limit(limit);
  const ids = rows.map((r) => r.c.id);
  const last = ids.length
    ? rowsOf<{ conversation_id: string; body: string }>(
        await db.execute(sql`select distinct on (conversation_id) conversation_id, body from assistant_messages where conversation_id in ${sql`(${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`} order by conversation_id, created_at desc`),
      )
    : [];
  const lastOf = new Map(last.map((l) => [l.conversation_id, l.body]));
  return rows.map(({ c: r, first, last: lastName }) => ({
    id: r.id,
    role: r.role,
    status: r.status,
    personId: r.personId,
    personName: [first, lastName].filter(Boolean).join(" ") || null,
    page: r.page,
    messageCount: r.messageCount,
    unansweredCount: r.unansweredCount,
    score: r.score,
    intent: r.analysis?.intent ?? null,
    summary: r.analysis?.summary ?? null,
    lastMessageAt: r.lastMessageAt,
    lastText: lastOf.get(r.id) ?? null,
    costCents: Number(r.costCents),
    takenOver: !!r.takenOverByUserId,
  }));
}

export async function getConversation(db: DbOrTx, id: string) {
  const [row] = await db
    .select({ c: assistantConversations, first: persons.firstName, last: persons.lastName, email: persons.email, takenBy: users.name })
    .from(assistantConversations)
    .leftJoin(persons, eq(persons.id, assistantConversations.personId))
    .leftJoin(users, eq(users.id, assistantConversations.takenOverByUserId))
    .where(eq(assistantConversations.id, id));
  if (!row) return null;
  const messages = await db
    .select({ m: assistantMessages, staffName: users.name })
    .from(assistantMessages)
    .leftJoin(users, eq(users.id, assistantMessages.staffUserId))
    .where(eq(assistantMessages.conversationId, id))
    .orderBy(asc(assistantMessages.createdAt), asc(assistantMessages.id));
  const actions = await db.select().from(assistantActions).where(eq(assistantActions.conversationId, id)).orderBy(asc(assistantActions.createdAt));
  return {
    conversation: row.c,
    person: row.c.personId ? { id: row.c.personId, name: [row.first, row.last].filter(Boolean).join(" ") || null, email: row.email } : null,
    takenOverBy: row.takenBy,
    messages: messages.map((r) => ({ ...r.m, staffName: r.staffName })),
    actions,
  };
}

export type EvalSummary = {
  cases: { id: string; question: string; expectation: string; locale: string }[];
  runs: { runKey: string; model: string; at: Date; total: number; passed: number; judged: number; avgCostCents: number; avgMs: number }[];
  latest: Map<string, { model: string; answer: string; passed: number | null; verdict: string | null; costCents: number; ms: number }[]>;
};

export async function getEvalSummary(db: DbOrTx): Promise<EvalSummary> {
  const cases = await db.select({ id: assistantEvalCases.id, question: assistantEvalCases.question, expectation: assistantEvalCases.expectation, locale: assistantEvalCases.locale }).from(assistantEvalCases).orderBy(asc(assistantEvalCases.createdAt));
  const runs = rowsOf<{ run_key: string; model: string; at: Date | string; total: number; passed: number; judged: number; avg_cost: number; avg_ms: number }>(
    await db.execute(sql`
      select run_key, model, max(created_at) as at, count(*)::int as total, count(*) filter (where passed = 1)::int as passed,
             count(passed)::int as judged, coalesce(avg(cost_cents), 0)::float8 as avg_cost, coalesce(avg(duration_ms), 0)::float8 as avg_ms
      from assistant_eval_runs group by run_key, model order by max(created_at) desc limit 12`),
  );
  const keys = runs.slice(0, 3).map((r) => r.run_key);
  const latestRows = keys.length
    ? await db.select().from(assistantEvalRuns).where(inArray(assistantEvalRuns.runKey, keys)).orderBy(desc(assistantEvalRuns.createdAt))
    : [];
  const latest = new Map<string, { model: string; answer: string; passed: number | null; verdict: string | null; costCents: number; ms: number }[]>();
  for (const r of latestRows) {
    const list = latest.get(r.caseId) ?? [];
    if (!list.some((x) => x.model === r.model)) list.push({ model: r.model, answer: r.answer, passed: r.passed, verdict: r.verdict, costCents: Number(r.costCents), ms: r.durationMs });
    latest.set(r.caseId, list);
  }
  return {
    cases,
    runs: runs.map((r) => ({ runKey: r.run_key, model: r.model, at: new Date(r.at), total: r.total, passed: r.passed, judged: r.judged, avgCostCents: r.avg_cost, avgMs: r.avg_ms })),
    latest,
  };
}

/** Conversations still waiting for a colleague (the admin badge). */
export async function countOpenHandoffs(db: DbOrTx): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(assistantConversations)
    .where(and(eq(assistantConversations.status, "handoff"), isNull(assistantConversations.takenOverByUserId)));
  return Number(row?.n ?? 0);
}
