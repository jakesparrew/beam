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
 */
import { z } from "zod";
import { sql } from "@/lib/ctx";
import { notifySlack } from "@/lib/alerts";
import { defineJob, type JobCtx } from "@/lib/job-runner";
import { rowsOf } from "@/lib/sensitive";
import { defineWebhookHandler } from "@/lib/webhooks";
import { processResendEvent, retrySoftBounce } from "./server/process-event";
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
];

export const webhookHandlers = [
  defineWebhookHandler({
    provider: "resend",
    handle: async (ctx, event) => {
      await processResendEvent(ctx, event);
    },
  }),
];
