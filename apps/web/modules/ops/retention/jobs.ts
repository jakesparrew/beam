/**
 * ops jobs, area `retention` (ops spec 4.4, rule 20, R2): `ops.build_weekly_retention_list`,
 * registered in `../jobs.ts` by ops-P1 (bulk lane, priority 5). The Monday 06:10 schedule passes
 * no input, so the handler derives the Brussels Monday of the week from `ctx.now`.
 *
 * R2 gate: the handler returns early while `ff_ops_retention` is `off` (no row counts as off).
 * The job runs as the system actor, which no `testers` flag resolves for, so the gate reads the
 * flag row itself: a list is built while the flag is `testers` or `on`.
 *
 * The first build of a week posts the Slack notice (`retention-list:<week>`); a second run of the
 * same week (a retry or a catch-up) rebuilds the list the same way and posts nothing.
 */
import { z } from "zod";
import { featureFlags } from "@beam/db/schema";
import type { JobCtx } from "@/lib/job-runner";
import { eq, sql } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { buildWeeklyRetentionList, postRetentionNotice, readRetentionDefaults, weekStartOf } from "./build-list";

/** `{ weekStartOn? }`: the Monday (Brussels) of the list; the scheduled run derives it. */
export const BuildWeeklyRetentionListInput = z.object({ weekStartOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });

export const RETENTION_FLAG = "ff_ops_retention";

export type BuildWeeklyRetentionListResult =
  | { skipped: "flag_off" }
  | { weekStartOn: string; listId: string; size: number; created: boolean; notified: boolean };

/** True unless `ff_ops_retention` is `off` or has no row. */
export async function retentionEnabled(ctx: Pick<JobCtx, "tx">): Promise<boolean> {
  const [row] = await ctx.tx.select({ state: featureFlags.state }).from(featureFlags).where(eq(featureFlags.key, RETENTION_FLAG)).limit(1);
  return !!row && row.state !== "off";
}

/** Rule 20: builds `retention_lists` for the week and posts the Slack line after the week's first build. */
export async function runBuildWeeklyRetentionList(ctx: JobCtx, input: z.infer<typeof BuildWeeklyRetentionListInput>): Promise<BuildWeeklyRetentionListResult> {
  if (!(await retentionEnabled(ctx))) return { skipped: "flag_off" };
  const weekStartOn = input.weekStartOn ?? weekStartOf(ctx.now);
  const [before] = rowsOf<{ n: number }>(await ctx.tx.execute(sql`select count(*)::int as n from retention_lists where week_start_on = ${weekStartOn}::date`));
  const created = Number(before?.n ?? 0) === 0;
  const { listId, size } = await buildWeeklyRetentionList(ctx.tx, weekStartOn, await readRetentionDefaults(ctx.tx));
  if (created) await postRetentionNotice(ctx, listId, weekStartOn);
  return { weekStartOn, listId, size, created, notified: created };
}
