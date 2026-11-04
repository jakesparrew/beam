/**
 * ops jobs, area `exports` (ops spec 4.4, rules 54-57, 68-69): `ops.export_chunk`,
 * `ops.export_finalise`, `privacy.retention_sweep`. Registered in `../jobs.ts` by ops-P1; ops-P6
 * implements the handlers here and keeps their names, inputs and signatures. Until then each
 * handler is a no-op.
 */
import { z } from "zod";
import type { JobCtx } from "@/lib/job-runner";

/** Key `export:<id>:<entity>:chunk:<n>` (`entity`: an `EXPORT_ENTITIES` member, or a table of the full export). */
export const ExportChunkInput = z.object({ exportId: z.uuid(), entity: z.string().regex(/^[a-z_]+$/), offset: z.number().int().min(0) });
/** Key `export:<id>:finalise`. */
export const ExportFinaliseInput = z.object({ exportId: z.uuid() });
/** Schedule key `schedule:privacy.retention_sweep:<minute>`; continuations `retention:<runOn>:<policyKey>:<n>`. */
export const RetentionSweepInput = z.object({
  runOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  policyKey: z.string().regex(/^[a-z]+\.[a-z][a-z0-9_]*$/).optional(),
  n: z.number().int().min(0).optional(),
});

export type ExportJobStubResult = { implemented: false };
const notYet = (): Promise<ExportJobStubResult> => Promise.resolve({ implemented: false });

/** Rule 55: 5,000 rows to one CSV part. */
export function runExportChunk(_ctx: JobCtx, _input: z.infer<typeof ExportChunkInput>): Promise<unknown> {
  return notYet();
}

/** Sets `done`, `expires_at`, audit `data.exported`. */
export function runExportFinalise(_ctx: JobCtx, _input: z.infer<typeof ExportFinaliseInput>): Promise<unknown> {
  return notYet();
}

/** Rules 68-69: active policies by `run_order` through their owners' `sweep[key]` handlers. */
export function runRetentionSweep(_ctx: JobCtx, _input: z.infer<typeof RetentionSweepInput>): Promise<unknown> {
  return notYet();
}
