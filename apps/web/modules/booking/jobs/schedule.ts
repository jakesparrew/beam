/**
 * Schedule jobs (booking spec 4.5, R1-R4): `sessions.materialise`, `sessions.regenerate_template`,
 * `sessions.regenerate_date`. Registered in `../jobs.ts` (booking-P1); booking-P2 implements the
 * handlers here and keeps their names, inputs and signatures. Until then each handler is a no-op,
 * so a scheduled run never dies.
 */
import { z } from "zod";
import type { JobCtx } from "@/lib/job-runner";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** `{ fromOn?, days? }`; continuations carry `fromOn` (key `materialise:<run date>:<fromOn>`). */
export const MaterialiseInput = z.object({ fromOn: isoDate.optional(), days: z.number().int().min(1).max(90).optional() });
export const RegenerateTemplateInput = z.object({ templateId: z.uuid() });
export const RegenerateDateInput = z.object({ onDate: isoDate });

export type JobStubResult = { implemented: false };
const notYet = (): Promise<JobStubResult> => Promise.resolve({ implemented: false });

/** R1: ensures every active template's sessions for `[today, today + 90]` (30-day chunks). */
export function runMaterialise(_ctx: JobCtx, _input: z.infer<typeof MaterialiseInput>): Promise<unknown> {
  return notYet();
}

/** R2, R3: regenerates the untouched future sessions of one template. */
export function runRegenerateTemplate(_ctx: JobCtx, _input: z.infer<typeof RegenerateTemplateInput>): Promise<unknown> {
  return notYet();
}

/** R4: removes suppressed untouched sessions of a date and re-inserts the allowed ones. */
export function runRegenerateDate(_ctx: JobCtx, _input: z.infer<typeof RegenerateDateInput>): Promise<unknown> {
  return notYet();
}
