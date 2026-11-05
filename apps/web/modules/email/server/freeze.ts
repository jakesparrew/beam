/**
 * Stats freezing (email spec rule 62), email-P7. 30 days after a campaign finished (`finished_at`,
 * or `stopped_at` for a stopped campaign), `email.freeze_campaign_stats` stores the
 * `v_campaign_stats` row and the report's aggregates in `campaigns.stats_snapshot`
 * (`buildSnapshot`); reports read the snapshot from then on, so retention deletes of
 * `email_messages` and `email_events` never change historic numbers.
 *
 * - `freezeCampaignStats(ctx, { campaignId })`: the job (key `campaign:<id>:freeze`); writes
 *   once, a campaign that already has a snapshot or is not finished 30 days is left alone.
 * - `freezeDueStats(ctx)`: the daily schedule `email.freeze_due_stats` (`40 4 * * *`), enqueues
 *   the job for every campaign finished 30 days ago without a snapshot.
 */
import { campaigns } from "@beam/db/schema";
import { eq, sql } from "@/lib/ctx";
import type { JobCtx } from "@/lib/job-runner";
import { rowsOf } from "@/lib/sensitive";
import { buildSnapshot } from "./reports";

export const FREEZE_AFTER_DAYS = 30;

export const freezeJobKey = (campaignId: string) => `campaign:${campaignId}:freeze`;

const cutoffOf = (now: Date) => new Date(now.getTime() - FREEZE_AFTER_DAYS * 86_400_000);

export async function freezeCampaignStats(ctx: JobCtx, input: { campaignId: string }): Promise<{ frozen: boolean }> {
  const [c] = await ctx.tx.select().from(campaigns).where(eq(campaigns.id, input.campaignId)).for("update");
  if (!c || c.statsSnapshot) return { frozen: false };
  const endedAt = c.finishedAt ?? c.stoppedAt;
  if (!endedAt || endedAt > cutoffOf(ctx.now)) return { frozen: false };
  const snapshot = await buildSnapshot(ctx.tx, c.id, ctx.now);
  if (!snapshot) return { frozen: false };
  await ctx.tx.update(campaigns).set({ statsSnapshot: snapshot, updatedAt: ctx.now }).where(eq(campaigns.id, c.id));
  return { frozen: true };
}

export async function freezeDueStats(ctx: JobCtx): Promise<{ enqueued: number }> {
  const due = rowsOf<{ id: string }>(
    await ctx.tx.execute(sql`
      select id from campaigns
      where stats_snapshot is null and status in ('sent', 'stopped')
        and coalesce(finished_at, stopped_at) <= ${cutoffOf(ctx.now).toISOString()}::timestamptz
      order by coalesce(finished_at, stopped_at) limit 500`),
  );
  for (const { id } of due) {
    await ctx.enqueue({ kind: "email.freeze_campaign_stats", payload: { campaignId: id }, key: freezeJobKey(id), lane: "bulk", priority: 9 });
  }
  return { enqueued: due.length };
}
