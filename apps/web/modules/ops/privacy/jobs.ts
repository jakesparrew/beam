/**
 * ops jobs, area `privacy` (ops spec 4.4, rules 59a-64): `privacy.export`, `privacy.erase`,
 * `privacy.erase_external`, `privacy.erase_step`, `privacy.finalise`. Registered in `../jobs.ts`
 * by ops-P1; ops-P5 implements the handlers here and keeps their names, inputs and signatures.
 * Until then each handler is a no-op. Every key carries `r<run_attempt>`.
 */
import { z } from "zod";
import { ERASE_EXTERNAL_PROVIDERS, ERASE_ORDER } from "@beam/core/ops";
import type { JobCtx } from "@/lib/job-runner";

const request = z.object({ requestId: z.uuid() });

/** Key `privacy:<id>:r<run_attempt>:export`. */
export const PrivacyExportInput = request;
/** Key `privacy:<id>:r<run_attempt>:start` (run now: `:start:now`). */
export const PrivacyEraseInput = request;
/** Key `privacy:<id>:r<run_attempt>:external:<provider>`. */
export const PrivacyEraseExternalInput = request.extend({ provider: z.enum(ERASE_EXTERNAL_PROVIDERS) });
/** Key `privacy:<id>:r<run_attempt>:step:<module>`. */
export const PrivacyEraseStepInput = request.extend({ module: z.enum(ERASE_ORDER) });
/** Key `privacy:<id>:r<run_attempt>:finalise`. */
export const PrivacyFinaliseInput = request;

export type PrivacyJobStubResult = { implemented: false };
const notYet = (): Promise<PrivacyJobStubResult> => Promise.resolve({ implemented: false });

/** Rule 60: the encrypted subject export zip. */
export function runPrivacyExport(_ctx: JobCtx, _input: z.infer<typeof PrivacyExportInput>): Promise<unknown> {
  return notYet();
}

/** Rules 61, 63a: starts the erasure at `scheduled_for_at` and enqueues the external steps. */
export function runPrivacyErase(_ctx: JobCtx, _input: z.infer<typeof PrivacyEraseInput>): Promise<unknown> {
  return notYet();
}

/** Rules 62-63: Billit, payment mandates and Resend, while the address is still known. */
export function runPrivacyEraseExternal(_ctx: JobCtx, _input: z.infer<typeof PrivacyEraseExternalInput>): Promise<unknown> {
  return notYet();
}

/** Rule 62: one module's registry `erase` under `SET LOCAL beam.allow_rewrite = 'on'`. */
export function runPrivacyEraseStep(_ctx: JobCtx, _input: z.infer<typeof PrivacyEraseStepInput>): Promise<unknown> {
  return notYet();
}

/** Rule 64: status `done`, audit `privacy.erased`, no event. */
export function runPrivacyFinalise(_ctx: JobCtx, _input: z.infer<typeof PrivacyFinaliseInput>): Promise<unknown> {
  return notYet();
}
