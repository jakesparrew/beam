/**
 * ops jobs, area `marketing` (ops spec 4.4, rules 72-74, R3): `ads.pull_yesterday`,
 * `ads.backfill`, `ops.compute_attribution`. Registered in `../jobs.ts` by ops-P1 (names, inputs
 * and signatures kept). Each handler returns early while `ff_ops_marketing` is `off` (the jobs
 * run as the system actor, so the gate reads the flag row: `testers` and `on` both run).
 *
 * - `ads.pull_yesterday` without `platform`/`accountId`/`day` is the 05:30 schedule: it enqueues
 *   one per-day pull per configured account for yesterday and the 3 days before (rule 74), each
 *   keyed `ads:<platform>:<accountId>:<day>:run:<runOn>`; with them it pulls that one day.
 * - `ads.backfill` enqueues one per-day pull for every day of `from..to` (at most 90).
 * - `ops.compute_attribution` rebuilds the last 400 days of `attribution_credits` one 30-day
 *   slice per job transaction: a run rebuilds `[fromPaidAt, fromPaidAt + 30 days)` and enqueues
 *   the next slice (key `attribution:<sliceStart>:run:<runOn>`); the last slice is open-ended.
 */
import { z } from "zod";
import { brusselsMidnight } from "@beam/core/ops";
import type { JobCtx } from "@/lib/job-runner";
import { addDays, brusselsDay, configuredAccounts, daysBetween, daysToPull, enqueueDayPulls, marketingEnabled, pullAdsDay, readAdsSettings } from "./ads";
import { computeAttribution } from "./attribution";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const platform = z.enum(["meta", "google"]);

/** Schedule key `schedule:ads.pull_yesterday:<minute>`; per account and day `ads:<platform>:<accountId>:<day>:run:<runOn>`. */
export const AdsPullYesterdayInput = z.object({ platform: platform.optional(), accountId: z.string().max(64).optional(), day: isoDate.optional(), runOn: isoDate.optional() });
/** Key `ads:backfill:<platform>:<accountId>:<from>:<to>`. */
export const AdsBackfillInput = z.object({ platform, accountId: z.string().min(1).max(64), from: isoDate, to: isoDate });
/** Schedule key `schedule:ops.compute_attribution:<minute>`. */
export const ComputeAttributionInput = z.object({ fromPaidAt: z.iso.datetime({ offset: true }).optional() });

/** Rule 72: the window rebuilt every night, and the slice per job transaction. */
export const ATTRIBUTION_REBUILD_DAYS = 400;
export const ATTRIBUTION_SLICE_DAYS = 30;

export type FlagOff = { skipped: "flag_off" };

export type AdsPullResult = FlagOff | { enqueued: number; runOn: string } | { platform: string; accountId: string; day: string; rows: number };

/** Rule 74: upserts yesterday and re-pulls the 3 days before. */
export async function runAdsPullYesterday(ctx: JobCtx, input: z.infer<typeof AdsPullYesterdayInput>): Promise<AdsPullResult> {
  if (!(await marketingEnabled(ctx.tx))) return { skipped: "flag_off" };
  const runOn = input.runOn ?? brusselsDay(ctx.now);
  if (input.platform && input.accountId && input.day) {
    const { rows } = await pullAdsDay(ctx.tx, { platform: input.platform, accountId: input.accountId, day: input.day, now: ctx.now });
    return { platform: input.platform, accountId: input.accountId, day: input.day, rows };
  }
  const accounts = configuredAccounts(await readAdsSettings(ctx.tx)).filter((a) => (!input.platform || a.platform === input.platform) && (!input.accountId || a.accountId === input.accountId));
  const days = input.day ? [input.day] : daysToPull(runOn);
  let enqueued = 0;
  for (const a of accounts) enqueued += (await enqueueDayPulls(ctx, { ...a, days, runOn })).length;
  return { enqueued, runOn };
}

/** Enqueues one per-day pull for the range. */
export async function runAdsBackfill(ctx: JobCtx, input: z.infer<typeof AdsBackfillInput>): Promise<FlagOff | { enqueued: number }> {
  if (!(await marketingEnabled(ctx.tx))) return { skipped: "flag_off" };
  const [from, to] = input.from <= input.to ? [input.from, input.to] : [input.to, input.from];
  const ids = await enqueueDayPulls(ctx, { platform: input.platform, accountId: input.accountId, days: daysBetween(from, to), runOn: brusselsDay(ctx.now) });
  return { enqueued: ids.length };
}

/** Brussels midnight of a `YYYY-MM-DD` date. */
function midnightOf(day: string): Date {
  const [year, month, d] = day.split("-").map(Number) as [number, number, number];
  return brusselsMidnight({ year, month, day: d });
}

/** Rule 72: rebuilds the last 400 days of `attribution_credits` in 30-day slices. */
export async function runComputeAttribution(
  ctx: JobCtx,
  input: z.infer<typeof ComputeAttributionInput>,
): Promise<FlagOff | { from: string; to: string | null; rows: number; next: string | null }> {
  if (!(await marketingEnabled(ctx.tx))) return { skipped: "flag_off" };
  const runOn = brusselsDay(ctx.now);
  const from = input.fromPaidAt ? new Date(input.fromPaidAt) : midnightOf(addDays(runOn, -ATTRIBUTION_REBUILD_DAYS));
  const sliceEnd = midnightOf(addDays(brusselsDay(from), ATTRIBUTION_SLICE_DAYS));
  const last = sliceEnd.getTime() > ctx.now.getTime();
  const { rows } = await computeAttribution(ctx.tx, { fromPaidAt: from, ...(last ? {} : { toPaidAt: sliceEnd }), now: ctx.now });
  if (last) return { from: from.toISOString(), to: null, rows, next: null };
  await ctx.enqueue({
    kind: "ops.compute_attribution",
    payload: { fromPaidAt: sliceEnd.toISOString() },
    key: `attribution:${brusselsDay(sliceEnd)}:run:${runOn}`,
  });
  return { from: from.toISOString(), to: sliceEnd.toISOString(), rows, next: sliceEnd.toISOString() };
}
