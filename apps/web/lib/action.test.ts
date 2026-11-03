import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createTestDb, makeUser } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { auditLog, jobs, roles } from "@beam/db/schema";
import type * as JobRunner from "./job-runner";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "203.0.113.7" })),
}));
const afterCallbacks: (() => Promise<void>)[] = [];
vi.mock("next/server", () => ({ after: (fn: () => Promise<void>) => void afterCallbacks.push(fn) }));
const runJobsMock = vi.fn((_opts: { ids?: string[]; budgetMs: number }) => Promise.resolve({ ran: { fast: 0, bulk: 0 }, succeeded: 0, retried: 0, dead: 0 }));
vi.mock("./job-runner", async (importOriginal) => ({ ...(await importOriginal<typeof JobRunner>()), runJobs: (o: { ids?: string[]; budgetMs: number }) => runJobsMock(o) }));

const { action } = await import("./action");
const { createAuthSession, SESSION_COOKIE } = await import("./auth");
const { ConflictError, NotFoundError, eq, setAppDb } = await import("./ctx");
const { fakeSentry, resetRuntime } = await import("./testing");

let handle: DbHandle;

async function signInStaff(permissions: string[], opts: { mfa?: boolean } = {}) {
  const user = await makeUser(handle.db, { roleKey: "technical_admin" });
  await handle.db.update(roles).set({ permissions }).where(eq(roles.key, "technical_admin"));
  const { token } = await createAuthSession(handle.db, { userId: user.id, audience: "staff", roleKey: "technical_admin", now: new Date(), mfaAt: opts.mfa === false ? null : new Date() });
  jar.set(SESSION_COOKIE, token);
  return user;
}

beforeAll(async () => {
  handle = await createTestDb();
  setAppDb(handle.db);
});
afterAll(async () => {
  resetRuntime();
  await handle.close();
});
beforeEach(() => {
  jar.clear();
  afterCallbacks.length = 0;
  runJobsMock.mockClear();
});

const Input = z.object({ name: z.string().min(2), count: z.number().int() });

