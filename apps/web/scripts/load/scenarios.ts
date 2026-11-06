/**
 * The four load scenarios of the proposal (section 5) and platform spec platform-P11, run by
 * `pnpm test:load` (`scripts/load-test.ts`) against `beam_dev` with the demo seed at the wave 11
 * checkpoint and against staging before go-live. Never against production, never in CI and
 * never by a coding agent.
 *
 * 1. `portal_booking`: 100 concurrent visitors on `/nl/account/book` (signed in as a demo
 *    customer; the page runs the availability query) for 60 s: p95 below 800 ms, no 5xx.
 * 2. `magic_links`: 50 concurrent `requestMagicLink` calls from distinct addresses; every
 *    `email.send` job they queue has succeeded within 2 minutes.
 * 3. `email_drain`: 5,000 queued `email.send` jobs are drained by the tick within 15 minutes.
 * 4. `campaign_send`: a 20,000-recipient campaign is planned and sent on the fake Resend
 *    adapter within 15 minutes.
 *
 * Scenarios 2 to 4 run in this process on the given database. With `driveTick` (the default of
 * `load-test.ts`) this process runs the tick itself with the integrations it is given (the
 * fakes), back to back, the way the cron route does once a minute; without it the scenario only
 * polls and the deployed cron tick does the work. Every row the scenarios create uses
 * `@demo.beam.be` addresses with the run id (`load-<run>-...`), `is_tester = true`, and is left
 * in place (persons are never deleted, data model rule 5).
 *
 * The counts can be lowered (`counts`) for a smoke run; a result then says `reduced` and never
 * counts as a proposal run in the report.
 */
import autocannon from "autocannon";
import type { Db } from "@beam/db";
import { campaignRecipients, campaigns, consentRecords, emailMessages, emailTemplates, jobs, persons, segmentMembers, segments, users } from "@beam/db/schema";
import { emailHash } from "@beam/core/crm";
import { addDays, brusselsDate } from "@beam/core/booking";
import { sessionCookieName } from "@/lib/auth-config";
import { createAuthSession, deleteSessionByToken } from "@/lib/auth";
import { and, asc, createCtx, eq, flushDurableWrites, flushIntegrationLog, inArray, sql, type Ctx } from "@/lib/ctx";
import type { Integrations } from "@/lib/integrations";
import { runTick } from "@/lib/job-runner";
import { rowsOf } from "@/lib/sensitive";
import { seedTemplate, sendTransactional } from "@/modules/email/api";
import { requestMagicLink } from "@/modules/platform/actions";
import { SCENARIO_KEYS, SCENARIO_TITLES, THRESHOLD_TEXT, THRESHOLDS, type Metric, type ScenarioKey, type ScenarioResult } from "./report";

// The keys, thresholds and result shape live in report.ts, which imports no module code (so
// load-test.ts and report.ts load without the server-only stub).
export { SCENARIO_KEYS, SCENARIO_TITLES, THRESHOLD_TEXT, THRESHOLDS, type Metric, type ScenarioKey, type ScenarioResult };

export type ScenarioCounts = Partial<{ connections: number; durationSec: number; magicLinks: number; drainJobs: number; recipients: number }>;

