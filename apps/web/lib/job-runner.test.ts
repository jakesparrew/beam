import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@beam/db/testing";
import { enqueue, type DbHandle } from "@beam/db";
import { jobs } from "@beam/db/schema";
import { PermanentError } from "@beam/core/errors";
import { localHourKey } from "@beam/core/platform";

const state = vi.hoisted(() => ({
  runs: new Map<string, number>(),
  hookCalls: [] as { jobId: string; statusSeen: string; message: string }[],
  hookThrows: false,
}));

vi.mock("@/registry/jobs.generated", async (importOriginal) => {
  const original = (await importOriginal()) as { JOB_BY_KIND: Record<string, unknown> };
  const { z } = await import("zod");
  const { PermanentError: Perm } = await import("@beam/core/errors");
  const { sql } = await import("@/lib/ctx");
  const base = { lane: "fast", priority: 5, maxAttempts: 6, timeoutMs: 5000, inline: false } as const;
  const count = (id: string) => state.runs.set(id, (state.runs.get(id) ?? 0) + 1);
  const testJobs = {
    "test.ok": { ...base, kind: "test.ok", input: z.object({ n: z.number().optional() }), run: (ctx: { job: { id: string } }) => Promise.resolve(count(ctx.job.id)) },
    "test.fail": { ...base, kind: "test.fail", input: z.object({}), run: () => Promise.reject(new Error("boom")) },
    "test.permanent": { ...base, kind: "test.permanent", input: z.object({}), run: () => Promise.reject(new Perm("nope")) },
    "test.slow": { ...base, kind: "test.slow", timeoutMs: 50, input: z.object({}), run: () => new Promise((r) => setTimeout(r, 400)) },
    "test.hook": {
      ...base,
      kind: "test.hook",
      input: z.object({}),
      run: () => Promise.reject(new Perm("hook me")),
      onDead: async (ctx: { tx: { execute: (q: unknown) => Promise<{ rows: { status: string }[] }> }; job: { id: string } }, _i: unknown, err: { message: string }) => {
        const r = await ctx.tx.execute(sql`select status::text as status from jobs where id = ${ctx.job.id}::uuid`);
        state.hookCalls.push({ jobId: ctx.job.id, statusSeen: r.rows[0]!.status, message: err.message });
        if (state.hookThrows) throw new Error("hook failed");
      },
    },
    "payments.create": { ...base, kind: "payments.create", inline: true, input: z.object({ amount: z.number() }), run: (_c: unknown, i: { amount: number }) => Promise.resolve({ doubled: i.amount * 2 }) },
  };
  return { ...original, JOB_BY_KIND: { ...original.JOB_BY_KIND, ...testJobs } };
});

import { claimJobs, pruneJobs, reclaimStaleLocks, runJobInline, runJobs } from "./job-runner";
import { createFakeIntegrations, fakeSentry, resetRuntime } from "./testing";
import { eq, setAppDb, sql } from "./ctx";

let handle: DbHandle;
const integrations = createFakeIntegrations();

beforeAll(async () => {
  handle = await createTestDb();
  setAppDb(handle.db);
});
afterAll(async () => {
  resetRuntime();
  await handle.close();
});
beforeEach(async () => {
  await handle.db.execute(sql`delete from jobs`);
  state.runs.clear();
  state.hookCalls.length = 0;
  state.hookThrows = false;
});

const add = (kind: string, key: string, extra: Partial<Parameters<typeof enqueue>[1]> = {}) =>
  enqueue(handle.db, { kind, payload: {}, key, ...extra });
const job = async (id: string) => (await handle.db.select().from(jobs).where(eq(jobs.id, id)))[0]!;
const run = (extra: Parameters<typeof runJobs>[0] extends infer O ? Partial<O> : never = {}) =>
  runJobs({ budgetMs: 5000, db: handle.db, integrations, ...extra });

