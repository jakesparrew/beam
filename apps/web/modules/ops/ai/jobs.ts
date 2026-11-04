/**
 * ops jobs, area `ai` (ops spec 4.4, rules 77-78, R4): `ai.weekly_summary`,
 * `ai.weekly_summary_collect`, `ai.answer_question` (inline). Registered in `../jobs.ts` by
 * ops-P1; ops-P10 implements the handlers here and keeps their names, inputs and signatures.
 * Until then each handler is a no-op (and each returns early while `ff_ops_ai` is off).
 */
import { z } from "zod";
import type { JobCtx } from "@/lib/job-runner";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Schedule key `schedule:ai.weekly_summary:<minute>`; regenerations `summary:<weekStartOn>:regen:<n>`. */
export const WeeklySummaryInput = z.object({ weekStartOn: isoDate.optional() });
/** Key `summary:<weekStartOn>:collect:<batchId>:<n>`. */
export const WeeklySummaryCollectInput = z.object({ weekStartOn: isoDate, batchId: z.string().min(1).max(200), n: z.number().int().min(0).max(36) });
/** Key `question:<questionId>` (run inline with `runJobInline()`). */
export const AnswerQuestionInput = z.object({ questionId: z.uuid() });

export type AiJobStubResult = { implemented: false };
const notYet = (): Promise<AiJobStubResult> => Promise.resolve({ implemented: false });

/** Rule 78: KPI aggregates, one Message Batch with one request per locale. */
export function runWeeklySummary(_ctx: JobCtx, _input: z.infer<typeof WeeklySummaryInput>): Promise<unknown> {
  return notYet();
}

/** Rule 78: reads the batch every 10 minutes for up to 6 hours. */
export function runWeeklySummaryCollect(_ctx: JobCtx, _input: z.infer<typeof WeeklySummaryCollectInput>): Promise<unknown> {
  return notYet();
}

/** Rule 77: validated read-only SQL over the `ai` schema, then a short explanation. */
export function runAnswerQuestion(_ctx: JobCtx, _input: z.infer<typeof AnswerQuestionInput>): Promise<unknown> {
  return notYet();
}
