/**
 * The bulk jobs (automation-P3): A-40 migration keeps executed steps and skips past ones,
 * A-5 archive ends every active enrolment, segment enrolment in person-id order, and the
 * chunking and continuation keys of all of them (chunk size lowered from 500 for the test).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle, Tx } from "@beam/db";
import { automationEnrolments, automations, automationVersions, jobs as jobsTable, segmentMembers, segments } from "@beam/db/schema";
import { createTestDb, makePerson } from "@beam/db/testing";
import { asc, eq } from "@/lib/ctx";
import { makeCtx, resetRuntime } from "@/lib/testing";
import type * as EmailApi from "@/modules/email/api";

vi.mock("@/modules/email/api", async (orig) => ({
  ...(await orig<typeof EmailApi>()),
  getReachability: vi.fn(() => Promise.resolve({ isReachable: true, blockedReason: null })),
}));

const bulk = await import("./bulk");
const { runStep } = await import("./step");
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
  await f.resetJobs(h.db);
});

const M = 60_000;
const t0 = new Date("2026-11-06T09:00:00Z");
const tx = () => h.db as unknown as Tx;
const tagAt = (key: string, minutes: number) => ({ key, type: "tag" as const, tag: "engaged", at: { from: "enrolment" as const, minutes } });
const jobKeys = async (kind: string) => (await h.db.select().from(jobsTable).where(eq(jobsTable.kind, kind as never))).map((j) => j.idempotencyKey);

describe("A-40 migrate_enrolments", () => {
  it("A-40 migration keeps done steps (no run), skips past ones with reason migrated and continues on the new version", async () => {
    const a = await f.makeAutomation(h.db, { isMarketing: false, definition: f.steps([tagAt("a", 0), tagAt("b", 60), tagAt("c", 120)]) });
    const p = await makePerson(h.db);
    const oldId = await f.enrolInto(h.db, a.id, p.id, { now: t0 });
    await runStep(tx(), { enrolmentId: oldId, stepKey: "a", now: t0 }, { ctx: makeCtx(h.db, { now: t0 }) });

    const [v2] = await h.db
      .insert(automationVersions)
      .values({ automationId: a.id, version: 2, definition: f.steps([tagAt("a", 0), tagAt("b2", 60), tagAt("c", 180)]), definitionHash: randomUUID() })
      .returning();
    await h.db.update(automations).set({ currentVersionId: v2!.id }).where(eq(automations.id, a.id));

    const at = new Date(t0.getTime() + 90 * M);
    const res = await bulk.migrateEnrolments(tx(), makeCtx(h.db, { now: at }), { automationId: a.id, toVersionId: v2!.id });
    expect(res).toMatchObject({ handled: 1, migrated: 1, continued: false });

    expect(await f.enrolmentRow(h.db, oldId)).toMatchObject({ status: "exited", endReason: "migrated" });
    const [fresh] = await h.db.select().from(automationEnrolments).where(eq(automationEnrolments.migratedFromEnrolmentId, oldId));
    expect(fresh).toMatchObject({ status: "active", source: "migration", triggerEventId: null, automationVersionId: v2!.id, nextStepKey: "c", enteredAt: t0 });
    expect(fresh!.nextStepAt).toEqual(new Date(t0.getTime() + 180 * M));
    expect(fresh!.plan.map((x) => [x.key, x.state])).toEqual([["a", "done"], ["b2", "skipped"], ["c", "pending"]]);
    const runs = (await f.runsOfEnrolment(h.db, fresh!.id)).map((r) => [r.stepKey, r.outcome, r.reason]);
    expect(runs).toEqual(expect.arrayContaining([[null, "entered", "migration"], ["b2", "skipped_late_entry", "migrated"], ["c", "scheduled", null]]));
    expect(runs.some(([k]) => k === "a")).toBe(false);

    // A second run finds nothing left on the old version.
    expect(await bulk.migrateEnrolments(tx(), makeCtx(h.db, { now: at }), { automationId: a.id, toVersionId: v2!.id })).toMatchObject({ handled: 0 });
  });

  it("A-40 chunks of N with the continuation key automation_migrate:<to_version_id>:<after>", async () => {
    const a = await f.makeAutomation(h.db, { isMarketing: false, definition: f.steps([tagAt("a", 600)]) });
    for (let i = 0; i < 3; i++) await f.enrolInto(h.db, a.id, (await makePerson(h.db)).id, { now: t0 });
    const [v2] = await h.db.insert(automationVersions).values({ automationId: a.id, version: 2, definition: f.steps([tagAt("a", 600)]), definitionHash: randomUUID() }).returning();
    const ctx = makeCtx(h.db, { now: t0 });
    const first = await bulk.migrateEnrolments(tx(), ctx, { automationId: a.id, toVersionId: v2!.id }, { chunk: 2 });
    expect(first).toMatchObject({ handled: 2, continued: true });
    expect(await jobKeys("automation.migrate_enrolments")).toEqual([`automation_migrate:${v2!.id}:${first.after}`]);
    expect(bulk.migrateJobKey({ automationId: a.id, toVersionId: v2!.id })).toBe(`automation_migrate:${v2!.id}:start`);
    const second = await bulk.migrateEnrolments(tx(), ctx, { automationId: a.id, toVersionId: v2!.id, after: first.after! }, { chunk: 2 });
    expect(second).toMatchObject({ handled: 1, continued: false });
  });
});

describe("A-5 end_enrolments (archive)", () => {
  it("A-5 archive ends every active enrolment with archived, in chunks with continuation keys", async () => {
    const a = await f.makeAutomation(h.db, { isMarketing: false, definition: f.steps([tagAt("a", 600)]) });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(await f.enrolInto(h.db, a.id, (await makePerson(h.db)).id, { now: t0 }));
    const ctx = makeCtx(h.db, { now: t0 });
    const first = await bulk.endEnrolments(tx(), ctx, { automationId: a.id, reason: "archived" }, { chunk: 2 });
    expect(first).toMatchObject({ handled: 2, ended: 2, continued: true });
    expect(await jobKeys("automation.end_enrolments")).toEqual([`automation_end:${a.id}:archived:${first.after}`]);
    const second = await bulk.endEnrolments(tx(), ctx, { automationId: a.id, reason: "archived", after: first.after! }, { chunk: 2 });
    expect(second).toMatchObject({ handled: 1, ended: 1, continued: false });
    for (const id of ids) expect(await f.enrolmentRow(h.db, id)).toMatchObject({ status: "exited", endReason: "archived" });
    expect(await bulk.endEnrolments(tx(), ctx, { automationId: a.id, reason: "archived" })).toMatchObject({ handled: 0 });
  });
});

describe("enrol_segment", () => {
  it("enrols segment members in person-id order, N per job, with continuation keys; all entry rules apply", async () => {
    const a = await f.makeAutomation(h.db, { isMarketing: false, definition: f.steps([tagAt("a", 600)], { re_entry: "never" }) });
    const [seg] = await h.db.insert(segments).values({ name: "Bulk", kind: "static" }).returning();
    const people = [];
    for (let i = 0; i < 3; i++) people.push(await makePerson(h.db));
    const erased = await makePerson(h.db, { erasedAt: t0, email: null });
    await h.db.insert(segmentMembers).values([...people, erased].map((p) => ({ segmentId: seg!.id, personId: p.id, source: "manual" as const })));
    const ctx = makeCtx(h.db, { now: t0 });
    const input = { automationId: a.id, segmentId: seg!.id, requestId: "req-1" };
    const first = await bulk.enrolSegment(tx(), ctx, input, { chunk: 2 });
    expect(first).toMatchObject({ handled: 2, continued: true });
    const sorted = [...people, erased].map((p) => p.id).sort();
    expect(first.after).toBe(sorted[1]);
    expect(await jobKeys("automation.enrol_segment")).toEqual([`automation_enrol_segment:${a.id}:${seg!.id}:req-1:${sorted[1]}`]);
    expect(bulk.enrolSegmentJobKey(input)).toBe(`automation_enrol_segment:${a.id}:${seg!.id}:req-1:start`);
    const second = await bulk.enrolSegment(tx(), ctx, { ...input, after: first.after! }, { chunk: 2 });
    // A full chunk always continues; the continuation then finds nothing and stops.
    expect(second).toMatchObject({ handled: 2, continued: true });
    expect(await bulk.enrolSegment(tx(), ctx, { ...input, after: second.after! }, { chunk: 2 })).toMatchObject({ handled: 0, continued: false });
    expect(first.enrolled + second.enrolled).toBe(3);

    const rows = await h.db.select().from(automationEnrolments).where(eq(automationEnrolments.automationId, a.id)).orderBy(asc(automationEnrolments.personId));
    expect(rows.map((r) => [r.personId, r.source])).toEqual(people.map((p) => p.id).sort().map((id) => [id, "segment"]));
    // Re-running the first chunk enrols nobody again (re-entry never).
    expect(await bulk.enrolSegment(tx(), ctx, input, { chunk: 2 })).toMatchObject({ enrolled: 0 });
  });

  it("a paused automation enrols nobody", async () => {
    const a = await f.makeAutomation(h.db, { isMarketing: false, status: "paused", definition: f.steps([tagAt("a", 600)]) });
    const [seg] = await h.db.insert(segments).values({ name: "Paused", kind: "static" }).returning();
    const p = await makePerson(h.db);
    await h.db.insert(segmentMembers).values({ segmentId: seg!.id, personId: p.id, source: "manual" });
    expect(await bulk.enrolSegment(tx(), makeCtx(h.db, { now: t0 }), { automationId: a.id, segmentId: seg!.id, requestId: "r" })).toMatchObject({ handled: 0, enrolled: 0 });
  });
});