describe("claiming", () => {
  it("claims by priority, then run_at", async () => {
    const t = (min: number) => new Date(Date.now() - min * 60_000);
    const a = await add("test.ok", "a", { priority: 5, runAt: t(3) });
    const b = await add("test.ok", "b", { priority: 2, runAt: t(1) });
    const c = await add("test.ok", "c", { priority: 2, runAt: t(2) });
    const order: string[] = [];
    for (let i = 0; i < 3; i++) order.push((await claimJobs(handle.db, "fast", 1, "tick:test"))[0]!.id);
    expect(order).toEqual([c.id, b.id, a.id]);
    expect(await claimJobs(handle.db, "fast", 1, "tick:test")).toEqual([]);
  });

  it("does not claim jobs that are not due", async () => {
    await add("test.ok", "later", { runAt: new Date(Date.now() + 60_000) });
    expect(await claimJobs(handle.db, "fast", 5, "tick:test")).toEqual([]);
  });

  it("two concurrent runJobs never run one job twice", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) ids.push((await add("test.ok", `c:${i}`)).id);
    const [s1, s2] = await Promise.all([run({ tickId: "tick:1" }), run({ tickId: "tick:2" })]);
    expect(s1.succeeded + s2.succeeded).toBe(30);
    for (const id of ids) expect(state.runs.get(id)).toBe(1);
  });
});

describe("failures", () => {
  it("retries after 60, 300, 900, 3600 and 21600 s, then dead (PL-26, PL-27)", async () => {
    const { id } = await add("test.fail", "f");
    const now = new Date();
    const delays: number[] = [];
    for (let attempt = 1; attempt <= 6; attempt++) {
      await run({ now: () => now, random: () => 0 });
      const row = await job(id);
      expect(row.attempts).toBe(attempt);
      expect(row.status).not.toBe("failed");
      if (attempt < 6) {
        expect(row.status).toBe("pending");
        expect(row.lastError).toContain("boom");
        delays.push(Math.round((row.runAt.getTime() - now.getTime()) / 1000));
        await handle.db.update(jobs).set({ runAt: new Date(Date.now() - 1000) }).where(eq(jobs.id, id));
      } else {
        expect(row.status).toBe("dead");
      }
    }
    expect(delays).toEqual([60, 300, 900, 3600, 21600]);
  });

  it("adds 0-20 % jitter", async () => {
    const { id } = await add("test.fail", "jitter");
    const now = new Date();
    await run({ now: () => now, random: () => 0.999 });
    const delay = ((await job(id)).runAt.getTime() - now.getTime()) / 1000;
    expect(delay).toBeGreaterThan(71);
    expect(delay).toBeLessThanOrEqual(72);
  });

  it("PermanentError, a bad payload and an unknown kind go dead at once (PL-28)", async () => {
    const p = await add("test.permanent", "p");
    const bad = await enqueue(handle.db, { kind: "test.ok", payload: { n: "not a number" }, key: "bad" });
    const unknown = await enqueue(handle.db, { kind: "test.unknown", payload: {}, key: "unknown" });
    await run();
    for (const id of [p.id, bad.id, unknown.id]) {
      const row = await job(id);
      expect(row.status).toBe("dead");
      expect(row.attempts).toBe(1);
    }
    expect((await job(bad.id)).lastError).toContain("invalid_payload");
    expect((await job(unknown.id)).lastError).toContain("unknown_job_kind");
  });

  it("a dead job reports to Sentry and enqueues one notify.slack per kind per hour (PL-29)", async () => {
    const sentry = fakeSentry();
    await add("test.permanent", "d1");
    await add("test.permanent", "d2");
    await run({ lanes: ["fast"], ids: undefined });
    const slack = await handle.db.select().from(jobs).where(eq(jobs.kind, "notify.slack"));
    expect(slack.filter((j) => j.idempotencyKey.startsWith("slack:dead:test.permanent:"))).toHaveLength(1);
    expect(slack[0]!.idempotencyKey).toBe(`slack:dead:test.permanent:${localHourKey(new Date())}`);
    expect(sentry.exceptions.filter((e) => e.tags?.job_kind === "test.permanent")).toHaveLength(2);
    sentry.restore();
  });

  it("a dead notify.slack job only goes to Sentry", async () => {
    const sentry = fakeSentry();
    await enqueue(handle.db, { kind: "notify.slack", payload: { bad: true }, key: "slack:x" });
    await run();
    const rows = await handle.db.select().from(jobs);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("dead");
    expect(sentry.exceptions).toHaveLength(1);
    sentry.restore();
  });

  it("a job over its timeout rolls back and retries (edge case 4)", async () => {
    const { id } = await add("test.slow", "slow");
    await run();
    const row = await job(id);
    expect(row.status).toBe("pending");
    expect(row.lastError).toContain("timeout");
  });

  it("reclaims a running job locked more than 10 minutes ago (PL-30)", async () => {
    const { id } = await add("test.ok", "stale");
    await handle.db
      .update(jobs)
      .set({ status: "running", lockedAt: new Date(Date.now() - 11 * 60_000), lockedBy: "tick:dead", attempts: 2 })
      .where(eq(jobs.id, id));
    const fresh = await add("test.ok", "fresh");
    await handle.db.update(jobs).set({ status: "running", lockedAt: new Date(), lockedBy: "tick:live", attempts: 1 }).where(eq(jobs.id, fresh.id));
    expect(await reclaimStaleLocks(handle.db)).toBe(1);
    const row = await job(id);
    expect(row).toMatchObject({ status: "pending", lastError: "stale lock", attempts: 2, lockedAt: null });
    expect((await job(fresh.id)).status).toBe("running");
  });
});

