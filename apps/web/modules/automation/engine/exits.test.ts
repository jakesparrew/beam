/**
 * Exits (automation-P2): A-21 built-in exits, A-22 `exit_on` with qualifiers, `same_subject`
 * and the guard, A-25 ending, the A-9 order, `exitAllForPerson`, and the in-use guards
 * `isTemplateInUse` and `isSegmentInUse`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle, Tx } from "@beam/db";
import { automationEnrolments, automationRuns, automations } from "@beam/db/schema";
import { createTestDb, makePerson } from "@beam/db/testing";
import type { PlannedStep } from "@beam/core/automation";
import { asc, eq, sql } from "@/lib/ctx";
import { makeCtx, resetRuntime } from "@/lib/testing";
import { def, evaluate, makeAutomation, makeEvent, makeGroup, maxEventId, resetAutomations, setCursor } from "./automation-p2.fixtures";

vi.mock("@/modules/email/api", async (orig) => ({
  ...(await orig<typeof import("@/modules/email/api")>()),
  getReachability: vi.fn(() => Promise.resolve({ isReachable: true, blockedReason: null })),
}));

const { enrol } = await import("./enrol");
const { endEnrolment } = await import("./exits");
const api = await import("../api");

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
beforeEach(async () => {
  await resetAutomations(h.db);
  await setCursor(h.db, await maxEventId(h.db));
});

const SYSTEM = { kind: "system", jobId: "" } as const;
const staffEnrol = async (automationId: string, personId: string, extra: Partial<Parameters<typeof enrol>[1]> = {}) => {
  const r = await enrol(tx, { automation: automationId, personId, source: "staff", actor: SYSTEM, now: new Date(), ...extra });
  if (r.status !== "enrolled") throw new Error(`not enrolled: ${r.outcome}`);
  return r.enrolmentId;
};
const enrolment = async (id: string) => (await h.db.select().from(automationEnrolments).where(eq(automationEnrolments.id, id)))[0]!;
const runsOfEnrolment = (id: string) => h.db.select().from(automationRuns).where(eq(automationRuns.enrolmentId, id)).orderBy(asc(automationRuns.occurredAt));

/** Three journeys: marketing newsletter, marketing events, transactional. */
async function threeJourneys() {
  const newsletter = await makeAutomation(h.db, { purpose: "newsletter", definition: def({ trigger: { manual: true } }) });
  const events = await makeAutomation(h.db, { purpose: "events", definition: def({ trigger: { manual: true } }) });
  const transactional = await makeAutomation(h.db, { isMarketing: false, definition: def({ trigger: { manual: true } }) });
  const p = await makePerson(h.db);
  return {
    p,
    n: await staffEnrol(newsletter.id, p.id),
    e: await staffEnrol(events.id, p.id),
    t: await staffEnrol(transactional.id, p.id),
  };
}

