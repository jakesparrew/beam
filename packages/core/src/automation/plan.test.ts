import { describe, expect, it } from "vitest";
import type { Definition, Step } from "./definition";
import {
  closePlan,
  firstPendingStep,
  markStep,
  nextStep,
  overdueOutcome,
  planIsExhausted,
  planSteps,
  replanForAnchor,
  startPlan,
} from "./plan";
import {
  addBrusselsDays,
  brusselsAt,
  brusselsDate,
  brusselsOffsetMinutes,
  brusselsTimeOfDay,
  isWithinBrusselsWindow,
  nextBrusselsTime,
  utcMinuteBucket,
} from "./time";

const def = (steps: Step[], anchor: Definition["anchor"] = "data.starts_at"): Definition => ({
  schema_version: 1,
  trigger: { event: "booking.confirmed" },
  anchor,
  re_entry: "always",
  exit_on: [],
  steps,
});

const at = (iso: string) => new Date(iso);
const due = (plan: { key: string; due_at: string }[], key: string) => plan.find((p) => p.key === key)!.due_at;
const state = (plan: { key: string; state: string }[], key: string) => plan.find((p) => p.key === key)!.state;

/** `event-registration` (section 3.6): reminders 7 d, 3 d and 3 h before the start. */
const EVENT_REGISTRATION = def([
  { key: "reminder_7d", type: "email", template: "automation.event_reminder_7d", at: { from: "anchor", minutes: -10080 } },
  { key: "reminder_3d", type: "email", template: "automation.event_reminder_3d", at: { from: "anchor", minutes: -4320 } },
  { key: "reminder_day_of", type: "email", template: "automation.event_reminder_day_of", at: { from: "anchor", minutes: -180 } },
]);

