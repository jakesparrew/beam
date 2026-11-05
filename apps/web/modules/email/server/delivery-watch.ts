/**
 * Delivery watch (email spec rule 38a; proposal SLA "emails not sending" is High), email-P7.
 * Every 5 minutes `email.watch_delivery` checks:
 *
 * - (a) `queued`: a transactional message still `queued` with `coalesce(send_at, queued_at)`
 *   more than 10 minutes ago (a future `send_at` is not due, so it never alerts);
 * - (b) `dead_sends`: 5 or more `email.send` jobs that ended `dead` or `failed` in the last 15
 *   minutes;
 * - (c) `not_sending`: no message sent in the last 60 minutes while 20 or more were queued in
 *   that hour.
 *
 * Each posts `notifySlack({ fingerprint: 'email:delivery:<check>', severity: 'high' })` and shows
 * the red "Email delivery problem" banner on `/admin/email`. (d) Failed emails (platform PL-75a):
 * messages that became `failed` (any error but `cancelled`) or `blocked_translation` in the last
 * 5 minutes post one `normal` alert per error, fingerprint `email:failed:<error>` (or
 * `email:failed:blocked_translation`), with the count and the template keys, never addresses.
 * Platform deduplicates per fingerprint per hour.
 *
 * `getEmailHealth(db, now)` returns the values of (a) to (d) for the daily digest, the System
 * page and the overview.
 */
import type { DbOrTx } from "@beam/db";
import { sql } from "@/lib/ctx";
import { notifySlack } from "@/lib/alerts";
import type { JobCtx } from "@/lib/job-runner";
import { rowsOf } from "@/lib/sensitive";

export const QUEUED_ALERT_MINUTES = 10;
export const DEAD_SENDS_WINDOW_MINUTES = 15;
export const DEAD_SENDS_THRESHOLD = 5;
export const SENT_WINDOW_MINUTES = 60;
export const QUEUED_IN_HOUR_THRESHOLD = 20;
export const FAILED_WINDOW_MINUTES = 5;

export type EmailHealth = { oldestQueuedMinutes: number | null; deadSends15m: number; sent60m: number; failed5m: number; blockedTranslation5m: number };
export type DeliveryCheck = "queued" | "dead_sends" | "not_sending";