describe("A-21 built-in exits", () => {
  it("person.merged ends every journey of the loser and none of the winner", async () => {
    const { p, n, t } = await threeJourneys();
    const winner = await makePerson(h.db);
    const a = await makeAutomation(h.db, { definition: def({ trigger: { manual: true } }) });
    const w = await staffEnrol(a.id, winner.id);
    await makeEvent(h.db, { personId: p.id, kind: "person.merged", data: { role: "loser", other_person_id: winner.id } });
    await makeEvent(h.db, { personId: winner.id, kind: "person.merged", data: { role: "winner", other_person_id: p.id } });
    expect((await evaluate(h.db)).exited).toBe(3);
    expect(await enrolment(n)).toMatchObject({ status: "exited", endReason: "merged" });
    expect(await enrolment(t)).toMatchObject({ status: "exited", endReason: "merged" });
    expect((await enrolment(w)).status).toBe("active");
  });

  it("suppression.added ends marketing journeys in scope only", async () => {
    const { p, n, e, t } = await threeJourneys();
    await makeEvent(h.db, { personId: p.id, kind: "suppression.added", data: { scope: "newsletter", reason: "unsubscribe" } });
    await evaluate(h.db);
    expect(await enrolment(n)).toMatchObject({ status: "exited", endReason: "unsubscribed" });
    expect((await enrolment(e)).status).toBe("active");
    expect((await enrolment(t)).status).toBe("active");
    await makeEvent(h.db, { personId: p.id, kind: "suppression.added", data: { scope: "all", reason: "complaint" } });
    await evaluate(h.db);
    expect(await enrolment(e)).toMatchObject({ status: "exited", endReason: "unsubscribed" });
    expect((await enrolment(t)).status).toBe("active");
  });

  it("consent.withdrawn for newsletter ends the newsletter journey in the next evaluate run", async () => {
    const { p, n, e, t } = await threeJourneys();
    await makeEvent(h.db, { personId: p.id, kind: "consent.withdrawn", data: { purpose: "newsletter" } });
    expect((await enrolment(n)).status).toBe("active");
    await evaluate(h.db);
    expect(await enrolment(n)).toMatchObject({ status: "exited", endReason: "consent_withdrawn:newsletter" });
    expect((await enrolment(e)).status).toBe("active");
    expect((await enrolment(t)).status).toBe("active");
  });

  it("privacy.restricted and privacy.objected end marketing journeys only", async () => {
    const one = await threeJourneys();
    await makeEvent(h.db, { personId: one.p.id, kind: "privacy.restricted" });
    const two = await threeJourneys();
    await makeEvent(h.db, { personId: two.p.id, kind: "privacy.objected" });
    await evaluate(h.db);
    expect(await enrolment(one.n)).toMatchObject({ status: "exited", endReason: "restricted" });
    expect(await enrolment(one.e)).toMatchObject({ status: "exited", endReason: "restricted" });
    expect((await enrolment(one.t)).status).toBe("active");
    expect(await enrolment(two.e)).toMatchObject({ status: "exited", endReason: "objected" });
    expect((await enrolment(two.t)).status).toBe("active");
  });

  it("exitAllForPerson ends marketing journeys only; exitPersonEnrolments ends every journey", async () => {
    const { p, n, e, t } = await threeJourneys();
    const ctx = makeCtx(h.db);
    expect(await api.exitAllForPerson(tx, ctx, p.id, "restricted")).toEqual({ exited: 2 });
    expect((await enrolment(n)).endReason).toBe("restricted");
    expect((await enrolment(e)).endReason).toBe("restricted");
    expect((await enrolment(t)).status).toBe("active");
    expect(await api.exitPersonEnrolments(tx, { personId: p.id, reason: "merged", actor: SYSTEM })).toEqual({ exited: 1 });
    expect(await enrolment(t)).toMatchObject({ status: "exited", endReason: "merged" });
  });
});

