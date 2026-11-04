/**
 * `automation.sweep_enrolments` (automation-P3): the A-35 fallback for a dead step whose
 * `onDead` hook threw (one `failed` run, a second sweep writes nothing), completion of
 * enrolments with nothing left, and the A-45 health alerts at their thresholds (one Slack job
 * per fingerprint per hour).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle, Tx } from "@beam/db";
import { automationEnrolments, automationRuns, jobs as jobsTable } from "@beam/db/schema";
import { createTestDb, makePerson } from "@beam/db/testing";
import { and, eq } from "@/lib/ctx";
import { makeCtx, resetRuntime } from "@/lib/testing";
import type * as EmailApi from "@/modules/email/api";

vi.mock("@/modules/email/api", async (orig) => ({
  ...(await orig<typeof EmailApi>()),
  getReachability: vi.fn(() => Promise.resolve({ isReachable: true, blockedReason: null })),
}));

const { sweepEnrolments } = await import("./sweep");
const { healthAlerts, readHealth, FAILED_RUNS_PER_HOUR_LIMIT } = await import("./health");
const { stepJobKey } = await import("./step");
const f = await import("./automation-p3.fixtures");

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  await f.resetAutomations(h.db);
  await f.resetJobs(h.db);
  await f.setCursor(h.db, await f.maxEventId(h.db));
});

const M = 60_000;
const now = new Date();
const tx = () => h.db as unknown as Tx;
const sweep = (at = now) => sweepEnrolments(tx(), makeCtx(h.db, { now: at }), at);
const slackJobs = async () =>
  (await h.db.select().from(jobsTable).where(eq(jobsTable.kind, "notify.slack"))).map((j) => (j.payload as { fingerprint: string }).fingerprint).sort();

const twoSteps = () =>
  f.steps([
    { key: "a", type: "tag", tag: "engaged", at: { from: "enrolment", minutes: 0 } },
    { key: "b", type: "tag", tag: "engaged", at: { from: "enrolment", minutes: 600 } },
  ]);

async function insertRun(personId: string, automationId: string, outcome: "failed" | "skipped_translation", occurredAt: Date, data: Record<string, unknown> = {}) {
  await h.db.insert(automationRuns).values({ personId, automationId, outcome, occurredAt, data, actor: { kind: "system", id: null } });
}

describe("A-35 sweep fallback", () => {
  it("A-35 a dead step job without a failed run (hook threw) gets one; a second sweep writes nothing", async () => {
    const a = await f.makeAutomation(h.db, { isMarketing: false, definition: twoSteps() });
    const id = await f.enrolInto(h.db, a.id, (await makePerson(h.db)).id, { now: new Date(now.getTime() - 5 * M) });
    await h.db.insert(jobsTable).values({
      kind: "automation.step",
      payload: { enrolmentId: id, stepKey: "a" },
      idempotencyKey: stepJobKey(id, "a"),
      lane: "fast",
      status: "dead",
      attempts: 6,
      lastError: "PermanentError: renderer bug",
      finishedAt: new Date(now.getTime() - M),
      result: { on_dead_at: new Date(now.getTime() - M).toISOString() },
    });
    expect(await sweep()).toMatchObject({ deadRecorded: 1 });
    const failed = await h.db.select().from(automationRuns).where(and(eq(automationRuns.enrolmentId, id), eq(automationRuns.outcome, "failed")));
    expect(failed.map((r) => [r.stepKey, r.reason])).toEqual([["a", "permanent:PermanentError: renderer bug"]]);
    expect((await f.enrolmentRow(h.db, id)).nextStepKey).toBe("b");
    expect(await sweep()).toMatchObject({ deadRecorded: 0 });
    expect(await h.db.select().from(automationRuns).where(and(eq(automationRuns.enrolmentId, id), eq(automationRuns.outcome, "failed")))).toHaveLength(1);
  });

  it("A-35 dead jobs older than 7 days are left alone", async () => {
    const a = await f.makeAutomation(h.db, { isMarketing: false, definition: twoSteps() });
    const id = await f.enrolInto(h.db, a.id, (await makePerson(h.db)).id, { now });
    await h.db.insert(jobsTable).values({
      kind: "automation.step",
      payload: { enrolmentId: id, stepKey: "a" },
      idempotencyKey: stepJobKey(id, "a"),
      lane: "fast",
      status: "dead",
      finishedAt: new Date(now.getTime() - 8 * 24 * 60 * M),
    });
    expect(await sweep()).toMatchObject({ deadRecorded: 0 });
  });

  it("completes an active enrolment with no next step and no pending plan entry", async () => {
    const a = await f.makeAutomation(h.db, { isMarketing: false, definition: twoSteps() });
    const id = await f.enrolInto(h.db, a.id, (await makePerson(h.db)).id, { now });
    const row = await f.enrolmentRow(h.db, id);
    await h.db
      .update(automationEnrolments)
      .set({ nextStepKey: null, nextStepAt: null, plan: row.plan.map((p) => ({ ...p, state: "done" as const })) })
      .where(eq(automationEnrolments.id, id));
    expect(await sweep()).toMatchObject({ completed: 1 });
    expect(await f.enrolmentRow(h.db, id)).toMatchObject({ status: "completed", endReason: "completed" });
  });
});

describe("A-45 health alerts", () => {
  it("A-45 stuck: more than 30 minutes past next_step_at alerts, 29 minutes does not", async () => {
    const a = await f.makeAutomation(h.db, { isMarketing: false, definition: twoSteps() });
    const id = await f.enrolInto(h.db, a.id, (await makePerson(h.db)).id, { now });
    await f.makeDue(h.db, id, new Date(now.getTime() - 29 * M));
    expect((await readHealth(h.db, now)).stuck).toBe(0);
    expect(await sweep()).toMatchObject({ alerts: [] });
    await f.makeDue(h.db, id, new Date(now.getTime() - 31 * M));
    expect((await readHealth(h.db, now)).stuck).toBe(1);
    expect((await sweep()).alerts).toEqual(["automation-stuck"]);
  });

  it("A-45 lag: the oldest unprocessed event older than 5 minutes alerts, 4 minutes does not", async () => {
    const p = await makePerson(h.db);
    await f.makeEvent(h.db, { personId: p.id, kind: "test.happened", occurredAt: new Date(now.getTime() - 4 * M) });
    expect((await sweep()).alerts).toEqual([]);
    const later = new Date(now.getTime() + 2 * M + 1_000);
    expect((await readHealth(h.db, later)).lagSeconds).toBeGreaterThan(300);
    expect((await sweep(later)).alerts).toEqual(["automation-lag"]);
  });

  it("A-45 failures: more than 20 failed runs in the last hour alert, exactly 20 do not", async () => {
    const a = await f.makeAutomation(h.db, { isMarketing: false });
    const p = await makePerson(h.db);
    for (let i = 0; i < FAILED_RUNS_PER_HOUR_LIMIT; i++) await insertRun(p.id, a.id, "failed", new Date(now.getTime() - 10 * M));
    await insertRun(p.id, a.id, "failed", new Date(now.getTime() - 61 * M));
    expect((await sweep()).alerts).toEqual([]);
    await insertRun(p.id, a.id, "failed", new Date(now.getTime() - 5 * M));
    expect((await sweep()).alerts).toEqual(["automation-failures"]);
  });

  it("A-45 skipped_translation alerts with severity normal per template", async () => {
    const a = await f.makeAutomation(h.db, { isMarketing: false });
    const p = await makePerson(h.db);
    await insertRun(p.id, a.id, "skipped_translation", new Date(now.getTime() - 5 * M), { template_slug: "welcome-lead-welcome" });
    await sweep();
    const [job] = await h.db.select().from(jobsTable).where(eq(jobsTable.kind, "notify.slack"));
    expect(job!.payload).toMatchObject({ fingerprint: "automation-translation:welcome-lead-welcome", severity: "normal" });
  });

  it("A-45 one Slack job per fingerprint per hour, however many sweeps", async () => {
    const a = await f.makeAutomation(h.db, { isMarketing: false, definition: twoSteps() });
    const id = await f.enrolInto(h.db, a.id, (await makePerson(h.db)).id, { now });
    await f.makeDue(h.db, id, new Date(now.getTime() - 60 * M));
    await sweep();
    await sweep(new Date(now.getTime() + 1_000));
    expect(await slackJobs()).toEqual(["automation-stuck"]);
    const [job] = await h.db.select().from(jobsTable).where(eq(jobsTable.kind, "notify.slack"));
    expect(job!.payload).toMatchObject({ severity: "high" });
  });

  it("A-45 healthAlerts thresholds (pure)", () => {
    const base = { stuck: 0, lagSeconds: 300, failedLastHour: 20, translationSkips: [] };
    expect(healthAlerts(base)).toEqual([]);
    expect(healthAlerts({ ...base, stuck: 1, lagSeconds: 301, failedLastHour: 21 }).map((x) => [x.fingerprint, x.severity])).toEqual([
      ["automation-stuck", "high"],
      ["automation-lag", "high"],
      ["automation-failures", "high"],
    ]);
  });
});
