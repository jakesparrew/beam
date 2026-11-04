/**
 * fix-w09-finance-review finding 2: `billit.reconcile` is self-continuing. Each job checks one
 * chunk (2 documents here), merges it into the day's run and enqueues the next chunk with
 * `billit:reconcile:<run_on>:after:<id>`; only the last chunk scans unknown orders, checks the
 * sequences, finishes the run and alerts. The job's timeout fits the tick's headroom.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { billitReconcileRuns, jobs } from "@beam/db/schema";
import { eq, sql } from "@/lib/ctx";
import { createFakeIntegrations, type FakeIntegrations } from "@/lib/testing";
import { JOB_BY_KIND } from "@/registry/jobs.generated";
import { paidB2c, runJob, slackJobs } from "./finance-p4.helpers";
import { NOW, setupDb } from "./service/__tests__/fixtures";
import { reconcileContinuationKey } from "./jobs";

vi.mock("./service/reconcile", async (importOriginal) => ({ ...(await importOriginal<object>()), RECONCILE_CHUNK: 2 }));

let h: DbHandle;
const fakes: FakeIntegrations = createFakeIntegrations();
const LATER = new Date(NOW.getTime() + 2 * 3_600_000);
let numbers: string[] = [];

beforeAll(async () => {
  h = await setupDb();
  numbers = [];
  for (let i = 0; i < 5; i++) numbers.push((await paidB2c(h.db)).number);
});
afterAll(() => h.close());

type Result = { status: string; afterId?: string; checkedCount?: number };
const runOf = async (runOn: string) => (await h.db.select().from(billitReconcileRuns).where(eq(billitReconcileRuns.runOn, runOn)))[0]!;
const jobsLike = (prefix: string) => h.db.select().from(jobs).where(sql`${jobs.idempotencyKey} like ${`${prefix}%`}`);

/** Runs the job, then every continuation it enqueues, until a chunk finishes the run. */
async function runAll(payload: object, now: Date) {
  const results: Result[] = [];
  let next: object | null = payload;
  while (next) {
    const r = await runJob(h.db, "billit.reconcile", next, { integrations: fakes, now });
    expect(r.error).toBeUndefined();
    const result = r.result as Result;
    results.push(result);
    next = null;
    if (result.status === "continued") {
      const [job] = await h.db.select().from(jobs).where(eq(jobs.idempotencyKey, reconcileContinuationKey("2026-11-04", result.afterId!, (payload as { manual?: number }).manual)));
      expect(job).toBeDefined();
      next = job!.payload as object;
    }
  }
  return results;
}

describe("billit.reconcile in chunks", () => {
  it("has a timeout inside the tick's headroom (at most 70 s)", () => {
    expect((JOB_BY_KIND as Record<string, { timeoutMs: number }>)["billit.reconcile"]!.timeoutMs).toBeLessThanOrEqual(70_000);
  });

  it("checks 5 documents in chunks of 2, keeps the run unfinished until the last chunk, and alerts once", async () => {
    const first = await runJob(h.db, "billit.reconcile", {}, { integrations: fakes, now: LATER });
    expect(first.result).toMatchObject({ status: "continued", checkedCount: 2 });
    const during = await runOf("2026-11-04");
    expect(during).toMatchObject({ checkedCount: 2, finishedAt: null });
    expect(await slackJobs(h.db, "billit-reconcile:2026-11-04")).toHaveLength(0);

    const afterId = (first.result as Result).afterId!;
    const [cont] = await h.db.select().from(jobs).where(eq(jobs.idempotencyKey, `billit:reconcile:2026-11-04:after:${afterId}`));
    expect(cont).toMatchObject({ kind: "billit.reconcile", payload: { runOn: "2026-11-04", afterId } });

    let next: object = cont!.payload as object;
    const statuses: string[] = [];
    for (;;) {
      const r = await runJob(h.db, "billit.reconcile", next, { integrations: fakes, now: LATER });
      const result = r.result as Result;
      statuses.push(result.status);
      if (result.status !== "continued") break;
      next = { runOn: "2026-11-04", afterId: result.afterId };
    }
    expect(statuses).toEqual(["continued", "issues"]);

    const run = await runOf("2026-11-04");
    expect(run.checkedCount).toBe(5);
    expect(run.finishedAt).not.toBeNull();
    expect(run.status).toBe("issues");
    expect(run.issuesCount).toBe(run.issues.length);
    const missing = run.issues.filter((i) => i.type === "missing_in_billit").map((i) => i.number).sort();
    expect(missing).toEqual([...numbers].sort());
    expect(await slackJobs(h.db, "billit-reconcile:2026-11-04")).toHaveLength(1);
  });

  it("a re-run the same day starts the run afresh; a manual run's chunks use their own keys", async () => {
    const results = await runAll({ manual: 1 }, new Date(LATER.getTime() + 60_000));
    expect(results.map((r) => r.status)).toEqual(["continued", "continued", "issues"]);
    expect(await jobsLike("billit:reconcile:2026-11-04:manual:1:after:")).toHaveLength(2);
    const run = await runOf("2026-11-04");
    expect(run.checkedCount).toBe(5);
    expect(run.issues.filter((i) => i.type === "missing_in_billit")).toHaveLength(5);
  });

  it("a failing continuation marks the run failed and keeps its issues; the retry finishes it", async () => {
    const runOn = "2026-11-05";
    const at = new Date("2026-11-05T05:15:00Z");
    const first = await runJob(h.db, "billit.reconcile", {}, { integrations: fakes, now: at });
    const afterId = (first.result as Result).afterId!;
    fakes.billit.failNext(null, { status: 503 });
    const failed = await runJob(h.db, "billit.reconcile", { runOn, afterId }, { integrations: fakes, now: at });
    expect(failed.error).toMatchObject({ retryable: true });
    expect(await runOf(runOn)).toMatchObject({ status: "failed", checkedCount: 2 });

    let next: object = { runOn, afterId };
    for (;;) {
      const r = await runJob(h.db, "billit.reconcile", next, { integrations: fakes, now: at });
      const result = r.result as Result;
      if (result.status !== "continued") break;
      next = { runOn, afterId: result.afterId };
    }
    const run = await runOf(runOn);
    expect(run).toMatchObject({ status: "issues", checkedCount: 5 });
    expect(run.finishedAt).not.toBeNull();
  });
});