describe("A-22 exit_on", () => {
  it("kind:qualifier matches data.lines[].kind, purpose or scope", async () => {
    const a = await makeAutomation(h.db, { isMarketing: false, definition: def({ trigger: { manual: true }, exit_on: ["order.paid:package"] }) });
    const p = await makePerson(h.db);
    const id = await staffEnrol(a.id, p.id);
    await makeEvent(h.db, { personId: p.id, kind: "order.paid", data: { lines: [{ kind: "item" }] } });
    await evaluate(h.db);
    expect((await enrolment(id)).status).toBe("active");
    await makeEvent(h.db, { personId: p.id, kind: "order.paid", data: { lines: [{ kind: "item" }, { kind: "package" }] } });
    await evaluate(h.db);
    expect(await enrolment(id)).toMatchObject({ status: "exited", endReason: "exit_event:order.paid" });
  });

  it("same_subject exits only the enrolment of that reference; where resolves {{trigger.data.x}}", async () => {
    const a = await makeAutomation(h.db, {
      isMarketing: false,
      definition: def({
        subject: "ref",
        exit_on: [
          { event: "booking.cancelled", same_subject: true },
          { event: "credits.granted", where: { "data.credit_kind": "{{trigger.data.credit_kind}}" } },
        ],
      }),
    });
    const p = await makePerson(h.db);
    await makeEvent(h.db, { personId: p.id, kind: "test.happened", refType: "booking", refId: "b1", data: { credit_kind: "day" } });
    await makeEvent(h.db, { personId: p.id, kind: "test.happened", refType: "booking", refId: "b2", data: { credit_kind: "night" } });
    await evaluate(h.db);
    const rows = await h.db.select().from(automationEnrolments).where(eq(automationEnrolments.personId, p.id));
    const b1 = rows.find((r) => r.subjectKey === "booking:b1")!;
    const b2 = rows.find((r) => r.subjectKey === "booking:b2")!;
    await makeEvent(h.db, { personId: p.id, kind: "booking.cancelled", refType: "booking", refId: "b1" });
    await evaluate(h.db);
    expect(await enrolment(b1.id)).toMatchObject({ status: "exited", endReason: "exit_event:booking.cancelled" });
    expect((await enrolment(b2.id)).status).toBe("active");
    await makeEvent(h.db, { personId: p.id, kind: "credits.granted", data: { credit_kind: "day" } });
    await evaluate(h.db);
    expect((await enrolment(b2.id)).status).toBe("active");
    await makeEvent(h.db, { personId: p.id, kind: "credits.granted", data: { credit_kind: "night" } });
    await evaluate(h.db);
    expect(await enrolment(b2.id)).toMatchObject({ status: "exited", endReason: "exit_event:credits.granted" });
  });

  it("the A-22 guard: an exit_on naming the trigger kind ends only the older enrolment (package-usage)", async () => {
    const a = await makeAutomation(h.db, {
      isMarketing: false,
      definition: def({ trigger: { event: "credits.threshold_reached" }, subject: "ref", exit_on: [{ event: "credits.threshold_reached", same_subject: true }] }),
    });
    const p = await makePerson(h.db);
    await makeEvent(h.db, { personId: p.id, kind: "credits.threshold_reached", refType: "credit_grant", refId: "g1", data: { pct: 75 } });
    await evaluate(h.db);
    await makeEvent(h.db, { personId: p.id, kind: "credits.threshold_reached", refType: "credit_grant", refId: "g1", data: { pct: 80 } });
    await evaluate(h.db);
    const rows = await h.db.select().from(automationEnrolments).where(eq(automationEnrolments.personId, p.id)).orderBy(asc(automationEnrolments.triggerEventId));
    expect(rows.map((r) => [r.status, r.endReason])).toEqual([
      ["exited", "exit_event:credits.threshold_reached"],
      ["active", null],
    ]);
    expect(rows.every((r) => r.automationId === a.id)).toBe(true);
    // A re-read of both events changes nothing (the guard keeps the newer one).
    await setCursor(h.db, rows[0]!.triggerEventId! - 1n);
    await evaluate(h.db);
    expect((await enrolment(rows[1]!.id)).status).toBe("active");
  });

  it("A-9: an event that exits one journey can start another in the same run (attended ends welcome, starts after-first-visit)", async () => {
    const lane = `lane_x_${Date.now()}`;
    const welcome = await makeAutomation(h.db, { group: await makeGroup(h.db, { isExclusive: true, lane, priority: 30 }), definition: def({ trigger: { manual: true }, exit_on: ["booking.attended"] }) });
    const firstVisit = await makeAutomation(h.db, {
      isMarketing: false,
      group: await makeGroup(h.db, { isExclusive: true, lane, priority: 40 }),
      definition: def({ trigger: { event: "booking.attended", where: { "data.is_first_visit": true } } }),
    });
    const p = await makePerson(h.db);
    const w = await staffEnrol(welcome.id, p.id);
    await makeEvent(h.db, { personId: p.id, kind: "booking.attended", data: { is_first_visit: true } });
    expect(await evaluate(h.db)).toMatchObject({ exited: 1, enrolled: 1 });
    expect(await enrolment(w)).toMatchObject({ status: "exited", endReason: "exit_event:booking.attended" });
    const active = await h.db.select().from(automationEnrolments).where(eq(automationEnrolments.status, "active"));
    expect(active.filter((r) => r.personId === p.id).map((r) => r.automationId)).toEqual([firstVisit.id]);
  });
});