const ago = (now: Date, minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();

type HealthRow = {
  oldest_due: string | Date | null;
  dead_sends: number;
  sent: number;
  queued_hour: number;
  failed: number;
  blocked: number;
};

async function healthRow(db: DbOrTx, now: Date): Promise<HealthRow> {
  const at = now.toISOString();
  const [row] = rowsOf<HealthRow>(
    await db.execute(sql`
      select
        (select min(coalesce(send_at, queued_at)) from email_messages
          where status = 'queued' and kind = 'transactional' and coalesce(send_at, queued_at) <= ${at}::timestamptz) as oldest_due,
        (select count(*)::int from jobs
          where kind = 'email.send' and status in ('dead', 'failed') and updated_at > ${ago(now, DEAD_SENDS_WINDOW_MINUTES)}::timestamptz) as dead_sends,
        (select count(*)::int from email_messages
          where sent_at > ${ago(now, SENT_WINDOW_MINUTES)}::timestamptz and sent_at <= ${at}::timestamptz) as sent,
        (select count(*)::int from email_messages
          where queued_at > ${ago(now, SENT_WINDOW_MINUTES)}::timestamptz and queued_at <= ${at}::timestamptz
            and coalesce(send_at, queued_at) <= ${at}::timestamptz) as queued_hour,
        (select count(*)::int from email_messages
          where status = 'failed' and coalesce(error, '') <> 'cancelled' and updated_at > ${ago(now, FAILED_WINDOW_MINUTES)}::timestamptz) as failed,
        (select count(*)::int from email_messages
          where status = 'blocked_translation' and updated_at > ${ago(now, FAILED_WINDOW_MINUTES)}::timestamptz) as blocked`),
  );
  return row!;
}

function healthOf(row: HealthRow, now: Date): EmailHealth {
  return {
    oldestQueuedMinutes: row.oldest_due ? Math.max(0, Math.floor((now.getTime() - new Date(row.oldest_due).getTime()) / 60_000)) : null,
    deadSends15m: Number(row.dead_sends),
    sent60m: Number(row.sent),
    failed5m: Number(row.failed),
    blockedTranslation5m: Number(row.blocked),
  };
}

export async function getEmailHealth(db: DbOrTx, now: Date = new Date()): Promise<EmailHealth> {
  return healthOf(await healthRow(db, now), now);
}

/** The failing checks (a) to (c) at `now`, and the health values. */
export async function deliveryProblems(db: DbOrTx, now: Date = new Date()): Promise<{ checks: DeliveryCheck[]; health: EmailHealth }> {
  const row = await healthRow(db, now);
  const health = healthOf(row, now);
  const checks: DeliveryCheck[] = [];
  if (row.oldest_due && new Date(row.oldest_due).getTime() < now.getTime() - QUEUED_ALERT_MINUTES * 60_000) checks.push("queued");
  if (health.deadSends15m >= DEAD_SENDS_THRESHOLD) checks.push("dead_sends");
  if (health.sent60m === 0 && Number(row.queued_hour) >= QUEUED_IN_HOUR_THRESHOLD) checks.push("not_sending");
  return { checks, health };
}

const CHECK_TEXT: Record<DeliveryCheck, (h: EmailHealth) => string> = {
  queued: (h) => `Email delivery problem: a transactional email has been waiting ${h.oldestQueuedMinutes} minutes to be sent.`,
  dead_sends: (h) => `Email delivery problem: ${h.deadSends15m} email sends failed permanently in the last ${DEAD_SENDS_WINDOW_MINUTES} minutes.`,
  not_sending: () => `Email delivery problem: no email was sent in the last ${SENT_WINDOW_MINUTES} minutes while ${QUEUED_IN_HOUR_THRESHOLD} or more were queued.`,
};

/** (d): failed and blocked messages of the last 5 minutes, grouped by error, with their template keys. */
async function recentFailures(db: DbOrTx, now: Date): Promise<{ error: string; count: number; templates: string[] }[]> {
  const rows = rowsOf<{ error: string; count: number; templates: string[] | null }>(
    await db.execute(sql`
      select case when m.status = 'blocked_translation' then 'blocked_translation' else coalesce(m.error, 'unknown') end as error,
        count(*)::int as count,
        array_remove(array_agg(distinct coalesce(t.slug, j.payload->>'template')), null) as templates
      from email_messages m
      left join email_template_versions v on v.id = m.template_version_id
      left join email_templates t on t.id = v.template_id
      left join jobs j on j.idempotency_key = 'email:' || m.id::text
      where m.updated_at > ${ago(now, FAILED_WINDOW_MINUTES)}::timestamptz
        and (m.status = 'blocked_translation' or (m.status = 'failed' and coalesce(m.error, '') <> 'cancelled'))
      group by 1 order by 1`),
  );
  return rows.map((r) => ({ error: r.error, count: Number(r.count), templates: [...(r.templates ?? [])].sort() }));
}

/** Fingerprints are `email:failed:<error>`; an error code is never personal data, but keep it a plain token. */
const errorToken = (error: string) => error.replace(/[^a-z0-9_:.-]/gi, "_").slice(0, 80);

export async function watchDelivery(ctx: JobCtx): Promise<{ checks: DeliveryCheck[]; failures: string[] }> {
  const { checks, health } = await deliveryProblems(ctx.tx, ctx.now);
  for (const check of checks) {
    await notifySlack(ctx, { fingerprint: `email:delivery:${check}`, severity: "high", text: `${CHECK_TEXT[check](health)} See /admin/email.` });
  }
  const failures = await recentFailures(ctx.tx, ctx.now);
  for (const f of failures) {
    const what = f.error === "blocked_translation" ? "were blocked for a missing translation" : `failed with ${errorToken(f.error)}`;
    await notifySlack(ctx, {
      fingerprint: `email:failed:${errorToken(f.error)}`,
      severity: "normal",
      text: `${f.count} email${f.count === 1 ? "" : "s"} ${what} in the last ${FAILED_WINDOW_MINUTES} minutes. Templates: ${f.templates.join(", ") || "unknown"}. See /admin/email/messages.`,
    });
  }
  return { checks, failures: failures.map((f) => f.error) };
}
