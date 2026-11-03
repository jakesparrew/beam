/**
 * The job system (architecture section 3, PL-24 to PL-36). Jobs are rows in `jobs`; the
 * one-minute tick (`runTick`, `/api/cron/tick`) and `after()` of committing actions run them.
 * A job runs in its own transaction with `SET LOCAL statement_timeout`; success commits the
 * handler's writes with `succeeded`. A failure goes back to `pending` with the backoff of
 * PL-26, or to `dead` (attempts used up, `PermanentError`, bad payload, unknown kind). The
 * runner never writes `failed` (PL-27).
 */
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import type { Db } from "@beam/db";
import { jobs } from "@beam/db/schema";
import { PermanentError, RetryableError } from "@beam/core/errors";
import { dueSlots, localHourKey, nextRunAt, parseCron } from "@beam/core/platform";
import { isPermanentFailure, scrubError, type IntegrationCallEntry } from "@beam/integrations/_shared";
import type { JobKind } from "../registry/types.generated";
import { createCtx, enqueueJob, eq, flushDurableWrites, getAppDb, sql, writeIntegrationCalls, type Ctx } from "./ctx";
import { getIntegrations, withIntegrationLog, type Env, type Integrations } from "./integrations";
import { logger, maskPii, reportError } from "./logger";
import { getSetting, writeSystemSetting } from "./settings";
import { loadCurrentKeyVersion, rowsOf } from "./sensitive";

export { PermanentError, RetryableError };

export type JobCtx = Ctx & {
  job: { id: string; kind: JobKind; attempt: number; key: string };
  /** The shared provider clients (`getIntegrations()`, or the test's fakes). */
  integrations: Integrations;
};

export type JobDefinition<I extends z.ZodTypeAny = z.ZodTypeAny> = {
  kind: JobKind;
  lane: "fast" | "bulk";
  priority: number;
  input: I;
  maxAttempts: number;
  timeoutMs: number;
  inline: boolean;
  run: (ctx: JobCtx, input: z.infer<I>) => Promise<unknown>;
  onDead?: (ctx: JobCtx, input: z.infer<I>, error: { message: string; permanent: boolean }) => Promise<void>;
};

/** Kinds that may run inline (PL-35, the three exceptions of architecture section 3). */
export const INLINE_JOB_KINDS = ["payments.create", "payments.terminal", "ai.answer_question"] as const;
export type InlineJobKind = Extract<JobKind, (typeof INLINE_JOB_KINDS)[number]>;

export function defineJob<I extends z.ZodTypeAny>(def: {
  kind: JobKind;
  lane: "fast" | "bulk";
  priority?: number;
  input: I;
  maxAttempts?: number;
  timeoutMs?: number;
  inline?: boolean;
  run: (ctx: JobCtx, input: z.infer<I>) => Promise<unknown>;
  onDead?: (ctx: JobCtx, input: z.infer<I>, error: { message: string; permanent: boolean }) => Promise<void>;
}): JobDefinition<I> {
  return {
    ...def,
    priority: def.priority ?? 5,
    maxAttempts: def.maxAttempts ?? 6,
    timeoutMs: def.timeoutMs ?? 60_000,
    inline: def.inline ?? false,
  };
}

export type ScheduleDefinition = { kind: JobKind; cron: string; payload: Record<string, unknown>; catchUp: boolean };

/** A schedule (cron in Europe/Brussels). `catchUp` defaults to true; minute-level crons never catch up (PL-33). */
export function defineSchedule(def: { kind: JobKind; cron: string; payload?: Record<string, unknown>; catchUp?: boolean }): ScheduleDefinition {
  parseCron(def.cron);
  return { kind: def.kind, cron: def.cron, payload: def.payload ?? {}, catchUp: def.catchUp ?? true };
}

// ---------------------------------------------------------------------------
// Registries (loaded lazily: the generated files import module facades that import this file)
// ---------------------------------------------------------------------------

type JobRegistry = Readonly<Record<string, JobDefinition | undefined>>;
let jobRegistry: Promise<JobRegistry> | undefined;
let scheduleRegistry: Promise<readonly ScheduleDefinition[]> | undefined;

export function loadJobs(): Promise<JobRegistry> {
  jobRegistry ??= import("../registry/jobs.generated").then((m) => (m as { JOB_BY_KIND?: unknown }).JOB_BY_KIND as JobRegistry);
  return jobRegistry;
}

