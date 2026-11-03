/**
 * Test helpers for every module (runbook 1.5, platform spec 10): contexts on a `createTestDb()`
 * database, the double-run helper, provider fakes and a fake Sentry. Tests never read
 * `INTEGRATIONS`: they pass fakes explicitly, so no test can reach a real provider.
 */
import { randomUUID } from "node:crypto";
import type { Db, Tx } from "@beam/db";
import type { RoleKey } from "@beam/db/schema";
import type { Locale } from "@beam/core/i18n";
import type { JobKind, Permission } from "../registry/types.generated";
import { createCtx, flushDurableWrites, flushIntegrationLog, setAppDb, type Actor, type Ctx } from "./ctx";
import { createFakeIntegrations, setIntegrations, type FakeIntegrations, type Integrations } from "./integrations";
import { loadJobs, type JobCtx } from "./job-runner";
import { setErrorReporter, type ErrorReporter } from "./logger";
import { clearFlagCache } from "./flags";

export { createFakeIntegrations, type FakeIntegrations };

export type MakeCtxOptions = {
  actor?: Actor;
  integrations?: Integrations;
  now?: Date;
  locale?: Locale;
  requestId?: string;
  ip?: string | null;
};

const isActor = (v: unknown): v is Actor => !!v && typeof v === "object" && "kind" in v;

/** A staff actor with the given permissions (`['*']` for an owner). */
export function staffActor(input: { userId?: string; roleKey?: RoleKey; permissions?: readonly string[]; mfaAt?: Date } = {}): Extract<Actor, { kind: "staff" }> {
  return {
    kind: "staff",
    userId: input.userId ?? randomUUID(),
    roleKey: input.roleKey ?? "technical_admin",
    permissions: new Set((input.permissions ?? []) as Permission[]),
    mfaAt: input.mfaAt ?? new Date(),
  };
}

/**
 * A context whose `tx` is the test database itself (each statement autocommits). Writes that
 * must survive rollbacks run at once. Also makes `db` the runtime database (`getAppDb()`).
 * The second argument is an actor or options; the default actor is the system.
 */
export function makeCtx(db: Db, actorOrOptions?: Actor | MakeCtxOptions): Ctx {
  const opts: MakeCtxOptions = isActor(actorOrOptions) ? { actor: actorOrOptions } : (actorOrOptions ?? {});
  setAppDb(db);
  if (opts.integrations) setIntegrations(opts.integrations);
  return createCtx({
    tx: db as unknown as Tx,
    actor: opts.actor ?? { kind: "system", jobId: "" },
    requestId: opts.requestId,
    now: opts.now,
    locale: opts.locale,
    ip: opts.ip,
    durableMode: "immediate",
  });
}

/** A job context for `kind` (system actor, attempt 1, fresh fakes unless given). */
export function makeJobCtx(
  db: Db,
  kind: JobKind,
  opts: { integrations?: Integrations; attempt?: number; now?: Date; jobId?: string; key?: string; tx?: Tx } = {},
): JobCtx {
  const jobId = opts.jobId ?? randomUUID();
  setAppDb(db);
  const base = createCtx({
    tx: opts.tx ?? (db as unknown as Tx),
    actor: { kind: "system", jobId },
    requestId: `job:${jobId}`,
    now: opts.now,
    jobId,
    durableMode: opts.tx ? "deferred" : "immediate",
  });
  return Object.assign(base, {
    job: { id: jobId, kind, attempt: opts.attempt ?? 1, key: opts.key ?? `test:${kind}:${jobId}` },
    integrations: opts.integrations ?? createFakeIntegrations(),
  });
}

/**
 * Runs a job's handler twice with the same payload, each run in its own transaction like the
 * runner, and returns both results. Assert that the database state after the second run equals
 * the state after the first (conventions: every job runs twice in `jobs.test.ts`).
 */
export async function runJobTwice(
  db: Db,
  kind: JobKind,
  payload: unknown,
  opts: { integrations?: Integrations; between?: () => Promise<void> } = {},
): Promise<{ first: unknown; second: unknown }> {
  const def = (await loadJobs())[kind];
  if (!def) throw new Error(`runJobTwice: unknown job kind ${kind}`);
  const input = def.input.parse(payload);
  const integrations = opts.integrations ?? createFakeIntegrations();
  const results: unknown[] = [];
  for (let i = 0; i < 2; i++) {
    let ctx: JobCtx | undefined;
    await db.transaction(async (tx) => {
      ctx = makeJobCtx(db, kind, { integrations, tx, attempt: i + 1 });
      results.push(await def.run(ctx, input));
    });
    if (ctx) {
      await flushDurableWrites(db, ctx);
      await flushIntegrationLog(db, ctx);
    }
    if (i === 0 && opts.between) await opts.between();
  }
  return { first: results[0], second: results[1] };
}

export type FakeSentry = {
  exceptions: { error: unknown; tags?: Record<string, string> }[];
  messages: { message: string; tags?: Record<string, string> }[];
  restore(): void;
};

/** Replaces the Sentry reporter with a recorder until `restore()`. */
export function fakeSentry(): FakeSentry {
  const fake: FakeSentry = {
    exceptions: [],
    messages: [],
    restore: () => setErrorReporter(undefined),
  };
  const reporter: ErrorReporter = {
    captureException: (error, context) => void fake.exceptions.push({ error, tags: context?.tags }),
    captureMessage: (message, context) => void fake.messages.push({ message, tags: context?.tags }),
  };
  setErrorReporter(reporter);
  return fake;
}

/** Restores the runtime defaults a test changed (database, integrations, flag cache, reporter). */
export function resetRuntime(): void {
  setAppDb(undefined);
  setIntegrations(undefined);
  setErrorReporter(undefined);
  clearFlagCache();
}
