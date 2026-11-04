/**
 * automation jobs run twice with the same payload leave the same state (conventions: every job
 * runs twice in `jobs.test.ts`). Covers the kinds and the schedule automation-P2 declares.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle, Tx } from "@beam/db";
import { automationEnrolments, automationRuns, jobs as jobsTable, suppressions } from "@beam/db/schema";
import { createTestDb, makePerson } from "@beam/db/testing";
import { emailHash } from "@beam/core/crm";
import { asc, eq, sql } from "@/lib/ctx";
import { loadJobs, loadSchedules } from "@/lib/job-runner";
import { resetRuntime, runJobTwice } from "@/lib/testing";
import { def, makeAutomation, makeEvent, maxEventId, resetAutomations, setCursor } from "./engine/automation-p2.fixtures";
import { readCursor } from "./engine/cursor";
import { jobs } from "./jobs";
import { schedules } from "./schedules";

import type * as EmailApi from "@/modules/email/api";
vi.mock("@/modules/email/api", async (orig) => ({
  ...(await orig<typeof EmailApi>()),
  getReachability: vi.fn(() => Promise.resolve({ isReachable: true, blockedReason: null })),
}));

const { enrol } = await import("./engine/enrol");

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  await resetAutomations(h.db);
  await h.db.execute(sql`delete from jobs`);
  await setCursor(h.db, await maxEventId(h.db));
});

const snapshot = async () => ({
  enrolments: await h.db
    .select({ id: automationEnrolments.id, status: automationEnrolments.status, endReason: automationEnrolments.endReason, next: automationEnrolments.nextStepKey })
    .from(automationEnrolments)
    .orderBy(asc(automationEnrolments.id)),
  runs: await h.db.select({ key: automationRuns.dedupeKey, outcome: automationRuns.outcome }).from(automationRuns).orderBy(asc(automationRuns.dedupeKey)),
  jobs: await h.db.select({ kind: jobsTable.kind, key: jobsTable.idempotencyKey }).from(jobsTable).orderBy(asc(jobsTable.idempotencyKey)),
  cursor: (await readCursor(h.db)).last_event_id,
});

async function twice(kind: Parameters<typeof runJobTwice>[1], payload: unknown) {
  let afterFirst: unknown;
  const result = await runJobTwice(h.db, kind, payload, { between: async () => void (afterFirst = await snapshot()) });
  expect(await snapshot()).toEqual(afterFirst);
  return { ...result, afterFirst: afterFirst as Awaited<ReturnType<typeof snapshot>> };
}

describe("automation jobs", () => {
  it("registers the evaluator and the suppression exit, and the per-minute evaluator schedule", async () => {
    const registry = await loadJobs();
    for (const j of jobs) expect(registry[j.kind]).toBe(j);
    expect(jobs.map((j) => [j.kind, j.lane, j.priority, j.maxAttempts, j.timeoutMs])).toEqual(
      expect.arrayContaining([
        ["automation.evaluate", "fast", 3, 2, 45_000],
        ["automation.exit_for_suppression", "fast", 1, 6, 20_000],
      ]),
    );
    const evaluator = { kind: "automation.evaluate", cron: "* * * * *", payload: {}, catchUp: false };
    expect(schedules).toEqual(expect.arrayContaining([evaluator]));
    expect((await loadSchedules()).filter((s) => s.kind === "automation.evaluate")).toEqual([evaluator]);
  });

  it("automation.evaluate twice: the second run finds nothing new", async () => {
    await makeAutomation(h.db, { definition: def({ steps: [{ key: "s1", type: "tag", tag: "x" }] }) });
    const exiting = await makeAutomation(h.db, { isMarketing: false, definition: def({ trigger: { manual: true }, exit_on: ["test.ended"] }) });
    const p = await makePerson(h.db);
    await enrol(h.db as unknown as Tx, { automation: exiting.id, personId: p.id, source: "staff", actor: { kind: "system", jobId: "" }, now: new Date() });
    await makeEvent(h.db, { personId: p.id, kind: "test.happened" });
    await makeEvent(h.db, { personId: p.id, kind: "test.ended" });
    const { first, second, afterFirst } = await twice("automation.evaluate", {});
    expect(first).toMatchObject({ processed: 2, enrolled: 1, exited: 1, dueEnqueued: 1 });
    expect(second).toMatchObject({ processed: 0, enrolled: 0, exited: 0, dueEnqueued: 0 });
    expect(afterFirst.jobs.map((j) => j.kind)).toEqual(["automation.step"]);
  });

  it("automation.evaluate as a continuation accepts its payload", async () => {
    const { first } = await twice("automation.evaluate", { continuation: true });
    expect(first).toMatchObject({ processed: 0, continued: false });
  });

  it("automation.exit_for_suppression twice: the second run ends nothing", async () => {
    const email = `jobs-${Date.now()}@example.com`;
    const p = await makePerson(h.db, { email, emailHash: emailHash(email) });
    const a = await makeAutomation(h.db, { definition: def({ trigger: { manual: true } }) });
    await enrol(h.db as unknown as Tx, { automation: a.id, personId: p.id, source: "staff", actor: { kind: "system", jobId: "" }, now: new Date() });
    const [supp] = await h.db
      .insert(suppressions)
      .values({ emailHash: emailHash(email), email, scope: "all", reason: "unsubscribe", source: "test", personId: p.id, actor: { kind: "system", id: null } })
      .returning();
    const { first, second, afterFirst } = await twice("automation.exit_for_suppression", { suppressionId: supp!.id });
    expect(first).toEqual({ exited: 1, persons: 1 });
    expect(second).toEqual({ exited: 0, persons: 1 });
    expect(afterFirst.enrolments).toEqual([expect.objectContaining({ status: "exited", endReason: "unsubscribed" })]);
  });

  it("automation.exit_for_suppression for an unknown suppression is a no-op", async () => {
    const { first } = await twice("automation.exit_for_suppression", { suppressionId: "00000000-0000-4000-8000-000000000001" });
    expect(first).toEqual({ exited: 0, persons: 0 });
  });

  it("requestSuppressionExit enqueues once per suppression (key supp:<id>)", async () => {
    const { requestSuppressionExit } = await import("./api");
    const id = "00000000-0000-4000-8000-000000000002";
    const a = await requestSuppressionExit(h.db as unknown as Tx, { suppressionId: id });
    const b = await requestSuppressionExit(h.db as unknown as Tx, { suppressionId: id });
    expect(a.jobId).toBe(b.jobId);
    const rows = await h.db.select().from(jobsTable).where(eq(jobsTable.idempotencyKey, `supp:${id}`));
    expect(rows.map((r) => [r.kind, r.lane, r.priority])).toEqual([["automation.exit_for_suppression", "fast", 1]]);
  });
});
