/**
 * Platform jobs (platform spec 4.5). Facade read by `pnpm gen:indexes`. Every handler is
 * idempotent: a second run with the same payload leaves the same state (`jobs.test.ts`).
 */
import { z } from "zod";
import { monthlyReports, webhookEvents, type MonthlyReportData } from "@beam/db/schema";
import { PermanentError } from "@beam/core/errors";
import { wallClock } from "@beam/core/platform";
import { eq, sql, type DbOrTx } from "@/lib/ctx";
import { runCheckAlerts, filesSizeBytes, databaseSizeBytes } from "@/lib/alerts";
import { purgeExpiredFiles } from "@/lib/files";
import { defineJob, pruneJobs, type JobCtx } from "@/lib/job-runner";
import { rowsOf } from "@/lib/sensitive";
import { rekeyChunk, REKEY_TABLES, type RekeyTable } from "@/lib/sensitive";
import type { WebhookHandlerDefinition } from "@/lib/webhooks";

// ---------------------------------------------------------------------------
// webhook.process
// ---------------------------------------------------------------------------

let handlers: Promise<Readonly<Record<string, WebhookHandlerDefinition | undefined>>> | undefined;
const loadHandlers = () =>
  (handlers ??= import("@/registry/webhooks.generated").then(
    (m) => ((m as { WEBHOOK_HANDLERS?: unknown }).WEBHOOK_HANDLERS ?? {}) as Readonly<Record<string, WebhookHandlerDefinition | undefined>>,
  ));

async function processWebhook(ctx: JobCtx, input: { webhookEventId: string }): Promise<{ provider: string }> {
  const [event] = await ctx.tx
    .select({ id: webhookEvents.id, provider: webhookEvents.provider, payload: webhookEvents.payload })
    .from(webhookEvents)
    .where(eq(webhookEvents.id, input.webhookEventId));
  if (!event) throw new PermanentError(`webhook_event_not_found: ${input.webhookEventId}`);
  const handler = (await loadHandlers())[event.provider];
  if (!handler) throw new PermanentError(`no_webhook_handler: ${event.provider}`);
  await handler.handle(ctx, { id: event.id, payload: event.payload });
  return { provider: event.provider };
}

// ---------------------------------------------------------------------------
// notify.slack
// ---------------------------------------------------------------------------

const SEVERITY_PREFIX = { critical: ":rotating_light: CRITICAL", high: ":warning: HIGH", normal: ":information_source:" } as const;

async function postSlack(ctx: JobCtx, input: { fingerprint: string; severity: "critical" | "high" | "normal"; text: string }): Promise<{ sent: true }> {
  // The job key is the dedupe suffix, so a duplicate post is recognisable in the channel.
  await ctx.integrations.slack.postMessage({ text: `${SEVERITY_PREFIX[input.severity]} ${input.text} (${ctx.job.key})` });
  return { sent: true };
}

// ---------------------------------------------------------------------------
// platform.prune_ephemeral
// ---------------------------------------------------------------------------

async function pruneEphemeral(ctx: JobCtx): Promise<{ sessions: number; tokens: number; rateLimits: number }> {
  const n = async (q: ReturnType<typeof sql>) => rowsOf(await ctx.tx.execute(q)).length;
  const sessions = await n(sql`delete from auth_sessions where expires_at < now() or absolute_expires_at < now() returning id`);
  const tokens = await n(sql`delete from auth_verification_tokens where expires_at < now() returning identifier`);
  const rateLimits = await n(sql`delete from rate_limits where expires_at < now() returning key`);
  return { sessions, tokens, rateLimits };
}

// ---------------------------------------------------------------------------
// security.rekey (PL-70)
// ---------------------------------------------------------------------------