describe("planSteps (A-17, A-18)", () => {
  it("A-18 scenario 1: a Friday 10:00 registration for a Sunday 10:00 event skips reminder_7d and reminder_3d", () => {
    const enteredAt = at("2026-11-06T09:00:00Z"); // Friday 10:00 Brussels
    const anchorAt = at("2026-11-08T09:00:00Z"); // Sunday 10:00 Brussels
    const plan = planSteps(EVENT_REGISTRATION, { enteredAt, anchorAt });
    expect(plan.map((p) => [p.key, p.state])).toEqual([
      ["reminder_7d", "skipped"],
      ["reminder_3d", "skipped"],
      ["reminder_day_of", "pending"],
    ]);
    expect(plan[0]).toMatchObject({ reason: "late_entry", due_at: "2026-11-01T09:00:00.000Z" });
    expect(plan[1]).toMatchObject({ reason: "late_entry", due_at: "2026-11-05T09:00:00.000Z" });
    expect(due(plan, "reminder_day_of")).toBe("2026-11-08T06:00:00.000Z");
    expect(firstPendingStep(plan)?.key).toBe("reminder_day_of");
  });

  it("an early registration keeps all three reminders", () => {
    const plan = planSteps(EVENT_REGISTRATION, { enteredAt: at("2026-10-01T09:00:00Z"), anchorAt: at("2026-11-08T09:00:00Z") });
    expect(plan.every((p) => p.state === "pending")).toBe(true);
  });

  it("late_entry send_now makes a late step due at entry (after-first-booking preparation)", () => {
    const d = def([
      { key: "preparation", type: "email", template: "automation.preparation", late_entry: "send_now", at: { from: "anchor", minutes: -2880, snap_to: "10:00" } },
      { key: "intake_reminder", type: "email", template: "automation.intake", late_entry: "send_now", at: { from: "anchor", minutes: -1440, snap_to: "10:00" } },
    ]);
    const enteredAt = at("2026-11-06T15:00:00Z");
    const plan = planSteps(d, { enteredAt, anchorAt: at("2026-11-07T17:00:00Z") });
    expect(plan.map((p) => p.state)).toEqual(["pending", "pending"]);
    expect(due(plan, "preparation")).toBe(enteredAt.toISOString());
    expect(due(plan, "intake_reminder")).toBe(enteredAt.toISOString());
  });

  it("steps timed from the previous step are never late, and count from the last step not skipped", () => {
    const d = def([
      { key: "old", type: "email", template: "t", at: { from: "anchor", minutes: -10080 } },
      { key: "after", type: "email", template: "t", at: { from: "previous", minutes: 60 } },
      { key: "bare", type: "tag", tag: "x" },
    ]);
    const enteredAt = at("2026-11-06T09:00:00Z");
    const plan = planSteps(d, { enteredAt, anchorAt: at("2026-11-08T09:00:00Z") });
    expect(state(plan, "old")).toBe("skipped");
    expect(state(plan, "after")).toBe("pending");
    expect(due(plan, "after")).toBe("2026-11-06T10:00:00.000Z");
    expect(due(plan, "bare")).toBe("2026-11-06T10:00:00.000Z");
  });

  it("adds wait minutes to the following step and plans the wait itself", () => {
    const d = def(
      [
        { key: "welcome", type: "email", template: "t" },
        { key: "pause", type: "wait", minutes: 2880 },
        { key: "edu", type: "email", template: "t" },
      ],
      "enrolment",
    );
    const enteredAt = at("2026-11-02T08:00:00Z");
    const plan = planSteps(d, { enteredAt, anchorAt: null });
    expect(due(plan, "welcome")).toBe("2026-11-02T08:00:00.000Z");
    expect(due(plan, "pause")).toBe("2026-11-04T08:00:00.000Z");
    expect(due(plan, "edu")).toBe("2026-11-04T08:00:00.000Z");
    const next = nextStep(d, plan, "welcome");
    expect(next.next?.key).toBe("edu");
    expect(state(next.plan, "pause")).toBe("done");
  });

  it("snap_to sets the Brussels time across the October DST change", () => {
    const d = def([{ key: "edu", type: "email", template: "t", at: { from: "enrolment", minutes: 1440, snap_to: "10:00" } }], "enrolment");
    // Saturday 2026-10-24 12:00 CEST; Sunday 2026-10-25 is the first day of CET.
    const plan = planSteps(d, { enteredAt: at("2026-10-24T10:00:00Z"), anchorAt: null });
    expect(due(plan, "edu")).toBe("2026-10-25T09:00:00.000Z");
  });

  it("snap_to sets the Brussels time across the March DST change", () => {
    const d = def([{ key: "edu", type: "email", template: "t", at: { from: "enrolment", minutes: 1440, snap_to: "10:00" } }], "enrolment");
    // Saturday 2027-03-27 12:00 CET; Sunday 2027-03-28 is the first day of CEST.
    const plan = planSteps(d, { enteredAt: at("2027-03-27T11:00:00Z"), anchorAt: null });
    expect(due(plan, "edu")).toBe("2027-03-28T08:00:00.000Z");
  });

  it("snap_to never moves an enrolment-relative step before entry; anchor-relative steps keep their date", () => {
    const d = def(
      [
        { key: "today", type: "email", template: "t", at: { from: "enrolment", minutes: 0, snap_to: "10:00" } },
        { key: "before", type: "email", template: "t", at: { from: "anchor", minutes: -2880, snap_to: "10:00" } },
      ],
      "data.starts_at",
    );
    const plan = planSteps(d, { enteredAt: at("2026-11-02T14:00:00Z"), anchorAt: at("2026-11-10T18:00:00Z") });
    expect(due(plan, "today")).toBe("2026-11-03T09:00:00.000Z");
    expect(due(plan, "before")).toBe("2026-11-08T09:00:00.000Z");
  });

  it("throws for an anchor-relative step without an anchor", () => {
    expect(() => planSteps(EVENT_REGISTRATION, { enteredAt: new Date(), anchorAt: null })).toThrow(/anchor/);
  });

  it("A-16: an anchor already passed leaves nothing to run", () => {
    const plan = planSteps(EVENT_REGISTRATION, { enteredAt: at("2026-11-09T09:00:00Z"), anchorAt: at("2026-11-08T09:00:00Z") });
    expect(planIsExhausted(plan)).toBe(true);
    expect(startPlan(plan).next).toBeNull();
  });
});

