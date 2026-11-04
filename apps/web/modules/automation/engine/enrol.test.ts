/**
 * Enrolment rules A-11 to A-19 (automation-P2). Reachability is email's `getReachability`
 * (implemented by email-P3), mocked here: a person is unreachable when listed in `unreachable`
 * or when a suppression exists for their address (so "suppression survives an import").
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle, Tx } from "@beam/db";
import { automationEnrolments, automationRuns, persons, segmentMembers, segments, suppressions } from "@beam/db/schema";
import { createTestDb, makePerson } from "@beam/db/testing";
import { emailHash } from "@beam/core/crm";
import { and, asc, eq, sql } from "@/lib/ctx";
import { resetRuntime } from "@/lib/testing";
import { def, makeAutomation, makeEvent, makeGroup } from "./automation-p2.fixtures";

const unreachable = new Set<string>();
import type * as EmailApi from "@/modules/email/api";
vi.mock("@/modules/email/api", async (orig) => ({
  ...(await orig<typeof EmailApi>()),
  getReachability: vi.fn(async (tx: Tx, personId: string) => {
    if (unreachable.has(personId)) return { isReachable: false, blockedReason: "no_consent" };
    const r = await tx.execute(sql`select 1 from persons p join suppressions s on s.email_hash = p.email_hash where p.id = ${personId}`);
    const rows = (r as unknown as { rows: unknown[] }).rows;
    return rows.length ? { isReachable: false, blockedReason: "suppressed" } : { isReachable: true, blockedReason: null };
  }),
}));

const { enrol } = await import("./enrol");

let h: DbHandle;
let tx: Tx;
beforeAll(async () => {
  h = await createTestDb();
  tx = h.db as unknown as Tx;
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(() => unreachable.clear());

const SYSTEM = { kind: "system", jobId: "" } as const;
const now = new Date("2026-11-06T09:00:00Z"); // Friday 10:00 Brussels
const runsOf = (personId: string) =>
  h.db.select().from(automationRuns).where(eq(automationRuns.personId, personId)).orderBy(asc(automationRuns.occurredAt), asc(automationRuns.createdAt));
const enrolmentsOf = (personId: string) => h.db.select().from(automationEnrolments).where(eq(automationEnrolments.personId, personId));
const go = (automationId: string, personId: string, extra: Partial<Parameters<typeof enrol>[1]> = {}) =>
  enrol(tx, { automation: automationId, personId, source: "staff", actor: SYSTEM, now, ...extra });

describe("A-11 person lock, erased, merged and restricted persons", () => {
  it("A-11 never enrols an erased or a merged person", async () => {
    const a = await makeAutomation(h.db);
    const erased = await makePerson(h.db, { erasedAt: new Date(), email: null });
    const winner = await makePerson(h.db);
    const loser = await makePerson(h.db, { mergedIntoPersonId: winner.id });
    expect(await go(a.id, erased.id)).toEqual({ status: "skipped", outcome: "audience" });
    expect(await go(a.id, loser.id)).toEqual({ status: "skipped", outcome: "audience" });
    expect(await enrolmentsOf(erased.id)).toEqual([]);
    expect(await enrolmentsOf(loser.id)).toEqual([]);
  });

  it("A-11 a restricted person is refused for marketing (skipped_unreachable, restricted) and enrolled for transactional", async () => {
    const marketing = await makeAutomation(h.db);
    const waitlist = await makeAutomation(h.db, { isMarketing: false, slug: "waitlist-offer-test" });
    const p = await makePerson(h.db, { processingRestrictedAt: new Date() });
    expect(await go(marketing.id, p.id)).toEqual({ status: "skipped", outcome: "skipped_unreachable" });
    const runs = await runsOf(p.id);
    expect(runs).toEqual([expect.objectContaining({ outcome: "skipped_unreachable", reason: "restricted", enrolmentId: null, automationId: marketing.id })]);
    expect(await go(waitlist.id, p.id)).toEqual({ status: "enrolled", enrolmentId: expect.any(String) });
  });

  it("an inactive automation (draft, paused, archived) enrols nobody", async () => {
    const p = await makePerson(h.db);
    for (const status of ["paused", "archived"] as const) {
      const a = await makeAutomation(h.db, { status });
      expect(await go(a.id, p.id)).toEqual({ status: "skipped", outcome: "inactive" });
    }
    const draft = await makeAutomation(h.db, { unpublished: true });
    expect(await go(draft.id, p.id)).toEqual({ status: "skipped", outcome: "inactive" });
  });
});

describe("A-12 audience", () => {
  it("status, locales, segment and exclusions decide; a failed audience writes no run", async () => {
    const [seg] = await h.db.insert(segments).values({ name: "VIP", kind: "static" }).returning();
    const [excl] = await h.db.insert(segments).values({ name: "Staff", kind: "static" }).returning();
    const a = await makeAutomation(h.db, {
      definition: def({ audience: { status: ["lead"], locales: ["nl-BE"], segment_id: seg!.id, exclude_segment_ids: [excl!.id] } }),
    });
    const ok = await makePerson(h.db);
    const french = await makePerson(h.db, { locale: "fr-BE" });
    const outside = await makePerson(h.db);
    const excluded = await makePerson(h.db);
    await h.db.insert(segmentMembers).values([ok, french, excluded].map((p) => ({ segmentId: seg!.id, personId: p.id, source: "manual" as const })));
    await h.db.insert(segmentMembers).values({ segmentId: excl!.id, personId: excluded.id, source: "manual" });
    expect((await go(a.id, ok.id, { source: "trigger" })).status).toBe("enrolled");
    for (const p of [french, outside, excluded]) {
      expect(await go(a.id, p.id, { source: "trigger" })).toEqual({ status: "skipped", outcome: "audience" });
      expect(await runsOf(p.id)).toEqual([]);
    }
  });

  it("status uses v_person_status: a customer audience refuses a lead", async () => {
    const a = await makeAutomation(h.db, { definition: def({ audience: { status: ["customer", "member"] } }) });
    const lead = await makePerson(h.db);
    expect(await go(a.id, lead.id, { source: "trigger" })).toEqual({ status: "skipped", outcome: "audience" });
  });
});

describe("A-13 re-entry", () => {
  it("never refuses a second entry; always refuses only while one is active for the same subject", async () => {
    const never = await makeAutomation(h.db, { definition: def({ re_entry: "never" }) });
    const always = await makeAutomation(h.db, { definition: def({ re_entry: "always" }) });
    const p = await makePerson(h.db);
    expect((await go(never.id, p.id)).status).toBe("enrolled");
    const [first] = await enrolmentsOf(p.id);
    await h.db.update(automationEnrolments).set({ status: "completed", endedAt: now, nextStepAt: null, nextStepKey: null }).where(eq(automationEnrolments.id, first!.id));
    expect(await go(never.id, p.id)).toEqual({ status: "skipped", outcome: "re_entry" });

    expect((await go(always.id, p.id, { subjectKey: "booking:1" })).status).toBe("enrolled");
    expect(await go(always.id, p.id, { subjectKey: "booking:1" })).toEqual({ status: "skipped", outcome: "re_entry" });
    expect((await go(always.id, p.id, { subjectKey: "booking:2" })).status).toBe("enrolled");
  });

  it("after_days:30 is judged per person across subjects (a second booking's review request waits)", async () => {
    const review = await makeAutomation(h.db, { definition: def({ re_entry: "after_days:30", subject: "ref" }) });
    const p = await makePerson(h.db);
    const ev1 = await makeEvent(h.db, { personId: p.id, kind: "test.happened", refType: "booking", refId: "b1", occurredAt: now });
    const ev2 = await makeEvent(h.db, { personId: p.id, kind: "test.happened", refType: "booking", refId: "b2", occurredAt: now });
    expect((await go(review.id, p.id, { source: "trigger", event: ev1 })).status).toBe("enrolled");
    const later = new Date(now.getTime() + 10 * 86_400_000);
    expect(await go(review.id, p.id, { source: "trigger", event: ev2, now: later })).toEqual({ status: "skipped", outcome: "re_entry" });
    const muchLater = new Date(now.getTime() + 31 * 86_400_000);
    expect((await go(review.id, p.id, { source: "trigger", event: ev2, now: muchLater })).status).toBe("enrolled");
    const rows = await enrolmentsOf(p.id);
    expect(rows.map((r) => r.subjectKey).sort()).toEqual(["booking:b1", "booking:b2"]);
  });

  it("the same trigger event never enrols twice (uq_enrolment_trigger), with no second run", async () => {
    const a = await makeAutomation(h.db);
    const p = await makePerson(h.db);
    const ev = await makeEvent(h.db, { personId: p.id, kind: "test.happened", occurredAt: now });
    expect((await go(a.id, p.id, { source: "trigger", event: ev })).status).toBe("enrolled");
    const before = (await runsOf(p.id)).length;
    expect(await go(a.id, p.id, { source: "trigger", event: ev })).toEqual({ status: "skipped", outcome: "re_entry" });
    expect((await runsOf(p.id)).length).toBe(before);
  });
});

describe("A-14 marketing reachability", () => {
  it("an unreachable person writes skipped_unreachable without an enrolment", async () => {
    const a = await makeAutomation(h.db);
    const p = await makePerson(h.db);
    unreachable.add(p.id);
    expect(await go(a.id, p.id, { source: "trigger" })).toEqual({ status: "skipped", outcome: "skipped_unreachable" });
    expect(await runsOf(p.id)).toEqual([
      expect.objectContaining({ outcome: "skipped_unreachable", enrolmentId: null, reason: "purpose newsletter not reachable: no_consent" }),
    ]);
    expect(await enrolmentsOf(p.id)).toEqual([]);
  });

  it("a transactional automation does not check reachability at entry", async () => {
    const a = await makeAutomation(h.db, { isMarketing: false });
    const p = await makePerson(h.db);
    unreachable.add(p.id);
    expect((await go(a.id, p.id, { source: "trigger" })).status).toBe("enrolled");
  });

  it("a suppressed person re-created by an import is never enrolled", async () => {
    const a = await makeAutomation(h.db);
    const email = `returning-${Date.now()}@example.com`;
    const original = await makePerson(h.db, { email, emailHash: emailHash(email) });
    await h.db.insert(suppressions).values({ emailHash: emailHash(email), email, scope: "all", reason: "unsubscribe", source: "test", personId: original.id, actor: { kind: "system", id: null } });
    await h.db.update(persons).set({ erasedAt: new Date(), email: null, emailHash: null }).where(eq(persons.id, original.id));
    const imported = await makePerson(h.db, { email, emailHash: emailHash(email), acquisition: { source: "import" } });
    const ev = await makeEvent(h.db, { personId: imported.id, kind: "test.happened", occurredAt: now });
    expect(await go(a.id, imported.id, { source: "trigger", event: ev })).toEqual({ status: "skipped", outcome: "skipped_unreachable" });
    expect(await enrolmentsOf(imported.id)).toEqual([]);
  });

  it("staff override skips the entry reachability check (edge case 20)", async () => {
    const a = await makeAutomation(h.db);
    const p = await makePerson(h.db);
    unreachable.add(p.id);
    expect((await go(a.id, p.id, { override: true })).status).toBe("enrolled");
  });
});

describe("A-15 exclusivity", () => {
  it("a lower (group, automation) priority supersedes, an equal or higher one is skipped", async () => {
    const lane = `lane_${Date.now()}`;
    const customer = await makeGroup(h.db, { isExclusive: true, lane, priority: 10 });
    const nurture = await makeGroup(h.db, { isExclusive: true, lane, priority: 30 });
    const welcome = await makeAutomation(h.db, { group: nurture, priority: 100 });
    const assessment = await makeAutomation(h.db, { group: nurture, priority: 50 });
    const firstVisit = await makeAutomation(h.db, { group: customer, priority: 100 });
    const p = await makePerson(h.db);

    const w = await go(welcome.id, p.id, { source: "trigger" });
    expect(w.status).toBe("enrolled");
    const s = await go(assessment.id, p.id, { source: "trigger" });
    expect(s.status).toBe("enrolled");
    const rows = await enrolmentsOf(p.id);
    const old = rows.find((r) => r.automationId === welcome.id)!;
    expect(old).toMatchObject({ status: "exited", endReason: "superseded", nextStepAt: null });
    const exitedRun = (await runsOf(p.id)).find((r) => r.enrolmentId === old.id && r.outcome === "exited")!;
    expect(exitedRun.data).toMatchObject({ superseded_by: (s as { enrolmentId: string }).enrolmentId });

    // welcome (30, 100) cannot displace assessment (30, 50): skipped, naming the blocker.
    expect(await go(welcome.id, p.id, { source: "trigger" })).toEqual({ status: "skipped", outcome: "skipped_exclusive" });
    const skip = (await runsOf(p.id)).find((r) => r.outcome === "skipped_exclusive")!;
    expect(skip).toMatchObject({ enrolmentId: null, automationId: welcome.id, reason: `blocked_by:${assessment.slug}` });

    // A customer-journey automation (group 10) supersedes lead nurture.
    expect((await go(firstVisit.id, p.id, { source: "trigger" })).status).toBe("enrolled");
    const active = (await enrolmentsOf(p.id)).filter((r) => r.status === "active");
    expect(active.map((r) => r.automationId)).toEqual([firstVisit.id]);
    expect(active[0]!.exclusiveDomain).toBe(lane);
  });

  it("staff enrol moves a blocking enrolment out with `moved` (A-37)", async () => {
    const g = await makeGroup(h.db, { isExclusive: true, priority: 10 });
    const a1 = await makeAutomation(h.db, { group: g, priority: 10 });
    const a2 = await makeAutomation(h.db, { group: g, priority: 90 });
    const p = await makePerson(h.db);
    await go(a1.id, p.id, { source: "trigger" });
    expect((await go(a2.id, p.id, { override: true })).status).toBe("enrolled");
    const rows = await enrolmentsOf(p.id);
    expect(rows.find((r) => r.automationId === a1.id)).toMatchObject({ status: "exited", endReason: "moved" });
  });
});

describe("A-16 to A-19 anchor, planning and the entry runs", () => {
  const eventDef = def({
    trigger: { event: "booking.confirmed", where: { "data.session_kind": "event" } },
    anchor: "data.starts_at",
    subject: "ref",
    steps: [
      { key: "reminder_7d", type: "tag", tag: "x", at: { from: "anchor", minutes: -10_080 } },
      { key: "reminder_3d", type: "tag", tag: "x", at: { from: "anchor", minutes: -4_320 } },
      { key: "reminder_day_of", type: "tag", tag: "x", at: { from: "anchor", minutes: -180 } },
    ],
  });

  it("A-18 scenario 1: a Friday 10:00 registration for Sunday 10:00 skips the 7 d and 3 d steps and keeps the day-of step", async () => {
    const a = await makeAutomation(h.db, { isMarketing: false, definition: eventDef });
    const p = await makePerson(h.db);
    const startsAt = "2026-11-08T09:00:00.000Z"; // Sunday 10:00 Brussels
    const ev = await makeEvent(h.db, { personId: p.id, kind: "booking.confirmed", refType: "booking", refId: "bk1", data: { session_kind: "event", starts_at: startsAt }, occurredAt: now });
    const r = await go(a.id, p.id, { source: "trigger", event: ev });
    expect(r.status).toBe("enrolled");
    const [en] = await enrolmentsOf(p.id);
    expect(en).toMatchObject({
      status: "active",
      subjectKey: "booking:bk1",
      anchorAt: new Date(startsAt),
      nextStepKey: "reminder_day_of",
      nextStepAt: new Date("2026-11-08T06:00:00.000Z"),
      triggerEventId: BigInt(ev.id),
    });
    expect(en!.context.trigger).toMatchObject({ kind: "booking.confirmed", ref_type: "booking", ref_id: "bk1", event_id: ev.id.toString() });
    const runs = await runsOf(p.id);
    expect(runs.map((x) => [x.outcome, x.stepKey])).toEqual([
      ["entered", null],
      ["skipped_late_entry", "reminder_7d"],
      ["skipped_late_entry", "reminder_3d"],
      ["scheduled", "reminder_day_of"],
    ]);
    expect(runs[0]!.data).toEqual({ trigger_event_id: ev.id.toString() });
    expect(runs[1]!.data).toEqual({ due_at: "2026-11-01T09:00:00.000Z" });
    expect(runs[3]!.data).toEqual({ due_at: "2026-11-08T06:00:00.000Z" });
    expect(runs.every((x) => x.dedupeKey?.startsWith(`run:${en!.id}:`))).toBe(true);
  });

  it("A-16 a missing anchor writes failed (anchor_missing) and no enrolment", async () => {
    const a = await makeAutomation(h.db, { isMarketing: false, definition: eventDef });
    const p = await makePerson(h.db);
    const ev = await makeEvent(h.db, { personId: p.id, kind: "booking.confirmed", refType: "booking", refId: "bk2", data: { session_kind: "event" }, occurredAt: now });
    expect(await go(a.id, p.id, { source: "trigger", event: ev })).toEqual({ status: "skipped", outcome: "anchor_missing" });
    expect(await runsOf(p.id)).toEqual([expect.objectContaining({ outcome: "failed", reason: "anchor_missing", enrolmentId: null, dedupeKey: `entry:${a.id}:${ev.id}` })]);
    expect(await enrolmentsOf(p.id)).toEqual([]);
  });

  it("A-16 an anchor entirely in the past completes at once with anchor_passed", async () => {
    const a = await makeAutomation(h.db, { isMarketing: false, definition: eventDef });
    const p = await makePerson(h.db);
    const ev = await makeEvent(h.db, { personId: p.id, kind: "booking.confirmed", refType: "booking", refId: "bk3", data: { session_kind: "event", starts_at: "2026-11-05T09:00:00Z" }, occurredAt: now });
    expect((await go(a.id, p.id, { source: "trigger", event: ev })).status).toBe("enrolled");
    const [en] = await enrolmentsOf(p.id);
    expect(en).toMatchObject({ status: "completed", endReason: "anchor_passed", nextStepAt: null, nextStepKey: null });
    expect((await runsOf(p.id)).map((x) => x.outcome)).toEqual(["entered", "skipped_late_entry", "skipped_late_entry", "skipped_late_entry", "completed"]);
  });

  it("an explicit staff anchor is used when the definition has a data anchor", async () => {
    const a = await makeAutomation(h.db, { isMarketing: false, definition: eventDef });
    const p = await makePerson(h.db);
    const anchorAt = new Date("2026-12-20T09:00:00Z");
    expect((await go(a.id, p.id, { anchorAt, subjectKey: "booking:bk9" })).status).toBe("enrolled");
    const [en] = await h.db.select().from(automationEnrolments).where(and(eq(automationEnrolments.personId, p.id), eq(automationEnrolments.status, "active")));
    expect(en).toMatchObject({ anchorAt, nextStepKey: "reminder_7d", source: "staff", triggerEventId: null });
  });
});
