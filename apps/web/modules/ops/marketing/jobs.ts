/**
 * ops jobs, area `marketing` (ops spec 4.4, rules 72-74, R3): `ads.pull_yesterday`,
 * `ads.backfill`, `ops.compute_attribution`. Registered in `../jobs.ts` by ops-P1; ops-P8
 * implements the handlers here and keeps their names, inputs and signatures. Until then each
 * handler is a no-op (and each returns early while `ff_ops_marketing` is off).
 */
import { z } from "zod";
import type { JobCtx } from "@/lib/job-runner";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const platform = z.enum(["meta", "google"]);

/** Schedule key `schedule:ads.pull_yesterday:<minute>`; per account and day `ads:<platform>:<accountId>:<day>:run:<runOn>`. */
export const AdsPullYesterdayInput = z.object({ platform: platform.optional(), accountId: z.string().max(64).optional(), day: isoDate.optional(), runOn: isoDate.optional() });
/** Key `ads:backfill:<platform>:<accountId>:<from>:<to>`. */
export const AdsBackfillInput = z.object({ platform, accountId: z.string().min(1).max(64), from: isoDate, to: isoDate });
/** Schedule key `schedule:ops.compute_attribution:<minute>`. */
export const ComputeAttributionInput = z.object({ fromPaidAt: z.iso.datetime({ offset: true }).optional() });

export type MarketingJobStubResult = { implemented: false };
const notYet = (): Promise<MarketingJobStubResult> => Promise.resolve({ implemented: false });

/** Rule 74: upserts yesterday and re-pulls the 3 days before. */
export function runAdsPullYesterday(_ctx: JobCtx, _input: z.infer<typeof AdsPullYesterdayInput>): Promise<unknown> {
  return notYet();
}

/** Enqueues one per-day pull for the range. */
export function runAdsBackfill(_ctx: JobCtx, _input: z.infer<typeof AdsBackfillInput>): Promise<unknown> {
  return notYet();
}

/** Rule 72: rebuilds the last 400 days of `attribution_credits` in 30-day slices. */
export function runComputeAttribution(_ctx: JobCtx, _input: z.infer<typeof ComputeAttributionInput>): Promise<unknown> {
  return notYet();
}