describe("nextStep and branch re-planning (A-34)", () => {
  const BRANCHY = def(
    [
      { key: "check", type: "condition", if: { has_tag: "engaged" }, then: "tag_engaged", else: "invite" },
      { key: "tag_engaged", type: "tag", tag: "engaged", at: { from: "previous", minutes: 30 } },
      { key: "invite", type: "email", template: "t", at: { from: "previous", minutes: 60 } },
      { key: "edu", type: "email", template: "t", at: { from: "enrolment", minutes: 14 * 1440 } },
    ],
    "enrolment",
  );
  const t0 = at("2026-11-02T08:00:00Z");
  const plan = planSteps(BRANCHY, { enteredAt: t0, anchorAt: null });

  it("plans the default path linearly", () => {
    expect(plan.map((p) => p.due_at)).toEqual([
      "2026-11-02T08:00:00.000Z",
      "2026-11-02T08:30:00.000Z",
      "2026-11-02T09:30:00.000Z",
      "2026-11-16T08:00:00.000Z",
    ]);
  });

  it("then-branch: next is the target, re-planned from now", () => {
    const now = at("2026-11-02T08:05:00Z");
    const r = nextStep(BRANCHY, plan, "check", { target: "tag_engaged" }, now);
    expect(r.next?.key).toBe("tag_engaged");
    expect(due(r.plan, "tag_engaged")).toBe("2026-11-02T08:35:00.000Z");
    expect(due(r.plan, "invite")).toBe("2026-11-02T09:35:00.000Z");
    expect(due(r.plan, "edu")).toBe("2026-11-16T08:00:00.000Z");
    expect(state(r.plan, "check")).toBe("done");
  });

  it("else-branch: steps jumped over are not_taken and the target is re-planned", () => {
    const now = at("2026-11-02T10:00:00Z");
    const r = nextStep(BRANCHY, plan, "check", { target: "invite" }, now);
    expect(state(r.plan, "tag_engaged")).toBe("not_taken");
    expect(r.next?.key).toBe("invite");
    expect(due(r.plan, "invite")).toBe("2026-11-02T11:00:00.000Z");
  });

  it("end closes the rest of the plan; a plain step moves on in order", () => {
    const end = nextStep(BRANCHY, plan, "check", { target: "end" });
    expect(end.next).toBeNull();
    expect(end.plan.slice(1).every((p) => p.state === "not_taken")).toBe(true);
    const plain = nextStep(BRANCHY, markStep(plan, "check", "done"), "invite");
    expect(plain.next?.key).toBe("edu");
    expect(() => nextStep(BRANCHY, plan, "invite", { target: "check" })).toThrow(/not after/);
    expect(() => nextStep(BRANCHY, plan, "nope")).toThrow(/no step/);
  });

  it("skips step-time skipped entries and closes the plan on exit", () => {
    const skipped = markStep(markStep(plan, "check", "done"), "invite", "skipped", "unless:has_tag");
    const r = nextStep(BRANCHY, skipped, "tag_engaged");
    expect(r.next?.key).toBe("edu");
    expect(closePlan(r.plan).filter((p) => p.state === "not_taken").map((p) => p.key)).toEqual(["edu"]);
  });
});

describe("replanForAnchor (A-27a)", () => {
  it("moves pending anchor steps and skips those now in the past", () => {
    const enteredAt = at("2026-10-01T09:00:00Z");
    const plan = planSteps(EVENT_REGISTRATION, { enteredAt, anchorAt: at("2026-11-08T09:00:00Z") });
    const now = at("2026-11-04T09:00:00Z");
    const moved = replanForAnchor(EVENT_REGISTRATION, plan, { enteredAt, anchorAt: at("2026-11-06T09:00:00Z") }, now);
    expect(state(moved, "reminder_7d")).toBe("skipped");
    expect(state(moved, "reminder_3d")).toBe("skipped");
    expect(moved[1]!.reason).toBe("anchor_moved");
    expect(due(moved, "reminder_day_of")).toBe("2026-11-06T06:00:00.000Z");
  });
});