export function loadSchedules(): Promise<readonly ScheduleDefinition[]> {
  scheduleRegistry ??= import("../registry/schedules.generated").then(
    (m) => ((m as { SCHEDULES?: unknown }).SCHEDULES ?? []) as readonly ScheduleDefinition[],
  );
  return scheduleRegistry;
}

// ---------------------------------------------------------------------------
// Options shared by the runner entry points (tests pass their database and fakes)
// ---------------------------------------------------------------------------

export type RunnerOptions = { db?: Db; integrations?: Integrations; now?: () => Date; random?: () => number };

type Claimed = {
  id: string;
  kind: string;
  payload: unknown;
  idempotency_key: string;
  lane: "fast" | "bulk";
  attempts: number;
  max_attempts: number;
  request_id: string | null;
  result: unknown;
};

export type RunSummary = { ran: { fast: number; bulk: number }; succeeded: number; retried: number; dead: number };

const FAST_CLAIM = 20;
const BULK_CLAIM = 5;
const FAST_CONCURRENCY = 5;
const BULK_CONCURRENCY = 2;
export const STALE_LOCK_MINUTES = 10;

const idList = (ids: readonly string[]) => sql`(${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})`;

/** Claims up to `limit` due pending jobs of a lane (priority, then `run_at`), `FOR UPDATE SKIP LOCKED`. */
export async function claimJobs(db: Db, lane: "fast" | "bulk", limit: number, lockedBy: string, ids?: readonly string[]): Promise<Claimed[]> {
  if (ids && !ids.length) return [];
  const only = ids ? sql` and id in ${idList(ids)}` : sql``;
  const rows = rowsOf<Claimed>(
    await db.execute(sql`
      update jobs set status = 'running', locked_at = now(), locked_by = ${lockedBy}, attempts = attempts + 1,
        started_at = now(), updated_at = now()
      where id in (
        select id from jobs where status = 'pending' and lane = ${lane} and run_at <= now()${only}
        order by priority, run_at, id limit ${limit} for update skip locked)
      returning id, kind, payload, idempotency_key, lane, attempts, max_attempts, request_id, result`),
  );
  return rows.map((r) => ({ ...r, attempts: Number(r.attempts), max_attempts: Number(r.max_attempts) }));
}

const errorText = (error: unknown) => maskPii(scrubError(error instanceof Error ? `${error.name}: ${error.message}` : String(error))).slice(0, 2000);

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RetryableError("timeout")), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type Outcome = "succeeded" | "retried" | "dead";

function buildJobCtx(base: Ctx, row: Claimed, integrations: Integrations): JobCtx {
  return Object.assign(base, {
    job: { id: row.id, kind: row.kind as JobKind, attempt: row.attempts, key: row.idempotency_key },
    integrations,
  });
}

/** Runs one claimed job to its next state. */
async function runClaimed(db: Db, row: Claimed, opts: RunnerOptions): Promise<Outcome> {
  const integrations = opts.integrations ?? getIntegrations();
  const def = (await loadJobs())[row.kind];
  const log: IntegrationCallEntry[] = [];
  let parsedInput: unknown;
  let jobCtx: JobCtx | undefined;
  const settle = async () => {
    await writeIntegrationCalls(db, log.splice(0), row.id).catch((e: unknown) => reportError(e, { tags: { where: "integration_calls" } }));
    if (jobCtx) await flushDurableWrites(db, jobCtx).catch((e: unknown) => reportError(e, { tags: { where: "durable_writes" } }));
  };
  try {
    if (!def) throw new PermanentError(`unknown_job_kind: ${row.kind}`);
    const parsed = def.input.safeParse(row.payload ?? {});
    if (!parsed.success) throw new PermanentError(`invalid_payload: ${parsed.error.message}`);
    parsedInput = parsed.data;
    await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`set local statement_timeout = ${Math.max(1, Math.floor(def.timeoutMs))}`));
      const ctx = buildJobCtx(
        createCtx({ tx, actor: { kind: "system", jobId: row.id }, requestId: row.request_id ?? `job:${row.id}`, jobId: row.id, now: opts.now?.() }),
        row,
        integrations,
      );
      jobCtx = ctx;
      const sink = (entry: IntegrationCallEntry) => void log.push(entry);
      ctx.integrationLog = sink;
      const result = await withIntegrationLog(sink, () => withTimeout(def.run(ctx, parsedInput), def.timeoutMs));
      await tx
        .update(jobs)
        .set({
          status: "succeeded",
          result: (result === undefined ? null : JSON.parse(JSON.stringify(result, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)))) as unknown,
          finishedAt: sql`now()`,
          lockedAt: null,
          lockedBy: null,
          lastError: null,
        })
        .where(eq(jobs.id, row.id));
    });
    await settle();
    return "succeeded";
  } catch (error) {
    await settle();
    return failJob(db, row, def, parsedInput, error, opts);
  }
}

