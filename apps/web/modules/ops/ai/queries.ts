/**
 * ops queries, area `ai` (ops spec 4.2, R4): the user's natural-language questions and the
 * weekly management summaries. Each takes an `OpsReadCtx` (pages build it with
 * `staffReadCtx()`), checks its permissions, selects named columns and pages at 50 rows.
 *
 * A question is shown only to the user who asked it (`ai.use` and `reports.read`). Its rows are
 * never stored in `nl_questions`; `getQuestion` reads them back from the result of its
 * `ai.answer_question` job while that job row exists (platform prunes old jobs), and resolves the
 * `person_id` link names on the server.
 */
import { jobs, managementSummaries, nlQuestions } from "@beam/db/schema";
import type { Locale } from "@beam/core/i18n";
import { and, desc, eq, NotFoundError, type Actor } from "@/lib/ctx";
import { requireAny, type OpsReadCtx } from "../reports/registry";
import { personLinks, type NlStatus } from "./ask";

export const QUESTION_PAGE_SIZE = 50;

/** The six example questions of blueprint 40 (catalogue keys `ops.ask.example.<key>`). */
export const ASK_EXAMPLES = ["top_revenue", "best_campaign", "no_repurchase", "month_change", "b2b_attention", "contact_week"] as const;
export type AskExample = (typeof ASK_EXAMPLES)[number];

export type QuestionSummary = { id: string; question: string; status: NlStatus; rowCount: number | null; createdAt: Date };
export type QuestionDetail = QuestionSummary & {
  sql: string | null;
  explanation: string | null;
  columns: string[];
  /** Null once the job row holding them is pruned. */
  rows: unknown[][] | null;
  personNames: Record<string, string>;
};

export type WeeklySummaryView = {
  weekStartOn: string;
  status: "pending" | "ready" | "failed" | "skipped_budget";
  /** The text in the requested locale, else English (`englishOnly`), else null. */
  text: string | null;
  englishOnly: boolean;
  updatedAt: Date;
};

const userIdOf = (actor: Actor): string | null => (actor.kind === "staff" ? actor.userId : null);

function requireAsk(ctx: OpsReadCtx): string {
  requireAny(ctx, "reports.read");
  requireAny(ctx, "ai.use");
  const me = userIdOf(ctx.actor);
  if (!me) throw new NotFoundError("nl_question");
  return me;
}

/** The user's own questions, newest first (50 per page). */
export async function listQuestions(ctx: OpsReadCtx, input: { page?: number } = {}): Promise<QuestionSummary[]> {
  const me = requireAsk(ctx);
  const page = Math.max(1, Math.floor(input.page ?? 1));
  return ctx.tx
    .select({ id: nlQuestions.id, question: nlQuestions.question, status: nlQuestions.status, rowCount: nlQuestions.rowCount, createdAt: nlQuestions.createdAt })
    .from(nlQuestions)
    .where(eq(nlQuestions.userId, me))
    .orderBy(desc(nlQuestions.createdAt), desc(nlQuestions.id))
    .limit(QUESTION_PAGE_SIZE)
    .offset((page - 1) * QUESTION_PAGE_SIZE);
}

/** One of the user's questions with its answer rows while they are kept. */
export async function getQuestion(ctx: OpsReadCtx, id: string): Promise<QuestionDetail> {
  const me = requireAsk(ctx);
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundError("nl_question");
  const [q] = await ctx.tx
    .select({
      id: nlQuestions.id,
      question: nlQuestions.question,
      status: nlQuestions.status,
      rowCount: nlQuestions.rowCount,
      createdAt: nlQuestions.createdAt,
      sql: nlQuestions.generatedSql,
      explanation: nlQuestions.explanation,
      columns: nlQuestions.columns,
    })
    .from(nlQuestions)
    .where(and(eq(nlQuestions.id, id), eq(nlQuestions.userId, me)));
  if (!q) throw new NotFoundError("nl_question");
  let rows: unknown[][] | null = null;
  if (q.status === "answered") {
    const [job] = await ctx.tx
      .select({ result: jobs.result })
      .from(jobs)
      .where(and(eq(jobs.kind, "ai.answer_question"), eq(jobs.idempotencyKey, `question:${id}`), eq(jobs.status, "succeeded")))
      .limit(1);
    const result = job?.result as { rows?: unknown; columns?: unknown } | null | undefined;
    if (result && Array.isArray(result.rows)) rows = result.rows as unknown[][];
  }
  const personNames = rows ? await personLinks(ctx.tx, q.columns, rows) : {};
  return { ...q, rows, personNames };
}

/** Every stored week, newest first, in `locale` when generated (else English with a badge). */
export async function listWeeklySummaries(ctx: OpsReadCtx, input: { page?: number; locale?: Locale } = {}): Promise<WeeklySummaryView[]> {
  requireAny(ctx, "reports.read");
  const page = Math.max(1, Math.floor(input.page ?? 1));
  const locale = input.locale ?? ctx.locale;
  const rows = await ctx.tx
    .select({ weekStartOn: managementSummaries.weekStartOn, status: managementSummaries.status, summary: managementSummaries.summary, updatedAt: managementSummaries.updatedAt })
    .from(managementSummaries)
    .orderBy(desc(managementSummaries.weekStartOn))
    .limit(QUESTION_PAGE_SIZE)
    .offset((page - 1) * QUESTION_PAGE_SIZE);
  return rows.map((r) => {
    const own = r.summary[locale] ?? null;
    const english = own === null ? (r.summary.en ?? null) : null;
    return { weekStartOn: r.weekStartOn, status: r.status, text: own ?? english, englishOnly: own === null && english !== null && locale !== "en", updatedAt: r.updatedAt };
  });
}

/** One week's summary (`reports.read`), or null when that week has none. */
export async function getWeeklySummary(ctx: OpsReadCtx, input: { weekStartOn: string; locale?: Locale }): Promise<WeeklySummaryView | null> {
  requireAny(ctx, "reports.read");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.weekStartOn)) return null;
  const locale = input.locale ?? ctx.locale;
  const [r] = await ctx.tx
    .select({ weekStartOn: managementSummaries.weekStartOn, status: managementSummaries.status, summary: managementSummaries.summary, updatedAt: managementSummaries.updatedAt })
    .from(managementSummaries)
    .where(eq(managementSummaries.weekStartOn, input.weekStartOn));
  if (!r) return null;
  const own = r.summary[locale] ?? null;
  const english = own === null ? (r.summary.en ?? null) : null;
  return { weekStartOn: r.weekStartOn, status: r.status, text: own ?? english, englishOnly: own === null && english !== null && locale !== "en", updatedAt: r.updatedAt };
}