describe("overdueOutcome (A-28)", () => {
  const dueAt = at("2026-11-01T10:00:00Z");
  it("skips communication steps more than 24 hours late", () => {
    expect(overdueOutcome("email", dueAt, at("2026-11-02T09:00:00Z"), false)).toBe("run");
    expect(overdueOutcome("email", dueAt, at("2026-11-02T11:00:00Z"), false)).toBe("skipped_stale");
    expect(overdueOutcome("notify_slack", dueAt, at("2026-11-03T11:00:00Z"), true)).toBe("skipped_paused");
    expect(overdueOutcome("webhook", dueAt, at("2026-11-03T11:00:00Z"), false)).toBe("skipped_stale");
  });
  it("runs tasks, tags and the other steps however late", () => {
    for (const t of ["task", "tag", "untag", "set_field", "status_override", "enrol", "exit"] as const)
      expect(overdueOutcome(t, dueAt, at("2026-11-05T11:00:00Z"), false)).toBe("run");
  });
});

describe("Brussels time helpers", () => {
  it("brusselsAt is DST-safe on and around the change days", () => {
    expect(brusselsAt(at("2026-07-01T20:00:00Z"), "10:00").toISOString()).toBe("2026-07-01T08:00:00.000Z");
    expect(brusselsAt(at("2026-12-01T20:00:00Z"), "10:00").toISOString()).toBe("2026-12-01T09:00:00.000Z");
    expect(brusselsAt(at("2026-10-25T12:00:00Z"), "01:30").toISOString()).toBe("2026-10-24T23:30:00.000Z");
    // 23:30Z on 31 Dec is already 1 January in Brussels.
    expect(brusselsAt(at("2026-12-31T23:30:00Z"), "10:00").toISOString()).toBe("2027-01-01T09:00:00.000Z");
    expect(() => brusselsAt(new Date(), "10h")).toThrow();
    expect(() => brusselsAt(new Date(), "24:00")).toThrow();
  });

  it("offsets, dates, windows and buckets", () => {
    expect(brusselsOffsetMinutes(at("2026-07-01T00:00:00Z"))).toBe(120);
    expect(brusselsOffsetMinutes(at("2026-12-01T00:00:00Z"))).toBe(60);
    expect(brusselsDate(at("2026-12-31T23:30:00Z"))).toBe("2027-01-01");
    expect(brusselsTimeOfDay(at("2026-12-31T23:30:00Z"))).toBe("00:30");
    expect(addBrusselsDays(at("2026-10-24T08:00:00Z"), 1).toISOString()).toBe("2026-10-25T09:00:00.000Z");
    expect(isWithinBrusselsWindow(at("2026-11-02T21:30:00Z"), "21:00", "08:00")).toBe(true);
    expect(isWithinBrusselsWindow(at("2026-11-02T06:30:00Z"), "21:00", "08:00")).toBe(true);
    expect(isWithinBrusselsWindow(at("2026-11-02T12:00:00Z"), "21:00", "08:00")).toBe(false);
    expect(isWithinBrusselsWindow(at("2026-11-02T12:00:00Z"), "09:00", "17:00")).toBe(true);
    expect(isWithinBrusselsWindow(at("2026-11-02T12:00:00Z"), "09:00", "09:00")).toBe(false);
    expect(nextBrusselsTime(at("2026-11-02T21:30:00Z"), "08:00").toISOString()).toBe("2026-11-03T07:00:00.000Z");
    expect(nextBrusselsTime(at("2026-11-02T05:00:00Z"), "08:00").toISOString()).toBe("2026-11-02T07:00:00.000Z");
    expect(utcMinuteBucket(at("2026-11-02T21:30:45Z"))).toBe("2026-11-02T21:30");
  });
});
