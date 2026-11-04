/**
 * Segment refresh jobs (crm spec 4.5, rules 3.40 and 3.41), implemented by crm-P5. crm-P1
 * stubs: the kinds, inputs and lanes are declared in `apps/web/modules/crm/jobs.ts`; these
 * handlers throw `NotImplementedError` (a permanent failure) until crm-P5 lands.
 */
import { z } from "zod";
import { NotImplementedError } from "@beam/core/errors";
import type { JobCtx } from "@/lib/job-runner";

/** `segments.refresh`: enqueues `segments.refresh_one` per non-archived dynamic segment. */
export const RefreshSegmentsInput = z.object({});

/** `segments.refresh_one`, key `segment:<id>:refresh:<YYYY-MM-DDTHH>` (schedule) or `segment:<id>:refresh:<reason>:<ref>`. */
export const RefreshSegmentInput = z.object({
  segmentId: z.uuid(),
  reason: z.enum(["schedule", "save", "campaign", "manual"]),
});

export function runRefreshSegments(_ctx: JobCtx, _input: z.infer<typeof RefreshSegmentsInput>): Promise<{ enqueued: number }> {
  return Promise.reject(new NotImplementedError("segments.refresh"));
}

export function runRefreshSegment(_ctx: JobCtx, _input: z.infer<typeof RefreshSegmentInput>): Promise<{ count: number; entered: number; left: number }> {
  return Promise.reject(new NotImplementedError("segments.refresh_one"));
}