export type ScenarioEnv = {
  db: Db;
  integrations: Integrations;
  /** Short lower-case id of this run (`[a-z0-9]{4,12}`), part of every address and key. */
  runId: string;
  /** The deployment for scenario 1 (`http://localhost:3000`, the staging URL). */
  baseUrl?: string | undefined;
  /** Run the tick in this process (default `true` in `load-test.ts`). */
  driveTick: boolean;
  /** One tick; defaults to `runTick` with `db` and `integrations`. */
  tick?: (budgetMs: number) => Promise<unknown>;
  tickBudgetMs?: number;
  pollMs?: number;
  counts?: ScenarioCounts;
  /** Time limits instead of the proposal's (tests only). */
  limits?: Partial<Record<ScenarioKey, number>>;
  log?: (line: string) => void;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const fmtMs = (ms: number) => (ms >= 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);
const SYSTEM_ACTOR = (runId: string) => ({ kind: "system" as const, jobId: `load-test:${runId}` });

/** The p-th percentile (nearest rank) of the values. */
export function percentile(values: readonly number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}

/** A demo address of this run: `load-<run>-<kind>-<n>@demo.beam.be`. */
export const loadAddress = (runId: string, kind: string, n: number): string => `load-${runId}-${kind}-${n}@demo.beam.be`;

/** Runs `work` in one transaction with a system ctx and flushes its durable writes. */
async function inSystemTx<T>(env: ScenarioEnv, label: string, work: (ctx: Ctx) => Promise<T>): Promise<T> {
  let ctx: Ctx | undefined;
  const requestId = `load-test:${env.runId}:${label}`;
  const out = await env.db.transaction(async (tx) => {
    ctx = createCtx({ tx, actor: SYSTEM_ACTOR(env.runId), requestId });
    return work(ctx);
  });
  if (ctx) {
    await flushDurableWrites(env.db, ctx);
    await flushIntegrationLog(env.db, ctx);
  }
  return out;
}

/**
 * Runs ticks (or waits for the deployed one) until `done()` or the limit. Returns whether it
 * finished and the elapsed time since `startedAt`.
 */
export async function drainUntil(env: ScenarioEnv, startedAt: number, limitMs: number, done: () => Promise<boolean>): Promise<{ finished: boolean; elapsedMs: number; ticks: number }> {
  let ticks = 0;
  const tick = env.tick ?? ((budgetMs: number) => runTick({ db: env.db, integrations: env.integrations, budgetMs }));
  for (;;) {
    if (await done()) return { finished: true, elapsedMs: Date.now() - startedAt, ticks };
    const left = limitMs - (Date.now() - startedAt);
    if (left <= 0) return { finished: false, elapsedMs: Date.now() - startedAt, ticks };
    if (env.driveTick) {
      await tick(Math.max(1_000, Math.min(env.tickBudgetMs ?? 50_000, left)));
      ticks += 1;
    } else {
      await sleep(Math.min(env.pollMs ?? 5_000, left));
    }
  }
}

type StatusCount = { status: string; n: number };

/** Job counts by status for the given job ids (in slices, so 20,000 ids stay within the parameter limit). */
export async function jobStatusCounts(db: Db, ids: readonly string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (let i = 0; i < ids.length; i += 5_000) {
    const rows = await db
      .select({ status: jobs.status, n: sql<number>`count(*)::int` })
      .from(jobs)
      .where(inArray(jobs.id, ids.slice(i, i + 5_000)))
      .groupBy(jobs.status);
    for (const r of rows as StatusCount[]) out[r.status] = (out[r.status] ?? 0) + Number(r.n);
  }
  return out;
}

const countsText = (c: Record<string, number>) =>
  Object.entries(c)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k} ${v}`)
    .join(", ") || "none";

function result(env: ScenarioEnv, key: ScenarioKey, started: number, outcome: ScenarioResult["outcome"], metrics: Metric[], reduced: boolean, note?: string): ScenarioResult {
  const r: ScenarioResult = {
    key,
    title: SCENARIO_TITLES[key],
    threshold: THRESHOLD_TEXT[key],
    outcome,
    reduced,
    metrics,
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
  };
  if (note) r.note = note;
  env.log?.(`${key}: ${outcome}${reduced ? " (reduced)" : ""}${note ? ` - ${note}` : ""}`);
  return r;
}

// ---------------------------------------------------------------------------
// 1. portal_booking: HTTP load on the booking page (autocannon)
// ---------------------------------------------------------------------------

/** The paths the visitors cycle through: the default tab and three tab/day combinations. */
export function bookingPaths(now: Date): string[] {
  const today = brusselsDate(now);
  return ["/nl/account/book", `/nl/account/book?tab=day&day=${addDays(today, 1)}`, `/nl/account/book?tab=night&day=${addDays(today, 2)}`, "/nl/account/book?tab=event"];
}

export async function portalBooking(env: ScenarioEnv): Promise<ScenarioResult> {
  const started = Date.now();
  const t = THRESHOLDS.portal_booking;
  const connections = env.counts?.connections ?? t.connections;
  const durationSec = env.counts?.durationSec ?? t.durationSec;
  const reduced = connections < t.connections || durationSec < t.durationSec;
  if (!env.baseUrl) return result(env, "portal_booking", started, "skipped", [], reduced, "BASE_URL is not set");
  const [customer] = await env.db
    .select({ id: users.id })
    .from(users)
    // The demo seed's customer users are testers at customerN@example.com (platform seed), not @demo.beam.be.
    .where(and(eq(users.audience, "customer"), eq(users.status, "active"), eq(users.isTester, true)))
    .orderBy(asc(users.createdAt))
    .limit(1);
  if (!customer) return result(env, "portal_booking", started, "skipped", [], reduced, "no active demo customer: run pnpm seed:demo first");
  const { token } = await createAuthSession(env.db, { userId: customer.id, audience: "customer", roleKey: null, now: new Date(), userAgent: "beam-load-test" });
  const cookie = `${sessionCookieName({ APP_URL: env.baseUrl })}=${token}`;
  const latencies: number[] = [];
  const statuses = new Map<number, number>();
  let res: autocannon.Result;
  try {
    res = await new Promise<autocannon.Result>((resolve, reject) => {
      const instance = autocannon(
        {
          url: env.baseUrl!,
          connections,
          duration: durationSec,
          timeout: 10,
          headers: { cookie, "user-agent": "beam-load-test" },
          requests: bookingPaths(new Date()).map((p) => ({ method: "GET" as const, path: p })),
        },
        (error: unknown, r: autocannon.Result) => (error ? reject(error instanceof Error ? error : new Error(JSON.stringify(error))) : resolve(r)),
      );
      instance.on("response", (_client, status, _bytes, ms) => {
        latencies.push(ms);
        statuses.set(status, (statuses.get(status) ?? 0) + 1);
      });
    });
  } finally {
    await deleteSessionByToken(env.db, token);
  }
  const p95 = percentile(latencies, 95);
  const fiveXx = res["5xx"];
  const pass = latencies.length > 0 && p95 < t.p95Ms && fiveXx === 0 && res.non2xx === 0 && res.errors === 0 && res.timeouts === 0;
  const metrics: Metric[] = [
    { label: "Connections / duration", value: `${connections} / ${durationSec} s` },
    { label: "Responses", value: String(latencies.length) },
    { label: "Throughput", value: `${Math.round(res.requests.average)} req/s` },
    { label: "p50 / p95 / p99", value: `${fmtMs(percentile(latencies, 50))} / ${fmtMs(p95)} / ${fmtMs(percentile(latencies, 99))}` },
    { label: "5xx", value: String(fiveXx) },
    { label: "Other non-2xx (a redirect means the session was not accepted)", value: String(res.non2xx - fiveXx) },
    { label: "Errors / timeouts", value: `${res.errors} / ${res.timeouts}` },
    { label: "Status codes", value: [...statuses].sort(([a], [b]) => a - b).map(([s, c]) => `${s}: ${c}`).join(", ") || "none" },
  ];
  return result(env, "portal_booking", started, pass ? "pass" : "fail", metrics, reduced);
}

// ---------------------------------------------------------------------------
// 2. magic_links: concurrent requestMagicLink and their email.send jobs
// ---------------------------------------------------------------------------

/** Job counts of the `email.send` jobs of the messages to these addresses. */
async function sendJobCountsFor(db: Db, addresses: readonly string[]): Promise<Record<string, number>> {
  const rows = rowsOf<StatusCount>(
    await db.execute(sql`
      select j.status::text as status, count(*)::int as n
      from email_messages m join jobs j on j.idempotency_key = 'email:' || m.id::text
      where lower(m.to_email) in (${sql.join(addresses.map((a) => sql`${a.toLowerCase()}`), sql`, `)})
      group by j.status`),
  );
  return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
}

export async function magicLinks(env: ScenarioEnv): Promise<ScenarioResult> {
  const started = Date.now();
  const t = THRESHOLDS.magic_links;
  const n = env.counts?.magicLinks ?? t.requests;
  const limit = env.limits?.magic_links ?? t.withinMs;
  const addresses = Array.from({ length: n }, (_, i) => loadAddress(env.runId, "ml", i));
  const outcomes = await Promise.all(addresses.map((email) => requestMagicLink({ email, locale: "nl-BE" })));
  const failedCalls = outcomes.filter((o) => !o.ok).length;
  const requestMs = Date.now() - started;
  let counts: Record<string, number> = {};
  const drained = await drainUntil(env, started, limit, async () => {
    counts = await sendJobCountsFor(env.db, addresses);
    return (counts.succeeded ?? 0) + (counts.dead ?? 0) >= n;
  });
  const pass = failedCalls === 0 && drained.finished && (counts.succeeded ?? 0) === n && drained.elapsedMs <= limit;
  return result(env, "magic_links", started, pass ? "pass" : "fail", [
    { label: "Requests (failed)", value: `${n} (${failedCalls})` },
    { label: "All requests answered after", value: fmtMs(requestMs) },
    { label: "email.send jobs", value: countsText(counts) },
    { label: "Last job succeeded after", value: drained.finished ? fmtMs(drained.elapsedMs) : `not within ${fmtMs(limit)}` },
    { label: "Ticks run here", value: String(drained.ticks) },
  ], n < t.requests);
}

// ---------------------------------------------------------------------------
// 3. email_drain: 5,000 queued email.send jobs
// ---------------------------------------------------------------------------

const ENQUEUE_BATCH = 250;

export async function emailDrain(env: ScenarioEnv): Promise<ScenarioResult> {
  const started = Date.now();
  const t = THRESHOLDS.email_drain;
  const n = env.counts?.drainJobs ?? t.jobs;
  const limit = env.limits?.email_drain ?? t.withinMs;
  const ids: string[] = [];
  const url = `${(process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "")}/nl/account`;
  for (let start = 0; start < n; start += ENQUEUE_BATCH) {
    const part = await inSystemTx(env, `drain:${start}`, async (ctx) => {
      const out: string[] = [];
      for (let i = start; i < Math.min(n, start + ENQUEUE_BATCH); i++) {
        const { jobId } = await sendTransactional(ctx, {
          template: "platform.magic_link",
          to: loadAddress(env.runId, "drain", i),
          locale: "nl-BE",
          data: { url, expiresMinutes: 15 },
          key: `load_test:${env.runId}:drain:${i}`,
        });
        out.push(jobId);
      }
      return out;
    });
    ids.push(...part);
  }
  const queuedAt = Date.now();
  let counts: Record<string, number> = {};
  const drained = await drainUntil(env, queuedAt, limit, async () => {
    counts = await jobStatusCounts(env.db, ids);
    return (counts.succeeded ?? 0) + (counts.dead ?? 0) >= ids.length;
  });
  const pass = ids.length === n && drained.finished && (counts.succeeded ?? 0) === n;
  return result(env, "email_drain", started, pass ? "pass" : "fail", [
    { label: "Jobs queued", value: `${ids.length} in ${fmtMs(queuedAt - started)}` },
    { label: "Job statuses", value: countsText(counts) },
    { label: "Drained after", value: drained.finished ? fmtMs(drained.elapsedMs) : `not within ${fmtMs(limit)}` },
    { label: "Throughput", value: drained.elapsedMs > 0 ? `${Math.round(((counts.succeeded ?? 0) / drained.elapsedMs) * 60_000)} jobs/min` : "-" },
    { label: "Ticks run here", value: String(drained.ticks) },
  ], n < t.jobs);
}

// ---------------------------------------------------------------------------
// 4. campaign_send: plan and send a 20,000-recipient campaign
// ---------------------------------------------------------------------------

export const LOAD_TEMPLATE_SLUG = "load-test-newsletter";
const INSERT_BATCH = 1_000;
const TERMINAL_CAMPAIGN = new Set(["sent", "paused", "stopped", "cancelled", "draft"]);

const loadDocument = {
  schemaVersion: 1 as const,
  locales: {
    "nl-BE": [{ id: "loadhdg001", type: "heading" as const, level: 1 as const, text: "Nieuws van BEAM" }, { id: "loadtxt001", type: "text" as const, markdown: "Dit is een testbericht van de belastingtest." }],
    "fr-BE": [{ id: "loadhdg001", type: "heading" as const, level: 1 as const, text: "Nouvelles de BEAM" }, { id: "loadtxt001", type: "text" as const, markdown: "Ceci est un message de test du test de charge." }],
    en: [{ id: "loadhdg001", type: "heading" as const, level: 1 as const, text: "News from BEAM" }, { id: "loadtxt001", type: "text" as const, markdown: "This is a test message of the load test." }],
  },
};

/** The published marketing template the scenario sends (seeded once, never changed afterwards). */
async function loadTemplate(env: ScenarioEnv): Promise<{ templateId: string; versionId: string } | null> {
  await inSystemTx(env, "template", (ctx) =>
    seedTemplate(ctx.tx, {
      slug: LOAD_TEMPLATE_SLUG,
      name: "Load test newsletter",
      kind: "marketing",
      purpose: "newsletter",
      subject: { "nl-BE": "BEAM belastingtest", "fr-BE": "BEAM test de charge", en: "BEAM load test" },
      preheader: { "nl-BE": "Testbericht", "fr-BE": "Message de test", en: "Test message" },
      document: loadDocument,
    }),
  );
  const [t] = await env.db.select({ id: emailTemplates.id, versionId: emailTemplates.currentVersionId }).from(emailTemplates).where(eq(emailTemplates.slug, LOAD_TEMPLATE_SLUG));
  return t?.versionId ? { templateId: t.id, versionId: t.versionId } : null;
}

/** `n` demo persons with a granted newsletter consent, in one static segment. Returns the segment id. */
async function loadAudience(env: ScenarioEnv, n: number): Promise<string> {
  const [segment] = await env.db.insert(segments).values({ name: `Load test ${env.runId}`, kind: "static" }).returning({ id: segments.id });
  for (let start = 0; start < n; start += INSERT_BATCH) {
    await env.db.transaction(async (tx) => {
      const values = Array.from({ length: Math.min(INSERT_BATCH, n - start) }, (_, j) => {
        const email = loadAddress(env.runId, "cmp", start + j);
        return { email, emailHash: emailHash(email), firstName: "Load", lastName: `Test ${env.runId} ${start + j}`, locale: "nl-BE" as const, isTester: true, acquisition: { source: "manual" } };
      });
      const rows = await tx.insert(persons).values(values).returning({ id: persons.id });
      const recordedAt = new Date();
      await tx.insert(consentRecords).values(
        rows.map((r) => ({ personId: r.id, purpose: "newsletter" as const, status: "granted" as const, source: "load_test", method: "form" as const, wordingVersion: "newsletter@1", recordedAt, actor: { kind: "system" as const, id: null } })),
      );
      await tx.insert(segmentMembers).values(rows.map((r) => ({ segmentId: segment!.id, personId: r.id, source: "manual" as const })));
    });
  }
  return segment!.id;
}

export async function campaignSend(env: ScenarioEnv): Promise<ScenarioResult> {
  const started = Date.now();
  const t = THRESHOLDS.campaign_send;
  const n = env.counts?.recipients ?? t.recipients;
  const limit = env.limits?.campaign_send ?? t.withinMs;
  const reduced = n < t.recipients;
  const [staffUser] = await env.db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.audience, "staff"), eq(users.status, "active")))
    .orderBy(asc(users.createdAt))
    .limit(1);
  if (!staffUser) return result(env, "campaign_send", started, "skipped", [], reduced, "no active staff user to own the campaign: run the seed first");
  const template = await loadTemplate(env);
  if (!template) return result(env, "campaign_send", started, "skipped", [], reduced, `template ${LOAD_TEMPLATE_SLUG} has no published version`);
  const segmentId = await loadAudience(env, n);
  const preparedAt = Date.now();

  // What scheduleCampaign does after its checks (email rule 27): `planning` plus the plan job.
  const campaignId = await inSystemTx(env, "campaign", async (ctx) => {
    const [c] = await ctx.tx
      .insert(campaigns)
      .values({ name: `Load test ${env.runId}`, templateId: template.templateId, templateVersionId: template.versionId, segmentId, purpose: "newsletter", status: "planning", scheduledAt: ctx.now, createdByUserId: staffUser.id, updatedByUserId: staffUser.id })
      .returning({ id: campaigns.id, version: campaigns.version });
    await ctx.enqueue({ kind: "campaign.plan", payload: { campaignId: c!.id, version: c!.version }, key: `campaign:${c!.id}:plan:${c!.version}`, lane: "bulk", priority: 9 });
    return c!.id;
  });

  let status = "planning";
  let plannedAfter: number | null = null;
  let dispatches = 0;
  const drained = await drainUntil(env, preparedAt, limit, async () => {
    const [c] = await env.db.select({ status: campaigns.status }).from(campaigns).where(eq(campaigns.id, campaignId));
    status = c?.status ?? "missing";
    if (status !== "planning" && plannedAfter === null) plannedAfter = Date.now() - preparedAt;
    if (status === "scheduled") {
      // The minute schedule `email.dispatch_due_campaigns` does the same; enqueueing it here
      // spares up to a minute of waiting for the cron.
      await inSystemTx(env, `dispatch:${dispatches}`, (ctx) => ctx.enqueue({ kind: "email.dispatch_due_campaigns", payload: {}, key: `load_test:${env.runId}:dispatch:${dispatches++}` }));
    }
    return TERMINAL_CAMPAIGN.has(status) || status === "missing";
  });
  const recipients = await env.db
    .select({ status: campaignRecipients.status, n: sql<number>`count(*)::int` })
    .from(campaignRecipients)
    .where(eq(campaignRecipients.campaignId, campaignId))
    .groupBy(campaignRecipients.status);
  const byStatus = Object.fromEntries(recipients.map((r) => [r.status, Number(r.n)]));
  const [messages] = await env.db.select({ n: sql<number>`count(*)::int` }).from(emailMessages).where(and(eq(emailMessages.campaignId, campaignId), eq(emailMessages.status, "sent")));
  const sent = byStatus.sent ?? 0;
  const pass = drained.finished && status === "sent" && sent === n;
  const [firstFailure] = await env.db
    .select({ error: emailMessages.error })
    .from(emailMessages)
    .where(and(eq(emailMessages.campaignId, campaignId), eq(emailMessages.status, "failed")))
    .limit(1);
  return result(env, "campaign_send", started, pass ? "pass" : "fail", [
    { label: "Audience prepared", value: `${n} persons in ${fmtMs(preparedAt - started)}` },
    { label: "Planned after", value: plannedAfter === null ? "not planned" : fmtMs(plannedAfter) },
    { label: "Campaign status", value: status },
    { label: "Recipients", value: countsText(byStatus) },
    { label: "Messages sent", value: String(Number(messages?.n ?? 0)) },
    ...(firstFailure ? [{ label: "First failed message", value: (firstFailure.error ?? "no error text").slice(0, 200) }] : []),
    { label: "Sent after", value: drained.finished ? fmtMs(drained.elapsedMs) : `not within ${fmtMs(limit)}` },
    { label: "Ticks run here", value: String(drained.ticks) },
  ], reduced, status === "sent" || !drained.finished ? undefined : `campaign ended as ${status}`);
}

export const SCENARIOS: Record<ScenarioKey, (env: ScenarioEnv) => Promise<ScenarioResult>> = {
  portal_booking: portalBooking,
  magic_links: magicLinks,
  email_drain: emailDrain,
  campaign_send: campaignSend,
};

/** Runs the chosen scenarios one after the other; a scenario that throws is a `fail` with its error. */
export async function runScenarios(env: ScenarioEnv, keys: readonly ScenarioKey[] = SCENARIO_KEYS): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];
  for (const key of keys) {
    const started = Date.now();
    env.log?.(`${key}: ${SCENARIO_TITLES[key]}`);
    try {
      results.push(await SCENARIOS[key](env));
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
      results.push(result(env, key, started, "fail", [], false, `error: ${message}`));
    }
  }
  return results;
}
