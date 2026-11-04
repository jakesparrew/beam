/**
 * ops jobs, area `retention` (ops spec 4.4, rule 20, R2): `ops.build_weekly_retention_list`.
 * Registered in `../jobs.ts` by ops-P1; ops-P7 implements the handler here and keeps its name,
 * input and signature. Until then it is a no-op.
 */
import { z } from "zod";
import type { JobCtx } from "@/lib/job-runner";

/** `{ weekStartOn? }`: the Monday (Brussels) of the list; the scheduled run derives it. */
export const BuildWeeklyRetentionListInput = z.object({ weekStartOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });

export type RetentionJobStubResult = { implemented: false };

/** Rule 20: builds `retention_lists` for the week and posts the Slack line. */
export function runBuildWeeklyRetentionList(_ctx: JobCtx, _input: z.infer<typeof BuildWeeklyRetentionListInput>): Promise<unknown> {
  return Promise.resolve<RetentionJobStubResult>({ implemented: false });
}
