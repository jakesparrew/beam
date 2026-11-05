/**
 * email jobs and the Resend webhook handler (email spec section 4 "Jobs"). Facade read by
 * `pnpm gen:indexes`. email-P3 took over platform-P7's Wave 0 `email.send` behind the same kind,
 * key (`email:<message_id>`) and payload (`{ emailMessageId, template }`).
 *
 * - `email.send` (fast, 1 for transactional, 5 for automation; 6 attempts): rules 39 to 44 and 59
 *   (`server/send.ts`). Content problems and Resend 4xx (except 429) are permanent: the message
 *   is `failed` with its error code and the job goes dead.
 * - `email.retry_soft_bounce` (fast, 5; 3 attempts): rule 49 (`server/process-event.ts`).
 * - `email.purge_props` (bulk, 9): `props = null` on messages sent more than 30 days ago, in
 *   batches of 5,000 (schedule `20 2 * * *`).
 * - `email.check_domains` (fast, 5): `ResendClient.getDomain()` for both domains; a domain or
 *   record that is not `verified` posts a High Slack alert (schedule `10 5 * * *`).
 * - `webhookHandlers`: platform's `webhook.process` calls `processResendEvent()` for `resend`.
 *
 * email-P4: `email.send` builds crm's links of each message from that message's own link token
 * (rules 2, 53, 55): marketing messages carry `List-Unsubscribe` (crm's one-click POST URL) and
 * `List-Unsubscribe-Post`, transactional messages neither, and every footer the preference-centre
 * link; `server/unsubscribe-links.ts` (`unsubscribeLinksFor`) is the single statement of that
 * contract and `unsubscribe-links.test.ts` proves the sent headers and footers follow it. The
 * scenario-2 checks run here without being told about an unsubscribe: `email.send` re-reads
 * `v_marketing_reachability` and the `all` suppressions just before Resend (rules 40, 55), and
 * the campaign chunk (email-P6) re-reads the view before every batch of 100 (rule 32).
 *
 * email-P6, campaigns:
 * - `campaign.plan` (bulk, 9; 3 attempts; key `campaign:<id>:plan:<version>`): the audience
 *   snapshot of rule 27 (`server/plan.ts`); the last failing attempt moves the campaign back to
 *   `draft` with `last_error`.
 * - `campaign.send_chunk` (bulk, 9; 6 attempts; key `campaign:<id>:chunk:<n>:r<run_no>`, plus
 *   `:d<YYYY-MM-DD>` for a warm-up continuation): rules 32 to 34 and 37 (`server/send-chunk.ts`).
 * - `email.dispatch_due_campaigns` (fast, 5; schedule `* * * * *`): rule 31.
 *
 * email-P7, reporting and deliverability:
 * - `email.freeze_campaign_stats` (bulk, 9; 3 attempts; key `campaign:<id>:freeze`): rule 62
 *   (`server/freeze.ts`); `email.freeze_due_stats` (schedule `40 4 * * *`) enqueues it for
 *   campaigns finished 30 days ago without a snapshot.
 * - `email.watch_complaints` (fast, 5; schedule every 15 minutes): rule 38, and rule 37
 *   re-evaluated for campaigns `sending` (`server/complaints.ts`).
 * - `email.watch_delivery` (fast, 3; schedule every 5 minutes): rule 38a (`server/delivery-watch.ts`).
 */
import { z } from "zod";
import type { AiFeatureKey } from "@beam/core/ai";
import { sql } from "@/lib/ctx";
import { notifySlack } from "@/lib/alerts";
import { defineJob, type JobCtx } from "@/lib/job-runner";
import { rowsOf } from "@/lib/sensitive";
import { defineWebhookHandler } from "@/lib/webhooks";
import { CampaignChunkJobInput, CampaignPlanJobInput } from "@beam/core/email";
import { watchComplaints } from "./server/complaints";
import { watchDelivery } from "./server/delivery-watch";
import { freezeCampaignStats, freezeDueStats } from "./server/freeze";
import { dispatchDueCampaigns, PLAN_MAX_ATTEMPTS, planCampaign } from "./server/plan";
import { processResendEvent, retrySoftBounce } from "./server/process-event";
import { sendChunk } from "./server/send-chunk";
import { sendEmailMessage } from "./server/send";

export { sendEmailMessage };

const SendInput = z.object({ emailMessageId: z.string().uuid(), template: z.string().min(1) });

