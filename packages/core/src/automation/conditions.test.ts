import { describe, expect, it } from "vitest";
import { conditionPredicates, evaluateCondition, walkCondition, type ConditionScope, type PersonFacts } from "./conditions";
import type { Condition } from "./definition";

const NOW = new Date("2026-11-04T12:00:00Z");
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

const facts = (over: Partial<PersonFacts> = {}): PersonFacts => ({
  now: NOW,
  status: "customer",
  tags: ["engaged"],
  segmentIds: ["seg-1"],
  processingRestricted: false,
  hasActiveMembership: false,
  membershipCancelling: false,
  activeGrants: [
    { grantId: "g-trigger", creditKind: "day" },
    { grantId: "g-night", creditKind: "night" },
  ],
  bookings: [
    { status: "confirmed", kind: "day", startsAt: days(10) },
    { status: "cancelled", kind: "event", startsAt: days(2) },
    { status: "attended", kind: "night", startsAt: days(-3) },
  ],
  formSubmissions: [{ slug: "health-declaration", completedAt: days(-400) }],
  availableForms: ["intake"],
  eventKindsSinceEnrolment: ["email.clicked"],
  triggerBookingStatus: "attended",
  openTaskStepKeys: ["call_1"],
  sentTemplates: [{ template: "welcome-lead-welcome", sentAt: days(-2) }],
  ...over,
});

const scope: ConditionScope = {
  trigger: { kind: "credits.threshold_reached", ref_type: "credit_grant", ref_id: "g-trigger", mode: null, data: { credit_kind: "day", pct: 90 } },
  subjectKey: "credit_grant:g-trigger",
};

const ev = (c: Condition, f: Partial<PersonFacts> = {}, s: ConditionScope = scope) => evaluateCondition(c, facts(f), s);

describe("evaluateCondition: every predicate", () => {
  it("has_future_booking, with kind and within_days", () => {
    expect(ev({ has_future_booking: true }).result).toBe(true);
    expect(ev({ has_future_booking: { kind: "day" } }).result).toBe(true);
    expect(ev({ has_future_booking: { kind: "event" } }).result).toBe(false);
    expect(ev({ has_future_booking: { within_days: 7 } }).result).toBe(false);
    expect(ev({ has_future_booking: { within_days: 14 } }).result).toBe(true);
    expect(ev({ has_future_booking: true }, { bookings: [{ status: "reserved", kind: "night", startsAt: days(1) }] }).result).toBe(true);
    expect(ev({ has_future_booking: true }, { bookings: [] })).toEqual({ result: false, predicate: "has_future_booking" });
  });

  it("status_in, has_tag, in_segment", () => {
    expect(ev({ status_in: ["customer", "member"] }).result).toBe(true);
    expect(ev({ status_in: ["lead"] }).result).toBe(false);
    expect(ev({ has_tag: "engaged" }).result).toBe(true);
    expect(ev({ has_tag: "reviewed" }).result).toBe(false);
    expect(ev({ in_segment: "seg-1" }).result).toBe(true);
    expect(ev({ in_segment: "seg-2" }).result).toBe(false);
  });

  it("membership predicates", () => {
    expect(ev({ has_active_membership: true }).result).toBe(false);
    expect(ev({ has_active_membership: true }, { hasActiveMembership: true }).result).toBe(true);
    expect(ev({ membership_cancelling: true }, { membershipCancelling: true }).result).toBe(true);
    expect(ev({ membership_cancelling: true }).result).toBe(false);
  });

  it("has_other_active_grant ignores the trigger's own grant and resolves {{trigger.data.credit_kind}}", () => {
    expect(ev({ has_other_active_grant: { credit_kind: "{{trigger.data.credit_kind}}" } }).result).toBe(false);
    expect(
      ev({ has_other_active_grant: { credit_kind: "{{trigger.data.credit_kind}}" } }, { activeGrants: [{ grantId: "g-new", creditKind: "day" }] }).result,
    ).toBe(true);
    expect(ev({ has_other_active_grant: { credit_kind: "night" } }).result).toBe(true);
    expect(ev({ has_other_active_grant: { credit_kind: "euro" } }).result).toBe(false);
    // A booking trigger has no grant: any active grant of the kind counts.
    const bookingScope: ConditionScope = { trigger: { kind: "booking.attended", ref_type: "booking", ref_id: "b1", data: {} }, subjectKey: "" };
    expect(ev({ has_other_active_grant: { credit_kind: "day" } }, {}, bookingScope).result).toBe(true);
    expect(ev({ has_other_active_grant: { credit_kind: "{{trigger.data.credit_kind}}" } }, {}, bookingScope).result).toBe(false);
    // The grant id may also come from data.grant_id or from the subject key.
    const dataScope: ConditionScope = { trigger: { kind: "credits.grant_exhausted", data: { grant_id: "g-trigger", credit_kind: "day" } }, subjectKey: "" };
    expect(ev({ has_other_active_grant: { credit_kind: "day" } }, {}, dataScope).result).toBe(false);
    expect(ev({ has_other_active_grant: { credit_kind: "day" } }, {}, { trigger: null, subjectKey: "credit_grant:g-trigger" }).result).toBe(false);
  });

  it("form_completed with and without within_days, and form_available", () => {
    expect(ev({ form_completed: { slug: "health-declaration" } }).result).toBe(true);
    expect(ev({ form_completed: { slug: "health-declaration", within_days: 365 } }).result).toBe(false);
    expect(ev({ form_completed: { slug: "health-declaration", within_days: 500 } }).result).toBe(true);
    expect(ev({ form_completed: { slug: "intake" } }).result).toBe(false);
    expect(ev({ form_available: "intake" }).result).toBe(true);
    expect(ev({ form_available: "health-declaration" }).result).toBe(false);
  });

  it("the after-first-booking intake_reminder unless: skipped while the form is not published", () => {
    const unless: Condition = {
      any: [{ form_completed: { slug: "health-declaration", within_days: 365 } }, { not: { form_available: "health-declaration" } }],
    };
    expect(ev(unless)).toEqual({ result: true, predicate: "not:form_available" });
    expect(ev(unless, { availableForms: ["health-declaration"] })).toEqual({ result: false, predicate: "any" });
    expect(ev(unless, { availableForms: ["health-declaration"], formSubmissions: [{ slug: "health-declaration", completedAt: days(-10) }] })).toEqual({
      result: true,
      predicate: "form_completed",
    });
  });

  it("processing_restricted", () => {
    expect(ev({ processing_restricted: true }).result).toBe(false);
    expect(ev({ processing_restricted: true }, { processingRestricted: true })).toEqual({ result: true, predicate: "processing_restricted" });
  });

  it("event_since_enrolment, booking_status_in, task_open, sent_within_days", () => {
    expect(ev({ event_since_enrolment: "email.clicked" }).result).toBe(true);
    expect(ev({ event_since_enrolment: "order.paid" }).result).toBe(false);
    expect(ev({ booking_status_in: ["no_show", "cancelled"] }).result).toBe(false);
    expect(ev({ booking_status_in: ["attended"] }).result).toBe(true);
    expect(ev({ booking_status_in: ["attended"] }, { triggerBookingStatus: null }).result).toBe(false);
    expect(ev({ task_open: "call_1" }).result).toBe(true);
    expect(ev({ task_open: "call_2" }).result).toBe(false);
    expect(ev({ sent_within_days: { template: "welcome-lead-welcome", days: 7 } }).result).toBe(true);
    expect(ev({ sent_within_days: { template: "welcome-lead-welcome", days: 1 } }).result).toBe(false);
  });

  it("trigger filters the enrolment's trigger event", () => {
    expect(ev({ trigger: { "data.pct": 90 } }).result).toBe(true);
    expect(ev({ trigger: { "data.pct": { in: [50, 75] } } }).result).toBe(false);
    expect(ev({ trigger: { ref_type: "credit_grant" } }).result).toBe(true);
    expect(ev({ trigger: { "data.pct": 90 } }, {}, { trigger: null, subjectKey: "" }).result).toBe(false);
  });
});

