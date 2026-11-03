/**
 * Alerting (PL-29, PL-49, PL-73, PL-75, PL-85). `notifySlack()` is the one way to alert: it
 * enqueues `notify.slack` with key `slack:<fingerprint>:<YYYY-MM-DDTHH Brussels>`, so each
 * fingerprint sends at most one line per hour. `runCheckAlerts()` is `platform.check_alerts`.
 */
import type { DbOrTx } from "@beam/db";
import { localDateKey, localHourKey, wallClock } from "@beam/core/platform";
import type { JobKind } from "../registry/types.generated";
import { getBookingHealth, type BookingHealth } from "../modules/booking/api";
import { sql, type Ctx } from "./ctx";
import { appEnv, type Env } from "./integrations";
import { getSetting } from "./settings";
import { rowsOf } from "./sensitive";

export type AlertSeverity = "critical" | "high" | "normal";

export async function notifySlack(
  ctx: Ctx,
  input: { fingerprint: string; severity: AlertSeverity; text: string },
): Promise<{ jobId: string; inserted: boolean }> {
  const { id, inserted } = await ctx.enqueue({
    kind: "notify.slack" as JobKind,
    payload: { fingerprint: input.fingerprint, severity: input.severity, text: input.text },
    key: `slack:${input.fingerprint}:${localHourKey(ctx.now)}`,
  });
  return { jobId: id, inserted };
}

/**
 * A once-per-period guard for alerts that must not repeat hourly (AI 80 % once per month, the
 * pentest reminder once per day). Stored in `rate_limits` (no personal data), expiring after the period.
 */
export async function claimOnce(tx: DbOrTx, key: string, expiresAt: Date): Promise<boolean> {
  const rows = rowsOf<{ key: string }>(
    await tx.execute(sql`
      insert into rate_limits (key, window_start, count, expires_at) values (${key}, now(), 1, ${expiresAt.toISOString()}::timestamptz)
      on conflict (key) do nothing returning key`),
  );
  return rows.length > 0;
}

export const GB = 1024 ** 3;
export const ALERT_LIMITS = {
  backlog: 500,
  tickStaleMinutes: 3,
  signatureFailures: 5,
  providerFailures: 10,
  databaseBytes: 8 * GB,
  filesWarnBytes: 4 * GB,
  filesAlertBytes: 5 * GB,
  aiBudgetShare: 0.8,
  incidentNotifyHours: 20,
  pentestReminderDays: 7,
} as const;

const count = async (tx: DbOrTx, query: ReturnType<typeof sql>): Promise<number> =>
  Number(rowsOf<{ n: number | string | null }>(await tx.execute(query))[0]?.n ?? 0);

export const databaseSizeBytes = (tx: DbOrTx) => count(tx, sql`select pg_database_size(current_database())::bigint as n`);
export const filesSizeBytes = (tx: DbOrTx) => count(tx, sql`select coalesce(sum(size_bytes), 0)::bigint as n from files`);

/** Brussels month spend of `ai_requests` in cents. */
export const aiSpendThisMonthCents = (tx: DbOrTx) =>
  count(
    tx,
    sql`select coalesce(sum(cost_cents), 0)::float8 as n from ai_requests
        where created_at >= (date_trunc('month', now() at time zone 'Europe/Brussels') at time zone 'Europe/Brussels')`,
  );

/** PL-49: the daily digest line for the total files size. */
export function filesSizeLevel(bytes: number): "ok" | "warn" | "alert" {
  if (bytes > ALERT_LIMITS.filesAlertBytes) return "alert";
  if (bytes > ALERT_LIMITS.filesWarnBytes) return "warn";
  return "ok";
}

export type CheckAlertsDeps = {
  databaseSizeBytes?: (tx: DbOrTx) => Promise<number>;
  filesSizeBytes?: (tx: DbOrTx) => Promise<number>;
  bookingHealth?: (db: DbOrTx) => Promise<BookingHealth>;
  appEnv?: string;
};

type Raised = { fingerprint: string; severity: AlertSeverity; text: string };