/** Retry with backoff or turn dead (PL-26 to PL-29a). */
async function failJob(db: Db, row: Claimed, def: JobDefinition | undefined, input: unknown, error: unknown, opts: RunnerOptions): Promise<Outcome> {
  const permanent = isPermanentFailure(error);
  const now = opts.now?.() ?? new Date();
  const next = permanent ? null : nextRunAt(row.attempts, now, opts.random ?? Math.random, row.max_attempts);
  const message = errorText(error);
  if (next) {
    await db
      .update(jobs)
      .set({ status: "pending", runAt: next, lastError: message, lockedAt: null, lockedBy: null })
      .where(eq(jobs.id, row.id));
    logger.warn({ jobId: row.id, kind: row.kind, attempt: row.attempts }, "job retry");
    return "retried";
  }

  await db.transaction(async (tx) => {
    await tx
      .update(jobs)
      .set({ status: "dead", lastError: message, finishedAt: sql`now()`, lockedAt: null, lockedBy: null })
      .where(eq(jobs.id, row.id));
    if (row.kind !== "notify.slack") {
      // PL-29: one Slack line per kind per Brussels hour.
      await enqueueJob(tx, {
        kind: "notify.slack" as JobKind,
        payload: { fingerprint: `dead:${row.kind}`, severity: "high", text: `Job ${row.kind} is dead after ${row.attempts} attempt(s): ${message.slice(0, 300)}` },
        key: `slack:dead:${row.kind}:${localHourKey(now)}`,
      }).catch((e: unknown) => {
        // A missing notify.slack definition (tests of other registries) must not keep the job alive.
        if (!(e instanceof PermanentError)) throw e;
      });
    }
  });
  reportError(error, { tags: { job_kind: row.kind, job_id: row.id }, extra: { attempts: row.attempts } });

  if (def?.onDead && input !== undefined) await runOnDead(db, row, def, input, { message, permanent }, opts);
  return "dead";
}

/** Calls `onDead` once per dead transition, guarded by `result.on_dead_at` (PL-29a). */
async function runOnDead(
  db: Db,
  row: Claimed,
  def: JobDefinition,
  input: unknown,
  err: { message: string; permanent: boolean },
  opts: RunnerOptions,
): Promise<void> {
  const integrations = opts.integrations ?? getIntegrations();
  await db.transaction(async (tx) => {
    const guard = rowsOf<{ id: string }>(
      await tx.execute(sql`
        update jobs set result = coalesce(result, '{}'::jsonb) || jsonb_build_object('on_dead_at', now())
        where id = ${row.id}::uuid and status = 'dead' and (result is null or result->>'on_dead_at' is null)
        returning id`),
    );
    if (!guard.length) return;
    try {
      await tx.transaction(async (sp) => {
        const ctx = buildJobCtx(createCtx({ tx: sp, actor: { kind: "system", jobId: row.id }, requestId: `job:${row.id}`, jobId: row.id }), row, integrations);
        await def.onDead!(ctx, input, err);
      });
    } catch (hookError) {
      reportError(hookError, { tags: { job_kind: row.kind, job_id: row.id, where: "onDead" } });
    }
  });
}

async function runPool<T>(items: readonly T[], concurrency: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await work(item);
    }
  });
  await Promise.all(workers);
}

/**
 * Claims and runs jobs until the budget is spent. With `ids`, only those jobs (PL-34). In the
 * tick (`tickId`), leaves early when an iteration claims nothing and nothing is due within 10 s.
 */