describe("action()", () => {
  it("refuses a missing permission before the handler runs", async () => {
    await signInStaff(["persons.read"]);
    const handler = vi.fn(() => Promise.resolve({}));
    const run = action({ name: "test.guarded", audience: "staff", permission: "system.jobs", input: Input }, handler);
    expect(await run({ name: "ok", count: 1 })).toEqual({ ok: false, error: { code: "forbidden", message: "forbidden: system.jobs" } });
    expect(handler).not.toHaveBeenCalled();
  });

  it("answers unauthorized without a session and for a session still waiting for MFA (PL-3)", async () => {
    const handler = vi.fn(() => Promise.resolve({}));
    const run = action({ name: "test.staff", audience: "staff", input: z.object({}) }, handler);
    expect((await run({})).ok).toBe(false);
    await signInStaff(["*"], { mfa: false });
    const result = await run({});
    expect(result).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    expect(handler).not.toHaveBeenCalled();
  });

  it("returns validation with field messages", async () => {
    await signInStaff(["*"]);
    const run = action({ name: "test.validate", audience: "staff", input: Input }, () => Promise.resolve({}));
    const result = await run({ name: "x", count: "two" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("validation");
    expect(Object.keys(result.error.fields ?? {}).sort()).toEqual(["count", "name"]);
  });

  it("maps conflict and not_found by error code", async () => {
    await signInStaff(["*"]);
    const conflict = action({ name: "test.conflict", audience: "staff", input: z.object({}) }, () => Promise.reject(new ConflictError("stale_version")));
    const missing = action({ name: "test.missing", audience: "staff", input: z.object({}) }, () => Promise.reject(new NotFoundError()));
    expect(await conflict({})).toEqual({ ok: false, error: { code: "conflict", message: "stale_version" } });
    expect(await missing({})).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("reports unknown errors to Sentry and answers internal with the request id", async () => {
    await signInStaff(["*"]);
    const sentry = fakeSentry();
    const run = action({ name: "test.boom", audience: "staff", input: z.object({}) }, () => Promise.reject(new Error("boom")));
    const result = await run({});
    sentry.restore();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("internal");
    expect(result.error.message).toMatch(/^req_/);
    expect(sentry.exceptions).toHaveLength(1);
    expect(sentry.exceptions[0]!.tags).toMatchObject({ action: "test.boom", request_id: result.error.message });
  });

  it("writes one audit row per staff write, with the redacted input", async () => {
    const user = await signInStaff(["*"]);
    const run = action({ name: "test.write_once", audience: "staff", input: z.object({ name: z.string(), password: z.string() }), audit: "things" }, () => Promise.resolve({ done: true }));
    expect(await run({ name: "Ann", password: "secret-value" })).toEqual({ ok: true, data: { done: true } });
    const rows = await handle.db.select().from(auditLog).where(eq(auditLog.action, "test.write_once"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entityType: "things", newValue: { name: "Ann", password: "[redacted]" }, ip: "203.0.113.7" });
    expect((rows[0]!.actor as { id: string }).id).toBe(user.id);
  });

  it("skips the automatic row when the handler audited its own action name", async () => {
    await signInStaff(["*"]);
    const run = action({ name: "test.self_audit", audience: "staff", input: z.object({}) }, async (ctx) => {
      await ctx.audit({ action: "test.self_audit", entityType: "things", entityId: "t1" });
      await ctx.audit({ action: "test.extra_row", entityType: "things", entityId: "t1" });
      return {};
    });
    await run({});
    expect(await handle.db.select().from(auditLog).where(eq(auditLog.action, "test.self_audit"))).toHaveLength(1);
    expect(await handle.db.select().from(auditLog).where(eq(auditLog.action, "test.extra_row"))).toHaveLength(1);
  });

  it("writes no automatic audit row for public actions and rolls back failed handlers", async () => {
    const run = action({ name: "test.public_fail", audience: "public", input: z.object({}) }, async (ctx) => {
      await ctx.audit({ action: "test.rolled_back", entityType: "things" });
      throw new ConflictError();
    });
    expect((await run({})).ok).toBe(false);
    expect(await handle.db.select().from(auditLog).where(eq(auditLog.action, "test.rolled_back"))).toHaveLength(0);
  });

  it("passes exactly the enqueued job ids to after() and runJobs (PL-34)", async () => {
    await signInStaff(["*"]);
    let id = "";
    const run = action({ name: "test.enqueue", audience: "staff", input: z.object({}) }, async (ctx) => {
      ({ id } = await ctx.enqueue({ kind: "jobs.prune", payload: {}, key: `test:enqueue:${Date.now()}` }));
      return {};
    });
    expect((await run({})).ok).toBe(true);
    expect(afterCallbacks).toHaveLength(1);
    await afterCallbacks[0]!();
    expect(runJobsMock).toHaveBeenCalledWith({ ids: [id], budgetMs: 8000 });
    expect(await handle.db.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, id))).toHaveLength(1);
  });

  it("does not call after() when nothing was enqueued or the handler failed", async () => {
    await signInStaff(["*"]);
    const run = action({ name: "test.no_jobs", audience: "staff", input: z.object({}) }, () => Promise.resolve({}));
    await run({});
    expect(afterCallbacks).toHaveLength(0);
  });

  it("counts rate limits before the handler and answers rate_limited", async () => {
    const handler = vi.fn(() => Promise.resolve({}));
    const run = action(
      { name: "test.limited", audience: "public", input: z.object({ email: z.string() }), rateLimit: (i, { ip }) => ({ route: "login", ip, email: i.email }) },
      handler,
    );
    for (let i = 0; i < 10; i++) expect((await run({ email: "limit@example.com" })).ok).toBe(true);
    const result = await run({ email: "limit@example.com" });
    expect(result).toMatchObject({ ok: false, error: { code: "rate_limited" } });
    expect(handler).toHaveBeenCalledTimes(10);
  });
});