/** `platform.check_alerts` (PL-75): enqueues one `notify.slack` per raised fingerprint (hourly dedupe). Returns what it raised. */
export async function runCheckAlerts(ctx: Ctx, deps: CheckAlertsDeps = {}): Promise<Raised[]> {
  const tx = ctx.tx;
  const env = deps.appEnv ?? appEnv();
  const raised: Raised[] = [];
  const raise = (fingerprint: string, severity: AlertSeverity, text: string) => raised.push({ fingerprint, severity, text });

  const backlog = await count(tx, sql`select count(*)::int as n from jobs where status = 'pending'`);
  if (backlog > ALERT_LIMITS.backlog) raise("job-backlog", "high", `Job backlog is ${backlog} pending jobs (limit ${ALERT_LIMITS.backlog}).`);

  if (env === "staging" || env === "production") {
    const last = (await getSetting(tx, "last_tick_at")) as string | null;
    const ageMs = last ? ctx.now.getTime() - new Date(last).getTime() : Number.POSITIVE_INFINITY;
    if (ageMs > ALERT_LIMITS.tickStaleMinutes * 60_000) raise("tick-stale", "critical", "The one-minute tick has not run for more than 3 minutes.");
  }

  const sigs = rowsOf<{ provider: string; n: number | string }>(
    await tx.execute(sql`
      select provider::text as provider, count(*)::int as n from integration_calls
      where operation = 'webhook.signature_failed' and created_at > now() - interval '10 minutes' group by provider`),
  );
  for (const s of sigs) {
    if (Number(s.n) > ALERT_LIMITS.signatureFailures) {
      raise(`webhook-signature-${s.provider}`, "high", `${s.n} ${s.provider} webhook signature failures in 10 minutes.`);
    }
  }

  const mollieEvents = await count(tx, sql`select count(*)::int as n from webhook_events where provider = 'mollie' and received_at > now() - interval '24 hours'`);
  if (mollieEvents === 0) {
    const onlineOrders = await count(
      tx,
      sql`select count(*)::int as n from orders where channel::text in ('portal', 'site', 'link') and created_at > now() - interval '24 hours'`,
    );
    if (onlineOrders > 0) raise("mollie-silence", "high", `No Mollie webhook in 24 hours while ${onlineOrders} online order(s) were created.`);
  }

  const down = rowsOf<{ provider: string; failed: number | string }>(
    await tx.execute(sql`
      select provider::text as provider, count(*) filter (where not ok)::int as failed, count(*) filter (where ok)::int as succeeded
      from integration_calls where created_at > now() - interval '60 minutes' and operation <> 'webhook.signature_failed'
      group by provider having count(*) filter (where not ok) >= ${ALERT_LIMITS.providerFailures} and count(*) filter (where ok) = 0`),
  );
  for (const d of down) raise(`provider-down-${d.provider}`, "high", `${d.provider}: ${d.failed} failed calls and none succeeded in the last 60 minutes.`);

  const dbSize = await (deps.databaseSizeBytes ?? databaseSizeBytes)(tx);
  if (dbSize > ALERT_LIMITS.databaseBytes) raise("database-size", "normal", `Database size is ${(dbSize / GB).toFixed(1)} GB (above 8 GB).`);

  const ai = (await getSetting(tx, "ai")) as { monthly_budget_cents?: number };
  const budget = Number(ai.monthly_budget_cents ?? 0);
  if (budget > 0) {
    const spend = await aiSpendThisMonthCents(tx);
    if (spend > budget * ALERT_LIMITS.aiBudgetShare) {
      const w = wallClock(ctx.now);
      const month = `${w.year}-${String(w.month).padStart(2, "0")}`;
      const nextMonth = new Date(Date.UTC(w.month === 12 ? w.year + 1 : w.year, w.month % 12, 2));
      if (await claimOnce(tx, `alert:ai-budget-80:${month}`, nextMonth)) {
        raise(`ai-budget-80-${month}`, "normal", `AI spend this month is above 80 % of the budget (${Math.round(spend)} of ${budget} cents).`);
      }
    }
  }

  const filesSize = await (deps.filesSizeBytes ?? filesSizeBytes)(tx);
  if (filesSizeLevel(filesSize) === "alert") raise("files-size", "high", `Stored files total ${(filesSize / GB).toFixed(1)} GB (above 5 GB); move bytes to object storage.`);

  const incidents = rowsOf<{ id: string; title: string }>(
    await tx.execute(sql`
      select id::text as id, title from security_incidents
      where beam_notified_at is null and status <> 'resolved' and discovered_at < now() - make_interval(hours => ${ALERT_LIMITS.incidentNotifyHours})`),
  );
  for (const i of incidents) raise(`incident-notify-${i.id}`, "critical", `Security incident ${i.id} is older than 20 hours and BEAM is not notified yet (limit 24 hours).`);

  const breaches = rowsOf<{ reference: string; severity: string }>(
    await tx.execute(sql`
      select reference, severity::text as severity from support_requests
      where first_response_at is null and status = 'open' and severity in ('critical', 'high') and response_due_at < now()`),
  );
  for (const b of breaches) raise(`support-breach-${b.reference}`, b.severity === "critical" ? "critical" : "high", `Support request ${b.reference} (${b.severity}) is past its response time.`);

  const security = (await getSetting(tx, "security")) as { next_pentest_due_on?: string | null };
  if (security.next_pentest_due_on) {
    const due = new Date(`${security.next_pentest_due_on}T00:00:00Z`).getTime();
    if (due - ctx.now.getTime() <= ALERT_LIMITS.pentestReminderDays * 86_400_000) {
      const day = localDateKey(wallClock(ctx.now));
      if (await claimOnce(tx, `alert:pentest-due:${day}`, new Date(ctx.now.getTime() + 2 * 86_400_000))) {
        raise("pentest-due", "normal", `The quarterly security test is due on ${security.next_pentest_due_on}.`);
      }
    }
  }

  let health: BookingHealth | null;
  try {
    // In a savepoint: a failing booking query must not abort the alert transaction.
    health = await ctx.tx.transaction((sp) => (deps.bookingHealth ?? getBookingHealth)(sp));
  } catch {
    health = null;
  }
  if (health?.level === "alert") {
    raise("booking-health", "high", `Booking health is alert: materialised through ${health.materialisedThroughOn}, ${health.overdueOffers} overdue offers, ${health.overdueReservations} overdue reservations, ${health.unsentConfirmations24h} unsent confirmations.`);
  }

  for (const r of raised) await notifySlack(ctx, r);
  return raised;
}

