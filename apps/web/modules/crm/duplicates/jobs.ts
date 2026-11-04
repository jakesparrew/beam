/**
 * Duplicate jobs (crm spec 4.5), implemented by crm-P4. crm-P1 stubs: the kinds, inputs and
 * lanes are declared in `apps/web/modules/crm/jobs.ts`; these handlers throw
 * `NotImplementedError` (a permanent failure) until crm-P4 lands.
 */
import { z } from "zod";
import { NotImplementedError } from "@beam/core/errors";
import type { JobCtx } from "@/lib/job-runner";

/** `crm.check_duplicates`, key `dupcheck:<person_id>:<version>`. */
export const CheckDuplicatesInput = z.object({ personId: z.uuid() });

/** `crm.detect_duplicates`, 2,000 persons per run by id order, then itself with the next `afterId`. */
export const DetectDuplicatesInput = z.object({ afterId: z.uuid().optional() });

export function runCheckDuplicates(_ctx: JobCtx, _input: z.infer<typeof CheckDuplicatesInput>): Promise<{ candidates: number }> {
  return Promise.reject(new NotImplementedError("crm.check_duplicates"));
}

export function runDetectDuplicates(_ctx: JobCtx, _input: z.infer<typeof DetectDuplicatesInput>): Promise<{ scanned: number; next: string | null }> {
  return Promise.reject(new NotImplementedError("crm.detect_duplicates"));
}
