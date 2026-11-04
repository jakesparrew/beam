/**
 * The request and job context (platform spec 4.1, architecture section 3). Frozen after Wave 0.
 *
 * `createCtx()` builds the `Ctx` that `action()` (lib/action.ts) and the job runner hand to
 * handlers: one open transaction, the actor, and the helpers that write in that transaction
 * (`enqueue`, `recordEvent`, `audit`). Provider calls are logged through `integrationLog`,
 * buffered and written by `flushIntegrationLog()` after commit or rollback.
 */
import { randomUUID } from "node:crypto";
import { enqueue as dbEnqueue, getDb, type Db, type DbOrTx, type Tx } from "@beam/db";
import { integrationCalls, type ActorJson, type RoleKey } from "@beam/db/schema";
import type { webhookEventsProvider } from "@beam/db/schema";
import { ForbiddenError, PermanentError } from "@beam/core/errors";
import type { Locale } from "@beam/core/i18n";
import { INTEGRATION_PROVIDERS, type IntegrationCallEntry } from "@beam/integrations/_shared";
import type { EventKind, JobKind, Permission } from "../registry/types.generated";
import { audit as writeAudit, type AuditInput } from "./audit";
import { recordEvent as writeEvent, type RecordEventInput } from "./events";

/**
 * Drizzle's SQL operators, re-exported so app code imports them from `@/lib/ctx`.
 * `apps/web` and `@beam/db` resolve the same drizzle-orm instance (one lockfile entry),
 * so `sql` objects and tables stay compatible.
 */