// ---------------------------------------------------------------------------
// Health (PL-74), used by /api/health
// ---------------------------------------------------------------------------

export type BookingCheck = BookingHealth | { level: "unknown" };

export type HealthReport = {
  status: "ok" | "degraded" | "error";
  version: string;
  checks: {
    database: { ok: boolean; latencyMs: number; error?: string };
    tick: { ok: boolean; lastTickAt: string | null; ageSeconds: number | null; enforced: boolean };
    jobs: { ok: boolean; pending: number };
    config: { ok: boolean; problems: string[] };
    booking: BookingCheck;
  };
};

const timeout = <T>(work: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([work, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out`)), ms).unref?.())]);

/** The production configuration check of PL-74 and PL-83 (names of problems only, never values). */
export function configProblems(env: Env, currentKeyVersion: number): string[] {
  if (appEnv(env) !== "production") return [];
  const problems: string[] = [];
  const key = env[`SENSITIVE_DATA_KEY_V${currentKeyVersion}`];
  if (!key || Buffer.from(key, "base64").length !== 32) problems.push(`SENSITIVE_DATA_KEY_V${currentKeyVersion} missing`);
  if (env.EMAIL_SINK) problems.push("EMAIL_SINK set");
  if (env.PAYMENTS_FAKE === "1") problems.push("PAYMENTS_FAKE=1");
  if (env.INTEGRATIONS === "fake") problems.push("INTEGRATIONS=fake");
  if (env.MOLLIE_API_KEY?.startsWith("test_")) problems.push("MOLLIE_API_KEY is a test key");
  if (!env.DATABASE_URL || !/[?&]sslmode=require\b/.test(env.DATABASE_URL)) problems.push("DATABASE_URL without sslmode=require");
  return problems;
}

/** Builds the health body; the route returns 503 when `status` is `error`. Never personal data. */
export async function healthReport(
  db: DbOrTx,
  opts: { env?: Env; bookingHealth?: (db: DbOrTx) => Promise<BookingHealth>; now?: Date } = {},
): Promise<HealthReport> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? new Date();
  const started = Date.now();
  let database: HealthReport["checks"]["database"];
  let pending = 0;
  let lastTickAt: string | null = null;
  let keyVersion = 1;
  try {
    await timeout(db.execute(sql`select 1`), 5000, "database");
    database = { ok: true, latencyMs: Date.now() - started };
    pending = await count(db, sql`select count(*)::int as n from jobs where status = 'pending'`);
    lastTickAt = (await getSetting(db, "last_tick_at")) as string | null;
    keyVersion = ((await getSetting(db, "security")) as { current_key_version?: number }).current_key_version ?? 1;
  } catch (error) {
    database = { ok: false, latencyMs: Date.now() - started, error: error instanceof Error ? error.message.slice(0, 200) : "error" };
  }

  const mode = appEnv(env);
  const enforced = mode === "staging" || mode === "production";
  const ageSeconds = lastTickAt ? Math.round((now.getTime() - new Date(lastTickAt).getTime()) / 1000) : null;
  const tickOk = !enforced || (ageSeconds !== null && ageSeconds <= 180);
  const jobsOk = pending <= ALERT_LIMITS.backlog;
  const problems = configProblems(env, keyVersion);

  let booking: BookingCheck;
  try {
    booking = await timeout((opts.bookingHealth ?? getBookingHealth)(db), 2000, "booking health");
  } catch {
    booking = { level: "unknown" };
  }

  const failing = !database.ok || !tickOk || !jobsOk || problems.length > 0;
  const status = failing ? "error" : booking.level === "warn" || booking.level === "alert" ? "degraded" : "ok";
  return {
    status,
    version: env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) ?? env.npm_package_version ?? "dev",
    checks: {
      database,
      tick: { ok: tickOk, lastTickAt, ageSeconds, enforced },
      jobs: { ok: jobsOk, pending },
      config: { ok: problems.length === 0, problems },
      booking,
    },
  };
}