export async function runJobs(
  opts: { ids?: string[]; budgetMs: number; lanes?: ("fast" | "bulk")[]; tickId?: string } & RunnerOptions,
): Promise<RunSummary> {
  const db = opts.db ?? (await getAppDb());
  const started = Date.now();
  const lanes = opts.lanes ?? ["fast", "bulk"];
  const lockedBy = opts.tickId ?? `inline:${randomUUID()}`;
  const summary: RunSummary = { ran: { fast: 0, bulk: 0 }, succeeded: 0, retried: 0, dead: 0 };
  const count = (o: Outcome) => {
    summary[o] += 1;
  };

  while (Date.now() - started < opts.budgetMs) {
    let claimed = 0;
    if (lanes.includes("fast")) {
      const batch = await claimJobs(db, "fast", FAST_CLAIM, lockedBy, opts.ids);
      claimed += batch.length;
      summary.ran.fast += batch.length;
      await runPool(batch, FAST_CONCURRENCY, async (row) => count(await runClaimed(db, row, opts)));
    }
    if (lanes.includes("bulk") && Date.now() - started < opts.budgetMs) {
      const batch = await claimJobs(db, "bulk", BULK_CLAIM, lockedBy, opts.ids);
      claimed += batch.length;
      summary.ran.bulk += batch.length;
      await runPool(batch, BULK_CONCURRENCY, async (row) => count(await runClaimed(db, row, opts)));
    }
    if (claimed > 0) continue;
    if (opts.ids || !opts.tickId) break;
    const soon = rowsOf<{ n: number | string }>(
      await db.execute(sql`select count(*)::int as n from jobs where status = 'pending' and run_at <= now() + interval '10 seconds'`),
    );
    if (Number(soon[0]?.n ?? 0) === 0) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  return summary;
}

/**
 * Runs one of the three inline kinds now, in the request (PL-35). It is still a `jobs` row with
 * the same idempotency, logging and dead handling. Any other kind throws at call time.
 */
export async function runJobInline<T>(
  kind: InlineJobKind,
  payload: unknown,
  opts: { key: string; requestId: string } & RunnerOptions,
): Promise<T> {
  const def = (await loadJobs())[kind];
  if (!def || !def.inline || !(INLINE_JOB_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`runJobInline: ${String(kind)} is not an inline job`);
  }
  const db = opts.db ?? (await getAppDb());
  const { id } = await enqueueJob(db, { kind, payload, key: opts.key }, opts.requestId);
  const claimed = await claimJobs(db, def.lane, 1, `inline:${opts.requestId}`, [id]);
  if (claimed[0]) await runClaimed(db, claimed[0], opts);
  const [row] = await db.select({ status: jobs.status, result: jobs.result, lastError: jobs.lastError }).from(jobs).where(eq(jobs.id, id));
  if (row?.status === "succeeded") return row.result as T;
  if (row?.status === "dead") throw new PermanentError(row.lastError ?? `inline job ${String(kind)} is dead`);
  throw new RetryableError(row?.lastError ?? `inline job ${String(kind)} did not finish`);
}

/** PL-30: `running` jobs locked more than 10 minutes ago go back to `pending` (the attempt counts). */
export async function reclaimStaleLocks(db: Db): Promise<number> {
  const rows = rowsOf<{ id: string }>(
    await db.execute(sql`
      update jobs set status = 'pending', locked_at = null, locked_by = null, last_error = 'stale lock', updated_at = now()
      where status = 'running' and locked_at < now() - make_interval(mins => ${STALE_LOCK_MINUTES})
      returning id`),
  );
  return rows.length;
}

/** PL-31: deletes succeeded jobs older than 7 days and dead jobs older than 90 days, 5,000 per statement, at most `budgetMs`. */
export async function pruneJobs(db: Db | Ctx["tx"], budgetMs = 40_000): Promise<number> {
  const started = Date.now();
  let total = 0;
  for (const [status, days] of [
    ["succeeded", 7],
    ["dead", 90],
  ] as const) {
    while (Date.now() - started < budgetMs) {
      const rows = rowsOf<{ id: string }>(
        await db.execute(sql`
          delete from jobs where id in (
            select id from jobs where status = ${status} and finished_at < now() - make_interval(days => ${days}) limit 5000)
          returning id`),
      );
      total += rows.length;
      if (rows.length < 5000) break;
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Schedules and the tick
// ---------------------------------------------------------------------------

/** Enqueues the due slots of every schedule (PL-33); keys `schedule:<kind>:<local minute>` dedupe overlapping ticks. */
export async function enqueueDueSchedules(db: Db, now: Date, lastTickAt: Date | null): Promise<number> {
  let inserted = 0;
  for (const s of await loadSchedules()) {
    for (const slot of dueSlots(s.cron, s.catchUp ? lastTickAt : null, now)) {
      try {
        const r = await enqueueJob(db, { kind: s.kind, payload: s.payload, key: `schedule:${s.kind}:${slot.key}` });
        if (r.inserted) inserted += 1;
      } catch (error) {
        reportError(error, { tags: { schedule: s.kind } });
      }
    }
  }
  return inserted;
}

export type TickResult = { tickId: string; enqueuedSchedules: number; ran: { fast: number; bulk: number }; reclaimed: number };

/** Pings the Better Stack heartbeat (2 s timeout, logged, failures ignored). */
async function pingHeartbeat(db: Db): Promise<void> {
  const url = process.env.BETTERSTACK_HEARTBEAT_URL;
  if (!url) return;
  const started = Date.now();
  let statusCode: number | null = null;
  let error: string | null = null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    statusCode = res.status;
    if (!res.ok) error = `heartbeat ${res.status}`;
  } catch (e) {
    error = errorText(e).slice(0, 1000);
  }
  await writeIntegrationCalls(
    db,
    [{ provider: "betterstack", operation: "heartbeat.ping", requestDigest: "heartbeat", statusCode, ok: !error, durationMs: Date.now() - started, error }],
    null,
  ).catch(() => undefined);
}

/** One tick (PL-32): schedules, the 50 s run loop, stale locks, `last_tick_at`, heartbeat. */
export async function runTick(opts: { budgetMs?: number; tickId?: string } & RunnerOptions = {}): Promise<TickResult> {
  const db = opts.db ?? (await getAppDb());
  const tickId = opts.tickId ?? `tick:${randomUUID()}`;
  const now = opts.now?.() ?? new Date();
  // New sensitive writes in this instance use settings.security.current_key_version (PL-69).
  await loadCurrentKeyVersion(db).catch((e: unknown) => reportError(e, { tags: { where: "key_version" } }));
  const last = (await getSetting(db, "last_tick_at" as never)) as unknown;
  const lastTickAt = typeof last === "string" && last ? new Date(last) : null;
  const enqueuedSchedules = await enqueueDueSchedules(db, now, lastTickAt);
  const summary = await runJobs({ ...opts, db, budgetMs: opts.budgetMs ?? 50_000, tickId });
  const reclaimed = await reclaimStaleLocks(db);
  await writeSystemSetting(db, "last_tick_at" as never, now.toISOString() as never);
  await pingHeartbeat(db);
  return { tickId, enqueuedSchedules, ran: summary.ran, reclaimed };
}

/**
 * The in-process tick for `next dev` / `next start` on a laptop or in e2e (runbook DR-13): every
 * `LOCAL_TICK_MS` ms, skipping a beat while the previous one runs. Refuses outside `APP_ENV=local`.
 */
export function startLocalTick(env: Env = process.env): (() => void) | null {
  const ms = Number(env.LOCAL_TICK_MS);
  if (!ms || ms < 100) return null;
  const appEnv = env.APP_ENV ?? "local";
  if (appEnv !== "local") {
    logger.warn({ appEnv }, "LOCAL_TICK_MS ignored outside APP_ENV=local");
    return null;
  }
  const holder = globalThis as unknown as { __beamLocalTick?: ReturnType<typeof setInterval> };
  if (holder.__beamLocalTick) return () => clearInterval(holder.__beamLocalTick);
  let busy = false;
  holder.__beamLocalTick = setInterval(() => {
    if (busy) return;
    busy = true;
    runTick({ budgetMs: Math.min(ms * 5, 50_000) })
      .catch((error: unknown) => reportError(error, { tags: { where: "local_tick" } }))
      .finally(() => {
        busy = false;
      });
  }, ms);
  holder.__beamLocalTick.unref?.();
  return () => {
    clearInterval(holder.__beamLocalTick);
    holder.__beamLocalTick = undefined;
  };
}