async function rekey(ctx: JobCtx, input: { toVersion: number; table: RekeyTable; afterId?: string }): Promise<{ rows: number; next: string | null }> {
  const { rows, lastId, done } = await rekeyChunk(ctx.tx, input);
  let next: string | null = null;
  if (!done && lastId) {
    next = `rekey:${input.toVersion}:${input.table}:${lastId}`;
    await ctx.enqueue({ kind: "security.rekey", payload: { toVersion: input.toVersion, table: input.table, afterId: lastId }, key: next });
  } else {
    const following = REKEY_TABLES[REKEY_TABLES.indexOf(input.table) + 1];
    if (following) {
      next = `rekey:${input.toVersion}:${following}:start`;
      await ctx.enqueue({ kind: "security.rekey", payload: { toVersion: input.toVersion, table: following }, key: next });
    }
  }
  return { rows, next };
}

// ---------------------------------------------------------------------------
// platform.build_monthly_report (PL-89)
// ---------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, "0");

/** The first day of the previous Brussels month, `YYYY-MM-01`. */
export function previousMonthOn(now: Date): string {
  const w = wallClock(now);
  const year = w.month === 1 ? w.year - 1 : w.year;
  const month = w.month === 1 ? 12 : w.month - 1;
  return `${year}-${pad(month)}-01`;
}

const num = (v: unknown) => Number(v ?? 0);

async function collectReport(tx: DbOrTx, ctx: JobCtx, monthOn: string): Promise<MonthlyReportData> {
  const range = sql`(${monthOn}::date at time zone 'Europe/Brussels')`;
  const rangeEnd = sql`((${monthOn}::date + interval '1 month') at time zone 'Europe/Brussels')`;
  const one = async <T>(q: ReturnType<typeof sql>) => rowsOf<T>(await tx.execute(q))[0];

  const incidents = await one<{ critical: number; high: number; normal: number }>(sql`
    select count(*) filter (where severity = 'critical')::int as critical, count(*) filter (where severity = 'high')::int as high,
           count(*) filter (where severity = 'normal')::int as normal
    from security_incidents where discovered_at >= ${range} and discovered_at < ${rangeEnd}`);

  const perSeverity = rowsOf<{ severity: string; received: number; resolved: number; median: number | null; breaches: number }>(
    await tx.execute(sql`
      select severity::text as severity, count(*)::int as received,
             count(*) filter (where resolved_at is not null)::int as resolved,
             percentile_cont(0.5) within group (order by first_response_minutes) as median,
             count(*) filter (where is_breached)::int as breaches
      from v_support_sla where received_at >= ${range} and received_at < ${rangeEnd} group by severity`),
  );
  const empty = { received: 0, resolved: 0, median_first_response_minutes: null as number | null, breaches: 0 };
  const support: MonthlyReportData["support"]["per_severity"] = { critical: { ...empty }, high: { ...empty }, normal: { ...empty }, improvement: { ...empty } };
  for (const s of perSeverity) {
    support[s.severity as keyof typeof support] = {
      received: num(s.received),
      resolved: num(s.resolved),
      median_first_response_minutes: s.median === null ? null : Math.round(num(s.median)),
      breaches: num(s.breaches),
    };
  }

  const deadJobs = await one<{ n: number }>(sql`select count(*)::int as n from jobs where status = 'dead' and finished_at >= ${range} and finished_at < ${rangeEnd}`);
  const alerts = await one<{ n: number }>(sql`select count(*)::int as n from integration_calls where provider = 'slack' and ok and created_at >= ${range} and created_at < ${rangeEnd}`);
  const backups = await one<{ ok: number; failed: number }>(sql`
    select count(*) filter (where (new_value->>'ok')::boolean)::int as ok, count(*) filter (where not coalesce((new_value->>'ok')::boolean, false))::int as failed
    from audit_log where action = 'backup.completed' and created_at >= ${range} and created_at < ${rangeEnd}`);
  const drill = await one<{ at: string; ok: boolean | null }>(sql`
    select created_at::text as at, (new_value->>'ok')::boolean as ok from audit_log
    where action = 'restore_drill.completed' and created_at < ${rangeEnd} order by created_at desc limit 1`);
  const ai = await one<{ cents: number }>(sql`select coalesce(sum(cost_cents), 0)::float8 as cents from ai_requests where created_at >= ${range} and created_at < ${rangeEnd}`);

  const to = new Date(`${monthOn}T00:00:00Z`);
  to.setUTCMonth(to.getUTCMonth() + 1);
  to.setUTCDate(0);
  // A failure throws (IntegrationError, retryable): the job retries, then the owner enters uptime by hand.
  const sla = await ctx.integrations.betterstack.getMonitorSla({ monitorId: process.env.BETTERSTACK_MONITOR_ID ?? "health", from: monthOn, to: to.toISOString().slice(0, 10) });
  const uptimePct = sla.availabilityPct;
  const downtimeMinutes = Math.round(sla.downtimeSeconds / 60);
  const source: MonthlyReportData["uptime_source"] = "betterstack";

  return {
    uptime_pct: uptimePct,
    downtime_minutes: downtimeMinutes,
    uptime_source: source,
    incidents: { critical: num(incidents?.critical), high: num(incidents?.high), normal: num(incidents?.normal) },
    support: { per_severity: support },
    dead_jobs: num(deadJobs?.n),
    alerts_sent: num(alerts?.n),
    backups_ok: num(backups?.ok),
    backups_failed: num(backups?.failed),
    restore_drill: drill ? { at: drill.at, ok: !!drill.ok } : null,
    ai_spend_cents: Math.round(num(ai?.cents) * 10_000) / 10_000,
    db_size_bytes: await databaseSizeBytes(tx),
    files_size_bytes: await filesSizeBytes(tx),
  };
}

