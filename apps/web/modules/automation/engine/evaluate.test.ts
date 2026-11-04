/**
 * The evaluator (automation-P2): A-5a, A-7 to A-10, A-11a, A-20, A-46, the gap-safe cursor and
 * the 1,000-event limit. `isDpiaApproved` (ops-P6) and `getReachability` (email-P3) are mocked.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { auditLog, automationEnrolments, automationRuns, automations, jobs, segments } from "@beam/db/schema";
import { createTestDb, makePerson } from "@beam/db/testing";
import { makePaidOrder } from "@beam/db/testing/commerce-factories";
import { and, asc, eq, sql } from "@/lib/ctx";
import { resetRuntime } from "@/lib/testing";
import { readCursor } from "./cursor";
import { def, evaluate, makeAutomation, makeEvent, makeGroup, maxEventId, resetAutomations, setCursor, type MakeEvent } from "./automation-p2.fixtures";

const dpia = new Map<string, boolean | Error>();
import type * as EmailApi from "@/modules/email/api";
import type * as OpsApi from "@/modules/ops/api";
vi.mock("@/modules/ops/api", async (orig) => ({
  ...(await orig<typeof OpsApi>()),
  isDpiaApproved: vi.fn((_db: unknown, key: string) => {
    const v = dpia.get(key) ?? true;
    return v instanceof Error ? Promise.reject(v) : Promise.resolve(v);
  }),
}));
vi.mock("@/modules/email/api", async (orig) => ({
  ...(await orig<typeof EmailApi>()),
  getReachability: vi.fn(() => Promise.resolve({ isReachable: true, blockedReason: null })),
}));

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  dpia.clear();
  await resetAutomations(h.db);
  await h.db.execute(sql`delete from jobs`);
  await setCursor(h.db, await maxEventId(h.db));
});

const HOUR = 3_600_000;
const enrolmentsOf = (personId: string) =>
  h.db.select().from(automationEnrolments).where(eq(automationEnrolments.personId, personId)).orderBy(asc(automationEnrolments.enteredAt));
const runsOf = (personId: string) => h.db.select().from(automationRuns).where(eq(automationRuns.personId, personId));

describe("A-7 events that never trigger", () => {
  it("sensitive, automation.*, imported, ops.history_imported, older than 48 h and automation-caused events enrol nobody; all but the first two still exit", async () => {
    const now = new Date();
    await makeAutomation(h.db, { definition: def({ trigger: { event: ["test.happened", "ops.history_imported", "automation.done"] } }) });
    const exiting = await makeAutomation(h.db, {
      isMarketing: false,
      definition: def({ trigger: { manual: true }, exit_on: ["test.ended", "ops.history_imported", "automation.done"] }),
    });
    const { enrol } = await import("./enrol");
    const cases: { name: string; trigger: Omit<MakeEvent, "personId">; exits: boolean }[] = [
      { name: "sensitive", trigger: { kind: "test.happened", isSensitive: true }, exits: false },
      { name: "automation kind", trigger: { kind: "automation.done" }, exits: false },
      { name: "import", trigger: { kind: "test.happened", data: { source: "import" } }, exits: true },
      { name: "via_import", trigger: { kind: "test.happened", data: { via_import: true } }, exits: true },
      { name: "history", trigger: { kind: "ops.history_imported" }, exits: true },
      { name: "stale", trigger: { kind: "test.happened", occurredAt: new Date(now.getTime() - 49 * HOUR) }, exits: true },
      { name: "automation source", trigger: { kind: "test.happened", data: { source: "automation" } }, exits: true },
    ];
    for (const c of cases) {
      const p = await makePerson(h.db);
      await enrol(h.db as never, { automation: exiting.id, personId: p.id, source: "staff", actor: { kind: "system", jobId: "" }, now });
      await makeEvent(h.db, { personId: p.id, ...c.trigger });
      const exitKind = c.trigger.kind === "test.happened" ? "test.ended" : c.trigger.kind;
      await makeEvent(h.db, { ...c.trigger, kind: exitKind, personId: p.id });
      const res = await evaluate(h.db, now);
      expect(res.enrolled, c.name).toBe(0);
      const rows = await enrolmentsOf(p.id);
      expect(rows.length, c.name).toBe(1);
      expect(rows[0]!.status, c.name).toBe(c.exits ? "exited" : "active");
      if (c.exits) expect(rows[0]!.endReason, c.name).toBe(`exit_event:${exitKind}`);
    }
  });

  it("a fresh, ordinary event triggers (the control case)", async () => {
    await makeAutomation(h.db);
    const p = await makePerson(h.db);
    await makeEvent(h.db, { personId: p.id, kind: "test.happened" });
    expect((await evaluate(h.db)).enrolled).toBe(1);
    expect((await enrolmentsOf(p.id)).map((e) => e.source)).toEqual(["trigger"]);
  });
});

describe("A-10 trigger matching", () => {
  it("where filters, segment_enter and manual", async () => {
    const [seg] = await h.db.insert(segments).values({ name: "Seg", kind: "dynamic" }).returning();
    const filtered = await makeAutomation(h.db, { definition: def({ trigger: { event: "booking.confirmed", where: { "data.session_kind": "event", mode: { exists: false } } } }) });
    const bySegment = await makeAutomation(h.db, { definition: def({ trigger: { segment_enter: seg!.id } }) });
    await makeAutomation(h.db, { definition: def({ trigger: { manual: true } }) });
    const p = await makePerson(h.db);
    await makeEvent(h.db, { personId: p.id, kind: "booking.confirmed", data: { session_kind: "day" } });
    await makeEvent(h.db, { personId: p.id, kind: "booking.confirmed", data: { session_kind: "event" } });
    await makeEvent(h.db, { personId: p.id, kind: "segment.entered", data: { segment_id: seg!.id } });
    await makeEvent(h.db, { personId: p.id, kind: "segment.entered", data: { segment_id: "00000000-0000-4000-8000-000000000000" } });
    const res = await evaluate(h.db);
    expect(res).toMatchObject({ processed: 4, enrolled: 2 });
    const rows = await enrolmentsOf(p.id);
    expect(rows.map((r) => [r.automationId, r.source]).sort()).toEqual(
      [
        [filtered.id, "trigger"],
        [bySegment.id, "segment"],
      ].sort(),
    );
  });
});

describe("A-9 order per event", () => {
  it("a purchase ends lead nurture before the customer journey is considered (no supersede)", async () => {
    const lane = `lane_${Date.now()}`;
    const nurture = await makeGroup(h.db, { isExclusive: true, lane, priority: 30 });
    const customer = await makeGroup(h.db, { isExclusive: true, lane, priority: 10 });
    const welcome = await makeAutomation(h.db, { group: nurture, definition: def({ trigger: { event: "person.created" }, exit_on: ["order.paid"] }) });
    const journey = await makeAutomation(h.db, { group: customer, isMarketing: false, definition: def({ trigger: { event: "order.paid" } }) });
    const p = await makePerson(h.db);
    await makeEvent(h.db, { personId: p.id, kind: "person.created" });
    await evaluate(h.db);
    const { order } = await makePaidOrder(h.db, { personId: p.id });
    await makeEvent(h.db, { personId: p.id, kind: "order.paid", refType: "order", refId: order.id, data: { order_id: order.id, lines: [{ kind: "item" }] } });
    await evaluate(h.db);
    const rows = await enrolmentsOf(p.id);
    expect(rows.find((r) => r.automationId === welcome.id)).toMatchObject({ status: "exited", endReason: "exit_event:order.paid" });
    expect(rows.find((r) => r.automationId === journey.id)).toMatchObject({ status: "active", exclusiveDomain: lane });
  });

  it("trigger matches run by group priority, then automation priority, then slug", async () => {
    const lane = `lane_o_${Date.now()}`;
    const g = await makeGroup(h.db, { isExclusive: true, lane, priority: 20 });
    const later = await makeAutomation(h.db, { slug: "bbb-order", group: g, priority: 100 });
    const first = await makeAutomation(h.db, { slug: "zzz-order", group: g, priority: 10 });
    const p = await makePerson(h.db);
    await makeEvent(h.db, { personId: p.id, kind: "test.happened" });
    await evaluate(h.db);
    const rows = await enrolmentsOf(p.id);
    expect(rows.map((r) => r.automationId)).toEqual([first.id]);
    const skip = (await runsOf(p.id)).find((r) => r.outcome === "skipped_exclusive");
    expect(skip).toMatchObject({ automationId: later.id, reason: "blocked_by:zzz-order" });
  });
});

describe("A-11a and A-5a gates", () => {
  it("A-11a an automation whose requires_flag is off enrols nobody and writes no run", async () => {
    await makeAutomation(h.db, { requiresFlag: "ff_commerce_checkout_recovery", definition: def({ trigger: { event: "checkout.abandoned" } }) });
    const p = await makePerson(h.db);
    await makeEvent(h.db, { personId: p.id, kind: "checkout.abandoned" });
    expect((await evaluate(h.db)).enrolled).toBe(0);
    expect(await enrolmentsOf(p.id)).toEqual([]);
    expect(await runsOf(p.id)).toEqual([]);
  });

  it("A-5a a withdrawn DPIA decision pauses the gated automations in the next run and leaves ungated ones active", async () => {
    const gated = await makeAutomation(h.db, { requiresDpia: "watch_time_profiling", definition: def({ trigger: { event: "webinar.watched" } }) });
    const free = await makeAutomation(h.db, { definition: def({ trigger: { event: "webinar.watched" } }) });
    const p = await makePerson(h.db);
    await makeEvent(h.db, { personId: p.id, kind: "webinar.watched" });
    dpia.set("watch_time_profiling", false);
    const res = await evaluate(h.db);
    expect(res.enrolled).toBe(1);
    const status = async (id: string) => (await h.db.select().from(automations).where(eq(automations.id, id)))[0]!;
    expect(await status(gated.id)).toMatchObject({ status: "paused", pausedAt: expect.any(Date) });
    expect((await status(free.id)).status).toBe("active");
    expect((await enrolmentsOf(p.id)).map((e) => e.automationId)).toEqual([free.id]);
    const audits = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "automation.pause"), eq(auditLog.entityId, gated.id)));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actor).toMatchObject({ kind: "system" });
    const slack = await h.db.select().from(jobs).where(eq(jobs.kind, "notify.slack"));
    expect(slack.map((j) => j.idempotencyKey)).toEqual([expect.stringMatching(/^slack:automation-dpia:watch_time_profiling:/)]);
  });

  it("A-5a an isDpiaApproved failure neither pauses nor triggers the gated automation", async () => {
    const gated = await makeAutomation(h.db, { requiresDpia: "watch_time_profiling", definition: def({ trigger: { event: "webinar.watched" } }) });
    const p = await makePerson(h.db);
    await makeEvent(h.db, { personId: p.id, kind: "webinar.watched" });
    dpia.set("watch_time_profiling", new Error("ops down"));
    expect((await evaluate(h.db)).enrolled).toBe(0);
    expect((await h.db.select().from(automations).where(eq(automations.id, gated.id)))[0]!.status).toBe("active");
  });

  it("an approved DPIA lets the gated automation enrol", async () => {
    await makeAutomation(h.db, { requiresDpia: "watch_time_profiling", definition: def({ trigger: { event: "webinar.watched" } }) });
    const p = await makePerson(h.db);
    await makeEvent(h.db, { personId: p.id, kind: "webinar.watched" });
    dpia.set("watch_time_profiling", true);
    expect((await evaluate(h.db)).enrolled).toBe(1);
  });
});

describe("A-46 a throwing definition", () => {
  it("rolls back only its own savepoint, writes failed and lets the other automations and the cursor go on", async () => {
    const broken = await makeAutomation(h.db, {
      slug: "aaa-broken",
      definition: def({ steps: [{ key: "s1", type: "tag", tag: "x", at: { from: "anchor", minutes: 0 } }] }),
    });
    const healthy = await makeAutomation(h.db, { slug: "bbb-healthy" });
    const p = await makePerson(h.db);
    const ev = await makeEvent(h.db, { personId: p.id, kind: "test.happened" });
    const res = await evaluate(h.db);
    expect(res).toMatchObject({ processed: 1, enrolled: 1, lastEventId: ev.id.toString() });
    expect((await enrolmentsOf(p.id)).map((e) => e.automationId)).toEqual([healthy.id]);
    const failed = (await runsOf(p.id)).filter((r) => r.outcome === "failed");
    expect(failed).toEqual([expect.objectContaining({ automationId: broken.id, enrolmentId: null, dedupeKey: `entry:${broken.id}:${ev.id}` })]);
    expect(failed[0]!.reason).toMatch(/^evaluate:/);
    expect((await readCursor(h.db)).last_event_id).toBe(ev.id.toString());
  });
});

describe("A-20 due steps", () => {
  it("enqueues automation.step once per due enrolment step (fast lane, 5 for marketing, 2 for transactional)", async () => {
    const marketing = await makeAutomation(h.db, { definition: def({ steps: [{ key: "s1", type: "tag", tag: "x", at: { from: "enrolment", minutes: 60 } }] }) });
    const transactional = await makeAutomation(h.db, { isMarketing: false, definition: def({ steps: [{ key: "s1", type: "tag", tag: "x", at: { from: "enrolment", minutes: 60 } }] }) });
    const paused = await makeAutomation(h.db, { definition: def({ steps: [{ key: "s1", type: "tag", tag: "x", at: { from: "enrolment", minutes: 60 } }] }) });
    const p = await makePerson(h.db);
    await makeEvent(h.db, { personId: p.id, kind: "test.happened" });
    const first = await evaluate(h.db);
    expect(first).toMatchObject({ enrolled: 3, dueEnqueued: 0 });
    await h.db.update(automations).set({ status: "paused", pausedAt: new Date() }).where(eq(automations.id, paused.id));
    const due = await evaluate(h.db, new Date(Date.now() + 61 * 60_000));
    expect(due.dueEnqueued).toBe(2);
    const again = await evaluate(h.db, new Date(Date.now() + 62 * 60_000));
    expect(again.dueEnqueued).toBe(0);
    const steps = await h.db.select().from(jobs).where(eq(jobs.kind, "automation.step"));
    const byAutomation = new Map((await enrolmentsOf(p.id)).map((e) => [e.id, e.automationId]));
    expect(
      steps.map((j) => [byAutomation.get((j.payload as { enrolmentId: string }).enrolmentId), j.lane, j.priority, j.idempotencyKey.split(":")[2]]).sort(),
    ).toEqual(
      [
        [marketing.id, "fast", 5, "s1"],
        [transactional.id, "fast", 2, "s1"],
      ].sort(),
    );
    expect(steps.every((j) => /^automation:[0-9a-f-]{36}:s1$/.test(j.idempotencyKey))).toBe(true);
  });
});

describe("A-8 batch limit and continuation", () => {
  it("processes at most 1,000 events per run and enqueues a continuation keyed by the last id", async () => {
    const p = await makePerson(h.db);
    await h.db.execute(sql`insert into activity_events (person_id, kind, actor, data)
      select ${p.id}, 'noise.happened', '{"kind":"system","id":null}'::jsonb, '{}'::jsonb from generate_series(1, 1005)`);
    const first = await evaluate(h.db);
    expect(first).toMatchObject({ processed: 1_000, continued: true });
    const cont = await h.db.select().from(jobs).where(eq(jobs.kind, "automation.evaluate"));
    expect(cont.map((j) => [j.idempotencyKey, j.payload, j.lane])).toEqual([[`automation_evaluate:${first.lastEventId}`, { continuation: true }, "fast"]]);
    const second = await evaluate(h.db);
    expect(second).toMatchObject({ processed: 5, continued: false });
  });
});

describe("A-8 gap-safe cursor (edge case 2)", () => {
  it("records a missing id as a gap, processes it when it appears and drops gaps older than 10 minutes", async () => {
    await makeAutomation(h.db);
    const base = (await maxEventId(h.db)) + 1_000n;
    await setCursor(h.db, base);
    const [p1, p2, p3, p4] = [await makePerson(h.db), await makePerson(h.db), await makePerson(h.db), await makePerson(h.db)];
    await makeEvent(h.db, { id: base + 1n, personId: p1.id, kind: "test.happened" });
    await makeEvent(h.db, { id: base + 3n, personId: p3.id, kind: "test.happened" });
    const first = await evaluate(h.db);
    expect(first).toMatchObject({ processed: 2, enrolled: 2, lastEventId: (base + 3n).toString() });
    expect((await readCursor(h.db)).gaps.map((g) => g.id)).toEqual([(base + 2n).toString()]);

    // The slow transaction commits id base+2 now: the next run processes it and clears the gap.
    await makeEvent(h.db, { id: base + 2n, personId: p2.id, kind: "test.happened" });
    const second = await evaluate(h.db);
    expect(second).toMatchObject({ processed: 1, enrolled: 1 });
    expect((await enrolmentsOf(p2.id)).length).toBe(1);
    expect((await readCursor(h.db)).gaps).toEqual([]);

    // A gap first seen 11 minutes ago is dropped: its id is never read.
    const old = new Date(Date.now() - 11 * 60_000).toISOString();
    await setCursor(h.db, base + 5n, [{ id: (base + 4n).toString(), first_seen_at: old }]);
    await makeEvent(h.db, { id: base + 4n, personId: p4.id, kind: "test.happened" });
    const third = await evaluate(h.db);
    expect(third.processed).toBe(0);
    expect((await readCursor(h.db)).gaps).toEqual([]);
    expect(await enrolmentsOf(p4.id)).toEqual([]);

    // Re-reading events that already enrolled is harmless: only the never-read id enrols.
    await setCursor(h.db, base, []);
    const reread = await evaluate(h.db);
    expect(reread).toMatchObject({ processed: 4, enrolled: 1 });
    for (const p of [p1, p2, p3, p4]) expect((await enrolmentsOf(p.id)).length).toBe(1);
    await h.db.execute(sql`select setval(pg_get_serial_sequence('activity_events', 'id'), (select max(id) from activity_events))`);
  });
});