describe("all, any, not", () => {
  it("all is true only when every child is; names the first false child", () => {
    expect(ev({ all: [{ has_tag: "engaged" }, { status_in: ["customer"] }] })).toEqual({ result: true, predicate: "all" });
    expect(ev({ all: [{ has_tag: "engaged" }, { has_future_booking: { kind: "event" } }] })).toEqual({ result: false, predicate: "has_future_booking" });
    expect(ev({ all: [] }).result).toBe(true);
  });
  it("any is true when one child is; names the first true child", () => {
    expect(ev({ any: [{ has_tag: "reviewed" }, { has_future_booking: true }] })).toEqual({ result: true, predicate: "has_future_booking" });
    expect(ev({ any: [{ has_tag: "reviewed" }, { status_in: ["lead"] }] })).toEqual({ result: false, predicate: "any" });
    expect(ev({ any: [] }).result).toBe(false);
  });
  it("not negates and nests", () => {
    expect(ev({ not: { has_tag: "engaged" } })).toEqual({ result: false, predicate: "not:has_tag" });
    expect(ev({ not: { any: [{ has_tag: "x" }, { all: [{ has_tag: "engaged" }, { not: { processing_restricted: true } }] }] } }).result).toBe(false);
  });
  it("lists and walks the predicates of a tree", () => {
    const c: Condition = { any: [{ has_future_booking: true }, { not: { all: [{ in_segment: "s" }, { has_tag: "x" }] } }] };
    expect([...conditionPredicates(c)].sort()).toEqual(["has_future_booking", "has_tag", "in_segment"]);
    expect(conditionPredicates(undefined).size).toBe(0);
    const seen: string[] = [];
    walkCondition(c, (n) => seen.push(Object.keys(n)[0]!));
    expect(seen).toEqual(["any", "has_future_booking", "not", "all", "in_segment", "has_tag"]);
  });
  it("throws on an unknown predicate", () => {
    expect(() => evaluateCondition({ bogus: true } as unknown as Condition, facts(), scope)).toThrow(/unknown predicate/);
  });
});
