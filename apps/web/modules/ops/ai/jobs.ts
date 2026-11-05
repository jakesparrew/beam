/**
 * ops jobs, area `ai` (ops spec 4.4, rules 77-78, R4): `ai.weekly_summary`,
 * `ai.weekly_summary_collect`, `ai.answer_question` (inline). Registered in `../jobs.ts` by
 * ops-P1 with these names, inputs and signatures; each handler returns early while `ff_ops_ai`
 * is `off`.
 */
import { z } from "zod";
import { featureFlags } from "@beam/db/schema";
import { eq } from "@/lib/ctx";
import type { JobCtx } from "@/lib/job-runner";
import { answerQuestion, type AskOutcome } from "./ask";
import { collectWeeklySummary, startWeeklySummary, type CollectResult, type WeeklySummaryResult } from "./summary";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Schedule key `schedule:ai.weekly_summary:<minute>`; regenerations `summary:<weekStartOn>:regen:<n>`. */
export const WeeklySummaryInput = z.object({ weekStartOn: isoDate.optional() });
/** Key `summary:<weekStartOn>:collect:<batchId>:<n>`. */
export const WeeklySummaryCollectInput = z.object({ weekStartOn: isoDate, batchId: z.string().min(1).max(200), n: z.number().int().min(0).max(36) });
/** Key `question:<questionId>` (run inline with `runJobInline()`). */
export const AnswerQuestionInput = z.object({ questionId: z.uuid() });

export type AiJobSkipped = { status: "skipped"; reason: "flag_off" };

/** R4 jobs run while `ff_ops_ai` is not `off` (a `testers` rollout still produces the summary). */
async function aiFlagOn(ctx: JobCtx): Promise<boolean> {
  const [row] = await ctx.tx.select({ state: featureFlags.state }).from(featureFlags).where(eq(featureFlags.key, "ff_ops_ai")).limit(1);
  return !!row && row.state !== "off";
}

const flagOff = (): AiJobSkipped => ({ status: "skipped", reason: "flag_off" });

/** Rule 78: KPI aggregates, one Message Batch with one request per locale. */
export async function runWeeklySummary(ctx: JobCtx, input: z.infer<typeof WeeklySummaryInput>): Promise<WeeklySummaryResult | AiJobSkipped> {
  if (!(await aiFlagOn(ctx))) return flagOff();
  return startWeeklySummary(ctx, input);
}

/** Rule 78: reads the batch every 10 minutes for up to 6 hours. */
export async function runWeeklySummaryCollect(ctx: JobCtx, input: z.infer<typeof WeeklySummaryCollectInput>): Promise<CollectResult | AiJobSkipped> {
  if (!(await aiFlagOn(ctx))) return flagOff();
  return collectWeeklySummary(ctx, input);
}

/** Rule 77: validated read-only SQL over the `ai` schema, then a short explanation. */
export async function runAnswerQuestion(ctx: JobCtx, input: z.infer<typeof AnswerQuestionInput>): Promise<AskOutcome | AiJobSkipped> {
  if (!(await aiFlagOn(ctx))) return flagOff();
  return answerQuestion(ctx, input.questionId);
}
