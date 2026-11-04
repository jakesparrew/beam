/**
 * A-35 (automation-P3): the `onDead` hook of `automation.step` and `automation.call_webhook`
 * (`recordDeadStep`): one `failed` run, the step job advances the enrolment, the webhook job
 * writes the run only; an ended enrolment is a no-op; a second call writes nothing. One case
 * goes through the real job runner (attempts used up -> dead -> hook).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle, Tx } from "@beam/db";
import { automationEnrolments, automationRuns, jobs as jobsTable } from "@beam/db/schema";
import { createTestDb, makePerson } from "@beam/db/testing";
import { and, eq } from "@/lib/ctx";
import { runJobs } from "@/lib/job-runner";
import { createFakeIntegrations, resetRuntime } from "@/lib/testing";
import type * as EmailApi from "@/modules/email/api";

const state = vi.hoisted(() => ({ throwTemplates: false }));
vi.mock("@/modules/email/api", async (orig) => ({
  ...(await orig<typeof EmailApi>()),
  getReachability: vi.fn(() => Promise.resolve({ isReachable: true, blockedReason: null })),
  getPublishedTemplateInfo: vi.fn(() => (state.throwTemplates ? Promise.reject(new Error("renderer bug")) : Promise.resolve(new Map()))),
}));

const { recordDeadStep } = await import("./advance");
const { stepJobKey } = await import("./step");
const f = await import("./automation-p3.fixtures");

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
  await f.makeTag(h.db, "engaged");
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  state.throwTemplates = false;
  await f.resetJobs(h.db);
});

const now = new Date();
const SYSTEM = { kind: "system", jobId: "dead-job" } as const;
const hook = (enrolmentId: string, stepKey: string, kind: "automation.step" | "automation.call_webhook" = "automation.step", permanent = false) =>
  recordDeadStep({ tx: h.db as unknown as Tx, actor: SYSTEM, now }, { enrolmentId, stepKey }, { message: "Error: boom ".repeat(40), permanent }, kind);
const failedRuns = (enrolmentId: string) => h.db.select().from(automationRuns).where(and(eq(automationRuns.enrolmentId, enrolmentId), eq(automationRuns.outcome, "failed")));

const twoSteps = () =>
  f.steps([
    { key: "mail", type: "email", template: "automation.x", at: { from: "enrolment", minutes: 0 } },
    { key: "after", type: "tag", tag: "engaged", at: { from: "enrolment", minutes: 60 } },
  ]);

describe("A-35 recordDeadStep", () => {
  it("A-35 a dead automation.step writes one failed run (first 200 characters, permanent: prefix) and advances the enrolment", async () => {
    const a = await f.makeAutomation(h.db, { isMarketing: false, definition: twoSteps() });
    const id = await f.enrolInto(h.db, a.id, (await makePerson(h.db)).id, { now });
    expect(await hook(id, "mail", "automation.step", true)).toEqual({ written: true, advanced: true });
    const [run] = await failedRuns(id);
    expect(run!.stepKey).toBe("mail");
    expect(run!.reason!.startsWith("permanent:Error: boom")).toBe(true);
    expect(run!.reason).toHaveLength(200);
    expect(run!.dedupeKey).toBe(`run:${id}:mail:failed`);
    const row = await f.enrolmentRow(h.db, id);
    expect(row.nextStepKey).toBe("after");
    expect(row.plan.find((p) => p.key === "mail")?.state).toBe("skipped");
  });

  it("A-35 a dead call_webhook writes the run only (the enrolment already advanced), also after it completed", async () => {
    const a = await f.makeAutomation(h.db, { isMarketing: false, definition: f.steps([{ key: "w", type: "webhook", url: "https://hooks.example.com/x" }]) });
    const id = await f.enrolInto(h.db, a.id, (await makePerson(h.db)).id, { now });
    await h.db.update(automationEnrolments).set({ status: "completed", endedAt: now, endReason: "completed", nextStepKey: null, nextStepAt: null }).where(eq(automationEnrolments.id, id));
    expect(await hook(id, "w", "automation.call_webhook")).toEqual({ written: true, advanced: false });
    expect(await failedRuns(id)).toHaveLength(1);
    expect((await f.enrolmentRow(h.db, id)).status).toBe("completed");
  });

  it("A-35 for an ended enrolment (step job) or a missing one the hook is a no-op", async () => {
    const a = await f.makeAutomation(h.db, { isMarketing: false, definition: twoSteps() });
    const id = await f.enrolInto(h.db, a.id, (await makePerson(h.db)).id, { now });
    await h.db.update(automationEnrolments).set({ status: "exited", endedAt: now, endReason: "manual", nextStepKey: null, nextStepAt: null }).where(eq(automationEnrolments.id, id));
    expect(await hook(id, "mail")).toEqual({ written: false, advanced: false });
    expect(await hook("00000000-0000-4000-8000-00000000dead", "mail")).toEqual({ written: false, advanced: false });
    expect(await failedRuns(id)).toEqual([]);
  });

  it("A-35 called twice it writes one row and advances once", async () => {
    const a = await f.makeAutomation(h.db, { isMarketing: false, definition: twoSteps() });
    const id = await f.enrolInto(h.db, a.id, (await makePerson(h.db)).id, { now });
    await hook(id, "mail");
    expect(await hook(id, "mail")).toEqual({ written: false, advanced: false });
    expect(await failedRuns(id)).toHaveLength(1);
    expect((await f.enrolmentRow(h.db, id)).nextStepKey).toBe("after");
  });
});

describe("A-35 through the job runner", () => {
  it("A-35 edge 33 a step job that dies calls onDead: failed run, enrolment advanced, platform's dead alert queued", async () => {
    const a = await f.makeAutomation(h.db, { isMarketing: false, definition: twoSteps() });
    const id = await f.enrolInto(h.db, a.id, (await makePerson(h.db)).id, { now });
    state.throwTemplates = true;
    const [job] = await h.db
      .insert(jobsTable)
      .values({ kind: "automation.step", payload: { enrolmentId: id, stepKey: "mail" }, idempotencyKey: stepJobKey(id, "mail"), lane: "fast", maxAttempts: 1 })
      .returning();
    const summary = await runJobs({ db: h.db, ids: [job!.id], budgetMs: 10_000, integrations: createFakeIntegrations() });
    expect(summary.dead).toBe(1);
    const [dead] = await h.db.select().from(jobsTable).where(eq(jobsTable.id, job!.id));
    expect(dead!.status).toBe("dead");
    const [run] = await failedRuns(id);
    expect(run!.reason).toContain("renderer bug");
    expect((await f.enrolmentRow(h.db, id)).nextStepKey).toBe("after");
    const alerts = await h.db.select().from(jobsTable).where(eq(jobsTable.kind, "notify.slack"));
    expect(alerts.length).toBeGreaterThan(0);
  });
});
