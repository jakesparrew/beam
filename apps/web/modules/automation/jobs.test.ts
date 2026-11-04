/**
 * automation jobs run twice with the same payload leave the same state (conventions: every job
 * runs twice in `jobs.test.ts`). Covers the kinds and schedules of automation-P2 (evaluator,
 * suppression exit) and automation-P3 (step, bulk jobs, webhook, sweep).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle, Tx } from "@beam/db";
import { automationEnrolments, automationRuns, automationVersions, jobs as jobsTable, segmentMembers, segments, suppressions, tags } from "@beam/db/schema";
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
import type * as WebhookMod from "@beam/integrations/webhook";
vi.mock("@/modules/email/api", async (orig) => ({
  ...(await orig<typeof EmailApi>()),
  getReachability: vi.fn(() => Promise.resolve({ isReachable: true, blockedReason: null })),
}));
// No network: the job's webhook poster is this counting fake, whichever path the job takes
// (the real client when a secret is set, the process fake under `INTEGRATIONS=fake`).
const webhookFake = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@beam/integrations/webhook", async (orig) => {
  const m = await orig<typeof WebhookMod>();
  const fake = m.createWebhookFake();
  const postWebhook = async (input: Parameters<typeof fake.postWebhook>[0]) => {
    webhookFake.calls++;
    return fake.postWebhook(input);
  };
  return {
    ...m,
    createWebhookClient: () => ({ postWebhook }),
    createWebhookFake: () => ({ ...fake, postWebhook }),
  };
});

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

describe("automation-P3 jobs", () => {
  const SYSTEM = { kind: "system", jobId: "" } as const;
  const tagStep = (key: string, minutes: number) => ({ key, type: "tag" as const, tag: "engaged", at: { from: "enrolment" as const, minutes } });
  const manual = (steps: ReturnType<typeof tagStep>[]) => def({ trigger: { manual: true }, steps });
  const enrolNow = async (automationId: string, at = new Date()) => {
    const p = await makePerson(h.db);
    const r = await enrol(h.db as unknown as Tx, { automation: automationId, personId: p.id, source: "staff", actor: SYSTEM, now: at });
    if (r.status !== "enrolled") throw new Error(r.outcome);
    return r.enrolmentId;
  };

  beforeAll(async () => {
    await h.db.insert(tags).values({ key: "engaged", name: { en: "Engaged", "nl-BE": "Betrokken", "fr-BE": "Engagé" } }).onConflictDoNothing();
  });

  it("registers the P3 kinds with their lanes, priorities, attempts and timeouts, the onDead hooks and the 15-minute sweep", async () => {
    expect(jobs.map((j) => [j.kind, j.lane, j.priority, j.maxAttempts, j.timeoutMs])).toEqual(
      expect.arrayContaining([
        ["automation.step", "fast", 5, 6, 30_000],
        ["automation.resume_enrolments", "bulk", 5, 6, 60_000],
        ["automation.migrate_enrolments", "bulk", 5, 6, 60_000],
        ["automation.end_enrolments", "bulk", 5, 6, 60_000],
        ["automation.enrol_segment", "bulk", 9, 6, 60_000],
        ["automation.call_webhook", "fast", 5, 6, 15_000],
        ["automation.sweep_enrolments", "fast", 4, 2, 60_000],
      ]),
    );
    expect(jobs.filter((j) => j.onDead).map((j) => j.kind).sort()).toEqual(["automation.call_webhook", "automation.step"]);
    const sweep = { kind: "automation.sweep_enrolments", cron: "*/15 * * * *", payload: {}, catchUp: false };
    expect(schedules).toEqual(expect.arrayContaining([sweep]));
    expect((await loadSchedules()).filter((s) => s.kind === "automation.sweep_enrolments")).toEqual([sweep]);
  });

  it("automation.step twice: the second run finds the step already advanced", async () => {
    const a = await makeAutomation(h.db, { isMarketing: false, definition: manual([tagStep("s1", 0), tagStep("s2", 600)]) });
    const id = await enrolNow(a.id);
    const { first, second, afterFirst } = await twice("automation.step", { enrolmentId: id, stepKey: "s1" });
    expect(first).toMatchObject({ status: "ran", outcome: "tag_applied", nextStepKey: "s2" });
    expect(second).toEqual({ status: "noop", reason: "not_next" });
    expect(afterFirst.enrolments).toEqual([expect.objectContaining({ status: "active", next: "s2" })]);
  });

  it("automation.resume_enrolments twice: one :resume: job", async () => {
    const a = await makeAutomation(h.db, { isMarketing: false, definition: manual([tagStep("s1", 0)]) });
    const id = await enrolNow(a.id, new Date(Date.now() - 60_000));
    const resumedAt = new Date().toISOString();
    const { first, afterFirst } = await twice("automation.resume_enrolments", { automationId: a.id, resumedAt });
    expect(first).toMatchObject({ handled: 1, enqueued: 1 });
    expect(afterFirst.jobs.map((j) => j.key)).toEqual([`automation:${id}:s1:resume:${resumedAt.slice(0, 16)}`]);
  });

  it("automation.migrate_enrolments twice: the second run finds nothing on the old version", async () => {
    const a = await makeAutomation(h.db, { isMarketing: false, definition: manual([tagStep("s1", 600)]) });
    await enrolNow(a.id);
    const [v2] = await h.db.insert(automationVersions).values({ automationId: a.id, version: 2, definition: manual([tagStep("s1", 600)]), definitionHash: randomUUID() }).returning();
    const { first, second } = await twice("automation.migrate_enrolments", { automationId: a.id, toVersionId: v2!.id });
    expect(first).toMatchObject({ migrated: 1 });
    expect(second).toMatchObject({ handled: 0, migrated: 0 });
  });

  it("automation.end_enrolments twice: the second run ends nothing", async () => {
    const a = await makeAutomation(h.db, { isMarketing: false, definition: manual([tagStep("s1", 600)]) });
    await enrolNow(a.id);
    await enrolNow(a.id);
    const { first, second, afterFirst } = await twice("automation.end_enrolments", { automationId: a.id, reason: "archived" });
    expect(first).toMatchObject({ ended: 2 });
    expect(second).toMatchObject({ ended: 0 });
    expect(afterFirst.enrolments.map((e) => e.endReason)).toEqual(["archived", "archived"]);
  });

  it("automation.enrol_segment twice: the second run enrols nobody", async () => {
    const a = await makeAutomation(h.db, { isMarketing: false, definition: manual([tagStep("s1", 600)]) });
    const [seg] = await h.db.insert(segments).values({ name: "Jobs", kind: "static" }).returning();
    for (let i = 0; i < 2; i++) await h.db.insert(segmentMembers).values({ segmentId: seg!.id, personId: (await makePerson(h.db)).id, source: "manual" });
    const { first, second } = await twice("automation.enrol_segment", { automationId: a.id, segmentId: seg!.id, requestId: "req-jobs" });
    expect(first).toMatchObject({ enrolled: 2 });
    expect(second).toMatchObject({ enrolled: 0 });
  });

  it("automation.call_webhook twice: one call, one webhook_called run", async () => {
    const prev = process.env.AUTOMATION_WEBHOOK_SECRET;
    process.env.AUTOMATION_WEBHOOK_SECRET = "jobs-test-secret";
    try {
      await h.db.execute(sql`insert into settings (key, value) values ('automation_rules', ${JSON.stringify({
        max_marketing_per_day: 1,
        max_marketing_per_week: 3,
        quiet_start: "21:00",
        quiet_end: "08:00",
        webhook_hosts: ["hooks.example.com"],
      })}::jsonb) on conflict (key) do update set value = excluded.value`);
      const a = await makeAutomation(h.db, { isMarketing: false, definition: def({ trigger: { manual: true }, steps: [{ key: "w", type: "webhook", url: "https://hooks.example.com/x" }] }) });
      const id = await enrolNow(a.id);
      webhookFake.calls = 0;
      const { first, second, afterFirst } = await twice("automation.call_webhook", { enrolmentId: id, stepKey: "w" });
      expect(first).toMatchObject({ status: "called", httpStatus: 200 });
      expect(second).toEqual({ status: "noop", reason: "already_called" });
      expect(webhookFake.calls).toBe(1);
      expect(afterFirst.runs.filter((r) => r.outcome === "webhook_called")).toHaveLength(1);
    } finally {
      if (prev === undefined) delete process.env.AUTOMATION_WEBHOOK_SECRET;
      else process.env.AUTOMATION_WEBHOOK_SECRET = prev;
    }
  });

  it("automation.sweep_enrolments twice: the second run changes nothing", async () => {
    const a = await makeAutomation(h.db, { isMarketing: false, definition: manual([tagStep("s1", 0)]) });
    const id = await enrolNow(a.id, new Date(Date.now() - 3_600_000));
    await h.db.insert(jobsTable).values({ kind: "automation.step", payload: { enrolmentId: id, stepKey: "s1" }, idempotencyKey: `automation:${id}:s1`, lane: "fast", status: "dead", finishedAt: new Date() });
    const { first, second, afterFirst } = await twice("automation.sweep_enrolments", {});
    expect(first).toMatchObject({ deadRecorded: 1 });
    expect(second).toMatchObject({ deadRecorded: 0 });
    expect(afterFirst.runs.filter((r) => r.outcome === "failed")).toHaveLength(1);
  });
});