async function buildMonthlyReport(ctx: JobCtx, input: { monthOn?: string }): Promise<{ monthOn: string; skipped: boolean }> {
  const monthOn = input.monthOn ?? previousMonthOn(ctx.now);
  const [existing] = await ctx.tx.select({ status: monthlyReports.status }).from(monthlyReports).where(eq(monthlyReports.monthOn, monthOn));
  if (existing?.status === "sent") return { monthOn, skipped: true };
  const data = await collectReport(ctx.tx, ctx, monthOn);
  await ctx.tx
    .insert(monthlyReports)
    .values({ monthOn, data })
    .onConflictDoUpdate({ target: monthlyReports.monthOn, set: { data, updatedAt: sql`now()` }, setWhere: sql`${monthlyReports.status} = 'draft'` });
  return { monthOn, skipped: false };
}

// ---------------------------------------------------------------------------
// Registrations
// ---------------------------------------------------------------------------

export const jobs = [
  defineJob({ kind: "webhook.process", lane: "fast", priority: 2, input: z.object({ webhookEventId: z.string().uuid() }), run: processWebhook }),
  defineJob({
    kind: "notify.slack",
    lane: "fast",
    priority: 5,
    maxAttempts: 4,
    input: z.object({ fingerprint: z.string().min(1), severity: z.enum(["critical", "high", "normal"]), text: z.string().min(1).max(3000) }),
    run: postSlack,
  }),
  defineJob({ kind: "jobs.prune", lane: "bulk", priority: 9, timeoutMs: 55_000, input: z.object({}).passthrough(), run: async (ctx) => ({ deleted: await pruneJobs(ctx.tx) }) }),
  defineJob({ kind: "files.purge_expired", lane: "bulk", priority: 9, input: z.object({}).passthrough(), run: async (ctx) => ({ deleted: await purgeExpiredFiles(ctx.tx) }) }),
  defineJob({
    kind: "platform.check_alerts",
    lane: "fast",
    priority: 4,
    maxAttempts: 2,
    input: z.object({}).passthrough(),
    run: async (ctx) => ({ raised: (await runCheckAlerts(ctx)).map((r) => r.fingerprint) }),
  }),
  defineJob({ kind: "platform.prune_ephemeral", lane: "bulk", priority: 9, input: z.object({}).passthrough(), run: pruneEphemeral }),
  defineJob({
    kind: "security.rekey",
    lane: "bulk",
    priority: 9,
    input: z.object({ toVersion: z.number().int().min(2), table: z.enum(REKEY_TABLES), afterId: z.string().optional() }),
    run: rekey,
  }),
  defineJob({
    kind: "platform.build_monthly_report",
    lane: "bulk",
    priority: 5,
    input: z.object({ monthOn: z.string().regex(/^\d{4}-\d{2}-01$/).optional() }).passthrough(),
    run: buildMonthlyReport,
  }),
];