describe("onDead (PL-29a)", () => {
  it("runs once after the dead status commits", async () => {
    const { id } = await add("test.hook", "h");
    await run();
    expect(state.hookCalls).toEqual([{ jobId: id, statusSeen: "dead", message: expect.stringContaining("hook me") }]);
    const row = await job(id);
    expect((row.result as { on_dead_at?: string }).on_dead_at).toBeTruthy();
  });

  it("a throwing hook leaves the job dead and reports to Sentry", async () => {
    state.hookThrows = true;
    const sentry = fakeSentry();
    const { id } = await add("test.hook", "h2");
    await run();
    expect((await job(id)).status).toBe("dead");
    expect(sentry.exceptions.some((e) => e.tags?.where === "onDead")).toBe(true);
    sentry.restore();
  });

  it("retry clears on_dead_at so a later dead transition calls the hook again", async () => {
    const { id } = await add("test.hook", "h3");
    await run();
    // What retryJob does: dead -> pending, run_at now, max_attempts + 3, on_dead_at removed.
    await handle.db.execute(sql`update jobs set status = 'pending', run_at = now(), max_attempts = attempts + 3, result = result - 'on_dead_at' where id = ${id}::uuid`);
    await run();
    expect(state.hookCalls).toHaveLength(2);
  });
});

describe("inline jobs and pruning", () => {
  it("runJobInline refuses a kind that is not inline (PL-35)", async () => {
    await expect(runJobInline("test.ok" as never, {}, { key: "inline:x", requestId: "r1", db: handle.db, integrations })).rejects.toThrow(/not an inline job/);
  });

  it("runJobInline runs an inline kind as a logged job and returns its result", async () => {
    const result = await runJobInline<{ doubled: number }>("payments.create" as never, { amount: 21 }, { key: "pay:1", requestId: "r2", db: handle.db, integrations });
    expect(result).toEqual({ doubled: 42 });
    const [row] = await handle.db.select().from(jobs).where(eq(jobs.idempotencyKey, "pay:1"));
    expect(row).toMatchObject({ status: "succeeded", lockedBy: null, requestId: "r2" });
  });

  it("jobs.prune deletes succeeded jobs after 7 days and dead jobs after 90 (PL-31)", async () => {
    const day = 86_400_000;
    const mk = async (key: string, status: "succeeded" | "dead", ageDays: number) => {
      const { id } = await add("test.ok", key);
      await handle.db.update(jobs).set({ status, finishedAt: new Date(Date.now() - ageDays * day) }).where(eq(jobs.id, id));
      return id;
    };
    await mk("s8", "succeeded", 8);
    const s6 = await mk("s6", "succeeded", 6);
    await mk("d91", "dead", 91);
    const d89 = await mk("d89", "dead", 89);
    const pending = (await add("test.ok", "p")).id;
    expect(await pruneJobs(handle.db)).toBe(2);
    const left = (await handle.db.select({ id: jobs.id }).from(jobs)).map((r) => r.id).sort();
    expect(left).toEqual([s6, d89, pending].sort());
  });

  it("PermanentError is re-exported for job handlers", () => {
    expect(new PermanentError("x").retryable).toBe(false);
  });
});
