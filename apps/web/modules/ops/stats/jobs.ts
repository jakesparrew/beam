/**
 * ops jobs, area `stats` (ops spec 4.4, rules 1-18 and 71): `ops.refresh_person_stats`,
 * `ops.refresh_recent_stats`, `ops.refresh_person`, `ops.daily_digest`. Registered in
 * `../jobs.ts` by ops-P1; ops-P2 implements the handlers here and keeps their names, inputs and
 * signatures. Until then each handler is a no-op, so a run never dies.
 */
import { z } from "zod";
import type { JobCtx } from "@/lib/job-runner";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** `{ runOn?, afterId? }`; continuations carry both (key `stats:nightly:<runOn>:<afterId>`). */
export const RefreshPersonStatsInput = z.object({ runOn: isoDate.optional(), afterId: z.uuid().optional() });
export const RefreshRecentStatsInput = z.object({});
export const RefreshPersonInput = z.object({ personId: z.uuid() });
export const DailyDigestInput = z.object({});

export type StatsJobStubResult = { implemented: false };
const notYet = (): Promise<StatsJobStubResult> => Promise.resolve({ implemented: false });

/** Rule 5: 2,000 people per job ordered by `person_id`, then the next chunk; inactivity and stage events. */
export function runRefreshPersonStats(_ctx: JobCtx, _input: z.infer<typeof RefreshPersonStatsInput>): Promise<unknown> {
  return notYet();
}

/** Rule 6: people with a `STATS_KINDS` event since `ops_state.stats_cursor`, at most 1,000. */
export function runRefreshRecentStats(_ctx: JobCtx, _input: z.infer<typeof RefreshRecentStatsInput>): Promise<unknown> {
  return notYet();
}

/** Rule 7: one person (`requestStatsRefresh`). */
export function runRefreshPerson(_ctx: JobCtx, _input: z.infer<typeof RefreshPersonInput>): Promise<unknown> {
  return notYet();
}

/** Rule 71: one Slack message per day through `notifySlack` with fingerprint `digest`. */
export function runDailyDigest(_ctx: JobCtx, _input: z.infer<typeof DailyDigestInput>): Promise<unknown> {
  return notYet();
}