describe("A-25 ending an enrolment", () => {
  it("sets status, ended_at, end_reason, clears next_step_*, marks pending plan entries not_taken and writes one run", async () => {
    const a = await makeAutomation(h.db, {
      definition: def({ steps: [{ key: "s1", type: "tag", tag: "x", at: { from: "enrolment", minutes: 60 } }, { key: "s2", type: "tag", tag: "y", at: { from: "previous", minutes: 60 } }] }),
    });
    const p = await makePerson(h.db);
    const id = await staffEnrol(a.id, p.id);
    expect(await endEnrolment(tx, id, "exited", "manual", SYSTEM)).toBe(true);
    expect(await endEnrolment(tx, id, "exited", "manual", SYSTEM)).toBe(false);
    const row = await enrolment(id);
    expect(row).toMatchObject({ status: "exited", endReason: "manual", nextStepKey: null, nextStepAt: null, endedAt: expect.any(Date) });
    expect((row.plan as PlannedStep[]).map((s) => s.state)).toEqual(["not_taken", "not_taken"]);
    const ends = (await runsOfEnrolment(id)).filter((r) => r.outcome === "exited" || r.outcome === "completed");
    expect(ends).toEqual([expect.objectContaining({ outcome: "exited", reason: "manual", dedupeKey: `run:${id}:exited` })]);
  });

  it("completed is a valid end too", async () => {
    const a = await makeAutomation(h.db);
    const p = await makePerson(h.db);
    const id = await staffEnrol(a.id, p.id);
    expect(await endEnrolment(tx, id, "completed", "completed", SYSTEM)).toBe(true);
    expect(await enrolment(id)).toMatchObject({ status: "completed", endReason: "completed" });
  });
});

describe("in-use guards", () => {
  it("isTemplateInUse is true for an active automation's template and a draft's, false once archived", async () => {
    const slug = `tpl-${Date.now()}`;
    const a = await makeAutomation(h.db, { definition: def({ steps: [{ key: "mail", type: "email", template: slug }] }) });
    expect(await api.isTemplateInUse(h.db, slug)).toBe(true);
    expect(await api.isTemplateInUse(h.db, "other-template")).toBe(false);
    await h.db.update(automations).set({ status: "archived" }).where(eq(automations.id, a.id));
    expect(await api.isTemplateInUse(h.db, slug)).toBe(false);
    await makeAutomation(h.db, { unpublished: true, draftDefinition: { steps: [{ key: "x", type: "email", template: slug }], extra: "draft with issues" } });
    expect(await api.isTemplateInUse(h.db, slug)).toBe(true);
  });

  it("isSegmentInUse covers segment_enter, audience, exclusions and in_segment, of draft, active and paused automations", async () => {
    const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444"];
    const [trigger, audience, exclusion, condition] = ids as [string, string, string, string];
    const t = await makeAutomation(h.db, { definition: def({ trigger: { segment_enter: trigger } }) });
    await makeAutomation(h.db, { status: "paused", definition: def({ audience: { segment_id: audience } }) });
    await makeAutomation(h.db, { unpublished: true, draftDefinition: def({ audience: { exclude_segment_ids: [exclusion] } }) });
    await makeAutomation(h.db, { definition: def({ steps: [{ key: "s1", type: "tag", tag: "x", unless: { not: { in_segment: condition } } }] }) });
    for (const id of ids) expect(await api.isSegmentInUse(h.db, id)).toBe(true);
    expect(await api.isSegmentInUse(h.db, "55555555-5555-4555-8555-555555555555")).toBe(false);
    await h.db.update(automations).set({ status: "archived", pausedAt: null }).where(eq(automations.id, t.id));
    expect(await api.isSegmentInUse(h.db, trigger)).toBe(false);
  });
});

describe("cleanup", () => {
  it("leaves the engine tables consistent", async () => {
    const bad = await h.db.execute(sql`select count(*)::int as n from automation_enrolments where (status = 'active') <> (ended_at is null)`);
    expect((bad as unknown as { rows: { n: number }[] }).rows[0]!.n).toBe(0);
  });
});
