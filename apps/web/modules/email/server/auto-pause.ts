/**
 * Bounce-rate auto-pause (email spec rule 37, decision 30), email-P6.
 *
 * `evaluateBounceRate(tx, campaignId)` runs after each chunk (and, once the Resend event handler
 * calls it, after each processed bounce of a campaign message). With at least
 * `settings.email_config.bounce_min_sent` (100) messages sent and `hard_bounced / sent` above
 * `bounce_pause_pct` (2 %), a `sending` campaign moves to `paused` with reason `bounce_rate`
 * (audit `email.campaign_auto_pause`, actor system), a High Slack alert
 * (`email:bounce:<campaign_id>`) is enqueued and one review task for marketing is created
 * (`dedupeKey: email:bounce:<campaign_id>`). A campaign that is already `sent` gets the alert
 * and the task but keeps its status. Complaints alert elsewhere (rule 38) and never pause.
 */
import type { Tx } from "@beam/db";
import { campaigns } from "@beam/db/schema";
import { createCtx, eq, sql, ValidationError, type Ctx } from "@/lib/ctx";
import { notifySlack } from "@/lib/alerts";
import { reportMessage } from "@/lib/logger";
import { rowsOf } from "@/lib/sensitive";
import { getSetting } from "@/lib/settings";
import { createTask } from "@/modules/crm/api";
import { transitionCampaign } from "./campaigns";

export type BounceStats = { sent: number; hardBounced: number };

export async function campaignBounceStats(tx: Tx, campaignId: string): Promise<BounceStats> {
  const [row] = rowsOf<{ sent: number | string; hard: number | string }>(
    await tx.execute(sql`
      select count(*) filter (where sent_at is not null)::int as sent,
             count(*) filter (where bounce_type = 'hard')::int as hard
      from email_messages where campaign_id = ${campaignId}::uuid and kind = 'campaign'`),
  );
  return { sent: Number(row?.sent ?? 0), hardBounced: Number(row?.hard ?? 0) };
}

/** True when the rate is over the threshold (rule 37: at least `minSent` sent, strictly above `pct` %). */
export function bounceRateExceeded(stats: BounceStats, config: { bounce_min_sent: number; bounce_pause_pct: number }): boolean {
  return stats.sent >= config.bounce_min_sent && stats.sent > 0 && stats.hardBounced / stats.sent > config.bounce_pause_pct / 100;
}

const pct = (s: BounceStats) => `${((100 * s.hardBounced) / Math.max(1, s.sent)).toFixed(1)} %`;

/**
 * Rule 37. `ctx` is optional: without it a system context over `tx` enqueues the alert and writes
 * the task (callers inside a job pass their own job context).
 */
export async function evaluateBounceRate(tx: Tx, campaignId: string, ctx?: Ctx): Promise<"ok" | "paused"> {
  const c0 = createCtxFor(tx, ctx);
  const [c] = await tx.select().from(campaigns).where(eq(campaigns.id, campaignId)).for("no key update");
  if (!c) return "ok";
  if (c.status === "paused" && c.pausedReason === "bounce_rate") return "paused";
  if (c.status !== "sending" && c.status !== "sent") return "ok";
  const config = await getSetting(tx, "email_config");
  const stats = await campaignBounceStats(tx, campaignId);
  if (!bounceRateExceeded(stats, config)) return "ok";

  let paused = false;
  if (c.status === "sending") {
    const next = await transitionCampaign(c0, c, "paused", { pausedReason: "bounce_rate" });
    await c0.audit({
      action: "email.campaign_auto_pause",
      entityType: "campaign",
      entityId: c.id,
      oldValue: { status: c.status },
      newValue: { status: next.status, pausedReason: "bounce_rate", sent: stats.sent, hardBounced: stats.hardBounced },
    });
    paused = true;
  }
  const what = paused ? "was paused automatically" : "has already been sent";
  await notifySlack(c0, {
    fingerprint: `email:bounce:${c.id}`,
    severity: "high",
    text: `Campaign "${c.name}" ${what}: ${stats.hardBounced} hard bounces of ${stats.sent} sent (${pct(stats)}). Review the list before resuming.`,
  });
  try {
    await createTask(tx, c0, {
      title: `Review bounce rate of campaign "${c.name}" (${pct(stats)})`,
      kind: "review",
      ownerRole: "marketing",
      priority: "high",
      source: "system",
      ref: { type: "campaign", id: c.id },
      dedupeKey: `email:bounce:${c.id}`,
    });
  } catch (error) {
    // No marketing or owner user to own the task: the pause and the alert still stand.
    if (!(error instanceof ValidationError)) throw error;
    reportMessage(`email: bounce review task not created: ${error.message}`, { tags: { module: "email" } });
  }
  return paused ? "paused" : "ok";
}

function createCtxFor(tx: Tx, ctx: Ctx | undefined): Ctx {
  if (ctx && ctx.tx === tx) return ctx;
  return createCtx({ tx, actor: ctx?.actor ?? { kind: "system", jobId: "" }, ...(ctx ? { now: ctx.now, requestId: ctx.requestId } : {}) });
}