export const PROPS_TTL_DAYS = 30;
export const PURGE_BATCH = 5000;
/** At most this many batches per run; the next night continues. */
const PURGE_MAX_ROUNDS = 20;

export async function purgeProps(ctx: JobCtx): Promise<{ purged: number }> {
  const cutoff = new Date(ctx.now.getTime() - PROPS_TTL_DAYS * 86_400_000);
  let purged = 0;
  for (let round = 0; round < PURGE_MAX_ROUNDS; round++) {
    const rows = rowsOf<{ id: string }>(
      await ctx.tx.execute(sql`
        update email_messages set props = null, updated_at = now()
        where id in (select id from email_messages where props is not null and sent_at < ${cutoff} limit ${PURGE_BATCH})
        returning id`),
    );
    purged += rows.length;
    if (rows.length < PURGE_BATCH) break;
  }
  return { purged };
}

/**
 * R4: the `callClaude` feature key of AI campaign drafts (platform-P3 request). The job kind is
 * `ai.draft_email` and so is the feature register entry; email spec section 6 still writes
 * `email.draft_email`, which `AI_FEATURES` does not know. email-P10 passes this constant.
 */
export const AI_DRAFT_EMAIL_FEATURE = "ai.draft_email" as const satisfies AiFeatureKey;

export const DOMAINS = ["mail.beam.be", "news.beam.be"] as const;

export async function checkDomains(ctx: JobCtx): Promise<{ problems: string[] }> {
  const problems: string[] = [];
  for (const domain of DOMAINS) {
    const d = await ctx.integrations.resend.getDomain(domain);
    const bad = d.records.filter((r) => r.status !== "verified").map((r) => `${r.type} ${r.name}`);
    if (d.status !== "verified" || bad.length) {
      problems.push(domain);
      await notifySlack(ctx, {
        fingerprint: `email:domain:${domain}`,
        severity: "high",
        text: `Email domain ${domain} is ${d.status}${bad.length ? `; records not verified: ${bad.join(", ")}` : ""}. See docs/runbooks/email-dns.md.`,
      });
    }
  }
  return { problems };
}

export const jobs = [
  defineJob({ kind: "email.send", lane: "fast", priority: 1, maxAttempts: 6, input: SendInput, run: sendEmailMessage }),
  defineJob({ kind: "email.retry_soft_bounce", lane: "fast", priority: 5, maxAttempts: 3, input: z.object({ emailMessageId: z.string().uuid() }), run: retrySoftBounce }),
  defineJob({ kind: "email.purge_props", lane: "bulk", priority: 9, maxAttempts: 3, input: z.object({}).passthrough(), run: purgeProps }),
  defineJob({ kind: "email.check_domains", lane: "fast", priority: 5, maxAttempts: 3, input: z.object({}).passthrough(), run: checkDomains }),
  defineJob({ kind: "campaign.plan", lane: "bulk", priority: 9, maxAttempts: PLAN_MAX_ATTEMPTS, timeoutMs: 120_000, input: CampaignPlanJobInput, run: planCampaign }),
  defineJob({ kind: "campaign.send_chunk", lane: "bulk", priority: 9, maxAttempts: 6, timeoutMs: 120_000, input: CampaignChunkJobInput, run: sendChunk }),
  defineJob({ kind: "email.dispatch_due_campaigns", lane: "fast", priority: 5, maxAttempts: 3, input: z.object({}).passthrough(), run: dispatchDueCampaigns }),
  defineJob({ kind: "email.freeze_campaign_stats", lane: "bulk", priority: 9, maxAttempts: 3, input: z.object({ campaignId: z.string().uuid() }), run: freezeCampaignStats }),
  defineJob({ kind: "email.freeze_due_stats", lane: "bulk", priority: 9, maxAttempts: 3, input: z.object({}).passthrough(), run: freezeDueStats }),
  defineJob({ kind: "email.watch_complaints", lane: "fast", priority: 5, maxAttempts: 3, input: z.object({}).passthrough(), run: watchComplaints }),
  defineJob({ kind: "email.watch_delivery", lane: "fast", priority: 3, maxAttempts: 3, input: z.object({}).passthrough(), run: watchDelivery }),
];

export const webhookHandlers = [
  defineWebhookHandler({
    provider: "resend",
    handle: async (ctx, event) => {
      await processResendEvent(ctx, event);
    },
  }),
];
