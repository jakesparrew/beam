"use server";
/**
 * ops server actions, area `ai` (ops spec 4.1, R4, rules 77-78), behind `ff_ops_ai`:
 *
 * - `askQuestion` (`ai.use` and `reports.read`): stores the `nl_questions` row, runs the inline
 *   job `ai.answer_question` (key `question:<id>`) and returns the columns, at most 200 rows, the
 *   explanation and the display names for `person_id` links (resolved here, never sent to
 *   Claude). Audited as `ai.question_asked` with the question id only.
 * - `regenerateWeeklySummary` (`reports.read` and `ai.use`): enqueues `ai.weekly_summary` with
 *   key `summary:<weekStartOn>:regen:<n>`; refused (`conflict`) while that week's batch runs.
 *   Audited as `summary.regenerated`.
 *
 * A "use server" file exports async functions only.
 */
import { AskQuestionInput, RegenerateWeeklySummaryInput } from "@beam/core/ops";
import type { Tx } from "@beam/db";
import { featureFlags, managementSummaries, nlQuestions, users } from "@beam/db/schema";
import { ForbiddenError } from "@beam/core/errors";
import { action } from "@/lib/action";
import { ConflictError, eq, NotFoundError, sql, type Ctx } from "@/lib/ctx";
import { runJobInline } from "@/lib/job-runner";
import { rowsOf } from "@/lib/sensitive";
import { personLinks, type AskOutcome, type NlStatus } from "./ask";

export type AskQuestionResult = {
  questionId: string;
  status: NlStatus;
  columns: string[];
  rows: unknown[][];
  explanation: string | null;
  sql: string | null;
  /** `person_id` value -> display name, for the links of the answer table. */
  personNames: Record<string, string>;
};

/** `ff_ops_ai` read through the action's transaction: `on`, or `testers` for a listed or tester user. */
async function requireAiFlag(ctx: Ctx): Promise<void> {
  const [row] = await ctx.tx.select({ state: featureFlags.state, userIds: featureFlags.userIds }).from(featureFlags).where(eq(featureFlags.key, "ff_ops_ai")).limit(1);
  if (row?.state === "on") return;
  if (row?.state === "testers" && ctx.actor.kind === "staff") {
    if ((row.userIds ?? []).includes(ctx.actor.userId)) return;
    const [u] = await ctx.tx.select({ t: users.isTester }).from(users).where(eq(users.id, ctx.actor.userId)).limit(1);
    if (u?.t) return;
  }
  throw new NotFoundError("ff_ops_ai");
}

/** Plain JSON values for the client (dates as ISO strings, bigints as numbers). */
function plain(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return Number(value);
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === "object") return JSON.parse(JSON.stringify(value)) as unknown;
  return value;
}

export const askQuestion = action(
  { name: "ops.ask", audience: "staff", permission: "ai.use", input: AskQuestionInput, audit: false },
  async (ctx, input): Promise<AskQuestionResult> => {
    ctx.require("reports.read");
    await requireAiFlag(ctx);
    if (ctx.actor.kind !== "staff") throw new ForbiddenError();
    // Until the inline job finishes, the row reads `error` (an interrupted question stays `error`).
    const [row] = await ctx.tx.insert(nlQuestions).values({ userId: ctx.actor.userId, question: input.question, status: "error" }).returning({ id: nlQuestions.id });
    const questionId = row!.id;
    await ctx.audit({ action: "ai.question_asked", entityType: "nl_question", entityId: questionId });

    let outcome: AskOutcome;
    try {
      const result = await runJobInline<AskOutcome | { status: "skipped" }>("ai.answer_question", { questionId }, { key: `question:${questionId}`, requestId: ctx.requestId, db: ctx.tx as Tx as never });
      if (result.status === "skipped") throw new NotFoundError("ff_ops_ai");
      outcome = result as AskOutcome;
    } catch (error) {
      if (error instanceof NotFoundError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const status: NlStatus = /timeout|timed out|abort/i.test(message) ? "timeout" : "error";
      await ctx.tx.update(nlQuestions).set({ status, updatedAt: ctx.now }).where(eq(nlQuestions.id, questionId));
      return { questionId, status, columns: [], rows: [], explanation: null, sql: null, personNames: {} };
    }
    const rows = (plain(outcome.rows) as unknown[][]) ?? [];
    return {
      questionId,
      status: outcome.status,
      columns: outcome.columns,
      rows,
      explanation: outcome.explanation,
      sql: outcome.sql,
      personNames: await personLinks(ctx.tx, outcome.columns, rows),
    };
  },
);

export const regenerateWeeklySummary = action(
  { name: "ops.summary_regenerate", audience: "staff", permission: "reports.read", input: RegenerateWeeklySummaryInput, audit: false },
  async (ctx, input): Promise<{ jobId: string }> => {
    ctx.require("ai.use");
    await requireAiFlag(ctx);
    const [row] = await ctx.tx
      .select({ status: managementSummaries.status, batchId: managementSummaries.batchId, kpis: managementSummaries.kpis })
      .from(managementSummaries)
      .where(eq(managementSummaries.weekStartOn, input.weekStartOn))
      .for("update");
    if (row?.status === "pending" && row.batchId) throw new ConflictError("summary_batch_running");
    const prefix = `summary:${input.weekStartOn}:regen:`;
    const [count] = rowsOf<{ n: number }>(
      await ctx.tx.execute(sql`select count(*)::int as n from jobs where kind = 'ai.weekly_summary' and idempotency_key like ${`${prefix}%`}`),
    );
    // Old job rows are pruned: the stored generation keeps the number growing.
    const stored = Number((row?.kpis as { generation?: unknown } | undefined)?.generation ?? 0);
    const n = Math.max(Number(count?.n ?? 0), Number.isFinite(stored) ? stored : 0) + 1;
    const { id } = await ctx.enqueue({ kind: "ai.weekly_summary", payload: { weekStartOn: input.weekStartOn }, key: `${prefix}${n}` });
    await ctx.audit({ action: "summary.regenerated", entityType: "management_summary", entityId: null, newValue: { weekStartOn: input.weekStartOn, n } });
    return { jobId: id };
  },
);