export {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  not,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

export type { Db, DbOrTx, Tx };

export type WebhookProvider = (typeof webhookEventsProvider.enumValues)[number];

export type Actor =
  | { kind: "staff"; userId: string; roleKey: RoleKey; permissions: ReadonlySet<Permission>; mfaAt: Date }
  | { kind: "customer"; userId: string; personId: string }
  | { kind: "system"; jobId: string }
  | { kind: "webhook"; provider: WebhookProvider }
  | { kind: "public" };

export type EnqueueInput = {
  kind: JobKind;
  payload: unknown;
  key: string;
  runAt?: Date;
  lane?: "fast" | "bulk";
  priority?: number;
  maxAttempts?: number;
  id?: string;
};

export type Ctx = {
  tx: Tx;
  actor: Actor;
  requestId: string;
  now: Date;
  locale: Locale;
  ip: string | null;
  enqueue: (input: EnqueueInput) => Promise<{ id: string; inserted: boolean }>;
  recordEvent: (input: RecordEventInput) => Promise<{ id: bigint | null }>;
  audit: (input: AuditInput) => Promise<void>;
  /** Throws `ForbiddenError` unless the actor holds `permission`. */
  require: (permission: Permission) => void;
  /** Buffered; written to `integration_calls` after commit or rollback. */
  integrationLog: (entry: IntegrationCallEntry) => void;
};

export type { EventKind, JobKind, Permission, RecordEventInput, AuditInput };

// ---------------------------------------------------------------------------
// Errors that carry an action error code
// ---------------------------------------------------------------------------

/** The codes of `ActionResult` (lib/action.ts maps errors carrying `code` to them). */
export type AppErrorCode = "unauthorized" | "forbidden" | "validation" | "not_found" | "conflict" | "rate_limited" | "internal";

/** An error `action()` turns into `{ ok: false, error: { code, message, fields } }`. */
export class AppError extends Error {
  override readonly name: string = "AppError";
  constructor(
    readonly code: AppErrorCode,
    message: string = code,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
  }
}

/** Invalid input (`validation`). Permanent: a job with invalid input never succeeds. */
export class ValidationError extends PermanentError {
  override readonly name: string = "ValidationError";
  readonly code = "validation" as const;
  constructor(
    message = "validation",
    readonly fields?: Record<string, string>,
  ) {
    super(message);
  }
}

/** A stale `expectedVersion` or a forbidden state transition (`conflict`). */
export class ConflictError extends AppError {
  override readonly name: string = "ConflictError";
  constructor(message = "conflict") {
    super("conflict", message);
  }
}

export class NotFoundError extends AppError {
  override readonly name: string = "NotFoundError";
  constructor(message = "not_found") {
    super("not_found", message);
  }
}

export class RateLimitedError extends AppError {
  override readonly name: string = "RateLimitedError";
  constructor(readonly retryAfterSeconds: number) {
    super("rate_limited", "rate_limited");
  }
}

// ---------------------------------------------------------------------------
// Actors and permissions
// ---------------------------------------------------------------------------

/** The `ActorJson` stored in `audit_log.actor`, `activity_events.actor` and `ai_requests.actor` (PL-36). */
export function actorJson(actor: Actor): ActorJson {
  switch (actor.kind) {
    case "staff":
      return { kind: "staff", id: actor.userId, roleKey: actor.roleKey };
    case "customer":
      return { kind: "customer", id: actor.userId };
    case "system":
      // A job's actor is stored as `job` (PL-36); the system acting outside a job (scripts, tick) as `system`.
      return actor.jobId ? { kind: "job", id: actor.jobId } : { kind: "system", id: null };
    case "webhook":
      return { kind: "webhook", id: null, provider: actor.provider };
    default:
      return { kind: "system", id: null };
  }
}

/** True when a staff actor holds `permission` (`'*'` grants every permission, PL-15). */
export function actorHasPermission(actor: Actor, permission: string): boolean {
  if (actor.kind !== "staff") return false;
  const perms = actor.permissions as ReadonlySet<string>;
  return perms.has("*") || perms.has(permission);
}

// ---------------------------------------------------------------------------
// The database the runtime uses outside a transaction
// ---------------------------------------------------------------------------

const runtime = globalThis as unknown as { __beamAppDb?: Db };

/** The app database (the shared handle), or the one a test installed with `setAppDb()`. */
export async function getAppDb(): Promise<Db> {
  return runtime.__beamAppDb ?? getDb();
}

/** Tests install their PGlite database here (`makeCtx` does it); `undefined` restores the default. */
export function setAppDb(db: Db | undefined): void {
  runtime.__beamAppDb = db;
}

// ---------------------------------------------------------------------------
// Context construction
// ---------------------------------------------------------------------------

type JobDefLike = {
  kind: string;
  lane: "fast" | "bulk";
  priority?: number;
  maxAttempts?: number;
  input: { safeParse: (v: unknown) => { success: boolean; error?: { message: string } } };
};

let jobRegistry: Promise<Readonly<Record<string, JobDefLike | undefined>>> | undefined;
/** The job registry, loaded lazily: the generated file imports module facades that import lib code. */
export function loadJobRegistry(): Promise<Readonly<Record<string, JobDefLike | undefined>>> {
  jobRegistry ??= import("../registry/jobs.generated").then(
    (m) => (m as { JOB_BY_KIND?: unknown }).JOB_BY_KIND as Readonly<Record<string, JobDefLike | undefined>>,
  );
  return jobRegistry;
}

/** Internal bookkeeping of one context (not part of the handler-facing type). */
export type CtxState = {
  /** Ids of the jobs this context enqueued (PL-34 runs exactly these after commit). */
  enqueuedIds: string[];
  /** Action names a handler audited itself (PL-20: suppresses the automatic row). */
  auditedActions: Set<string>;
  integrationLog: IntegrationCallEntry[];
  jobId: string | null;
  /**
   * Writes that must survive a rollback of the handler transaction (the `ai_requests` row of a
   * failed attempt). Deferred contexts (the job runner) run them after the transaction ends;
   * immediate contexts (tests, scripts working on the database directly) run them at once.
   */
  durableWrites: ((db: DbOrTx) => Promise<void>)[];
  durableMode: "deferred" | "immediate";
};

const states = new WeakMap<object, CtxState>();

export function ctxState(ctx: Ctx): CtxState {
  const s = states.get(ctx);
  if (!s) throw new Error("ctxState: this context was not made by createCtx()");
  return s;
}

export type CtxInit = {
  tx: Tx;
  actor: Actor;
  requestId?: string;
  now?: Date;
  locale?: Locale;
  ip?: string | null;
  /** The job this context runs (job contexts); stored on `integration_calls.job_id`. */
  jobId?: string | null;
  /** `immediate` when `tx` is the database itself (tests); default `deferred`. */
  durableMode?: "deferred" | "immediate";
};

/** Validates and enqueues a job in `tx` with the definition's defaults (PL-24). */
export async function enqueueJob(
  tx: DbOrTx,
  input: EnqueueInput,
  requestId?: string,
): Promise<{ id: string; inserted: boolean }> {
  const registry = await loadJobRegistry();
  const def = registry[input.kind];
  if (!def) throw new PermanentError(`unknown_job_kind: ${input.kind}`);
  const parsed = def.input.safeParse(input.payload ?? {});
  if (!parsed.success) throw new ValidationError(`invalid_payload: ${input.kind}: ${parsed.error?.message ?? ""}`);
  return dbEnqueue(tx, {
    kind: input.kind,
    payload: input.payload ?? {},
    key: input.key,
    lane: input.lane ?? def.lane,
    priority: input.priority ?? def.priority ?? 5,
    maxAttempts: input.maxAttempts ?? def.maxAttempts ?? 6,
    ...(input.runAt ? { runAt: input.runAt } : {}),
    ...(input.id ? { id: input.id } : {}),
    ...(requestId ? { requestId } : {}),
  });
}

export function createCtx(init: CtxInit): Ctx {
  const state: CtxState = {
    enqueuedIds: [],
    auditedActions: new Set(),
    integrationLog: [],
    jobId: init.jobId ?? null,
    durableWrites: [],
    durableMode: init.durableMode ?? "deferred",
  };
  const ctx: Ctx = {
    tx: init.tx,
    actor: init.actor,
    requestId: init.requestId ?? `req_${randomUUID()}`,
    now: init.now ?? new Date(),
    locale: init.locale ?? "nl-BE",
    ip: init.ip ?? null,
    async enqueue(input) {
      const result = await enqueueJob(ctx.tx, input, ctx.requestId);
      state.enqueuedIds.push(result.id);
      return result;
    },
    recordEvent(input) {
      return writeEvent(ctx.tx, actorJson(ctx.actor), input);
    },
    async audit(input) {
      state.auditedActions.add(input.action);
      await writeAudit(ctx.tx, { actor: actorJson(ctx.actor), requestId: ctx.requestId, ip: ctx.ip }, input);
    },
    require(permission) {
      if (!actorHasPermission(ctx.actor, permission)) throw new ForbiddenError(`forbidden: ${permission}`, permission);
    },
    integrationLog(entry) {
      state.integrationLog.push(entry);
    },
  };
  states.set(ctx, state);
  return ctx;
}

/** The `integration_calls_provider` enum values; entries of any other provider are dropped. */
const INTEGRATION_ENUM = new Set<string>(INTEGRATION_PROVIDERS);

/** Writes buffered `integration_calls` rows (outside the handler transaction, so a rollback keeps them). */
export async function writeIntegrationCalls(db: DbOrTx, entries: readonly IntegrationCallEntry[], jobId: string | null): Promise<void> {
  const rows = entries
    .filter((e) => INTEGRATION_ENUM.has(e.provider))
    .map((e) => ({
      provider: e.provider,
      operation: e.operation,
      requestDigest: e.requestDigest,
      statusCode: e.statusCode,
      ok: e.ok,
      durationMs: Math.max(0, Math.round(e.durationMs)),
      error: e.error ? e.error.slice(0, 1000) : null,
      jobId,
    }));
  if (rows.length) await db.insert(integrationCalls).values(rows);
}

/** Flushes a context's integration log; call after the transaction committed or rolled back. */
export async function flushIntegrationLog(db: DbOrTx, ctx: Ctx): Promise<void> {
  const state = ctxState(ctx);
  const entries = state.integrationLog.splice(0);
  await writeIntegrationCalls(db, entries, state.jobId);
}

/** Queues (or, in an immediate context, runs) a write that must survive a rollback. */
export async function writeDurably(ctx: Ctx, write: (db: DbOrTx) => Promise<void>): Promise<void> {
  const state = ctxState(ctx);
  if (state.durableMode === "immediate") await write(ctx.tx);
  else state.durableWrites.push(write);
}

/** Runs the queued durable writes of a context; call after its transaction committed or rolled back. */
export async function flushDurableWrites(db: DbOrTx, ctx: Ctx): Promise<void> {
  const state = ctxState(ctx);
  for (const write of state.durableWrites.splice(0)) await write(db);
}
