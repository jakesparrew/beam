/**
 * Complaint alert (email spec rule 38), email-P7. Every 15 minutes `email.watch_complaints`
 * computes complaints / delivered for `news.beam.be` over the last 24 hours; above
 * `settings.email_config.complaint_alert_pct` (0.1 %) with at least `complaint_min_delivered`
 * (500) delivered it posts `notifySlack({ fingerprint: 'email:complaints', severity: 'high' })`
 * (platform deduplicates per hour) and `/admin/email` shows the red banner (`complaintState`).
 *
 * The same run re-evaluates the bounce-rate auto-pause of rule 37 for every campaign `sending`
 * (`evaluateBounceRate`), so a pause also happens when no chunk or bounce event runs.
 */
import type { DbOrTx } from "@beam/db";
import { campaigns } from "@beam/db/schema";
import { eq, sql } from "@/lib/ctx";
import { notifySlack } from "@/lib/alerts";
import type { JobCtx } from "@/lib/job-runner";
import { rowsOf } from "@/lib/sensitive";
import { getSetting } from "@/lib/settings";
import { evaluateBounceRate } from "./auto-pause";

export const COMPLAINT_WINDOW_HOURS = 24;

export type ComplaintState = { delivered: number; complained: number; rate: number | null; thresholdPct: number; minDelivered: number; alert: boolean };

export async function complaintState(db: DbOrTx, now: Date): Promise<ComplaintState> {
  const since = new Date(now.getTime() - COMPLAINT_WINDOW_HOURS * 3_600_000).toISOString();
  const until = now.toISOString();
  const [row] = rowsOf<{ delivered: number; complained: number }>(
    await db.execute(sql`
      select count(*) filter (where delivered_at > ${since}::timestamptz and delivered_at <= ${until}::timestamptz)::int as delivered,
             count(*) filter (where complained_at > ${since}::timestamptz and complained_at <= ${until}::timestamptz)::int as complained
      from email_messages
      where from_domain = 'news.beam.be' and (delivered_at > ${since}::timestamptz or complained_at > ${since}::timestamptz)`),
  );
  const config = await getSetting(db, "email_config");
  const delivered = Number(row?.delivered ?? 0);
  const complained = Number(row?.complained ?? 0);
  const rate = delivered > 0 ? complained / delivered : null;
  const alert = delivered >= config.complaint_min_delivered && rate !== null && rate > config.complaint_alert_pct / 100;
  return { delivered, complained, rate, thresholdPct: config.complaint_alert_pct, minDelivered: config.complaint_min_delivered, alert };
}

export async function watchComplaints(ctx: JobCtx): Promise<{ alerted: boolean; rate: number | null; delivered: number; pausedCampaigns: string[] }> {
  const state = await complaintState(ctx.tx, ctx.now);
  if (state.alert) {
    await notifySlack(ctx, {
      fingerprint: "email:complaints",
      severity: "high",
      text: `Complaint rate on news.beam.be is ${((state.rate ?? 0) * 100).toFixed(2)} % over the last 24 hours (${state.complained} complaints of ${state.delivered} delivered; threshold ${state.thresholdPct} %). Check the recent campaigns on /admin/email.`,
    });
  }
  // Rule 37 re-evaluated for campaigns still sending.
  const sending = await ctx.tx.select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.status, "sending"));
  const pausedCampaigns: string[] = [];
  for (const { id } of sending) {
    if ((await evaluateBounceRate(ctx.tx, id, ctx)) === "paused") pausedCampaigns.push(id);
  }
  return { alerted: state.alert, rate: state.rate, delivered: state.delivered, pausedCampaigns };
}
