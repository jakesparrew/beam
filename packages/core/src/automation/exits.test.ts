import { describe, expect, it } from "vitest";
import type { Definition } from "./definition";
import { builtInExitReason, endReasonBase, END_REASONS, exitGuard, matchesExit, matchingExitKind, suppressionCovers } from "./exits";
import type { EventView } from "./filter";

const ev = (kind: string, over: Partial<EventView> = {}): EventView => ({
  id: 100n,
  kind,
  personId: "p1",
  occurredAt: new Date("2026-11-04T12:00:00Z"),
  data: {},
  ...over,
});

describe("matchesExit (A-22)", () => {
  it("plain kinds match the kind only", () => {
    expect(matchesExit(["order.paid", "booking.attended"], ev("order.paid"), "")).toBe(true);
    expect(matchesExit(["order.paid"], ev("order.refunded"), "")).toBe(false);
    expect(matchesExit([], ev("order.paid"), "")).toBe(false);
  });

  it("qualifiers: order.paid:package on data.lines[].kind, data.purpose and data.scope", () => {
    const paid = ev("order.paid", { data: { lines: [{ kind: "item" }, { kind: "package" }] } });
    expect(matchesExit(["order.paid:package"], paid, "")).toBe(true);
    expect(matchesExit(["order.paid:membership"], paid, "")).toBe(false);
    expect(matchesExit(["order.paid:package"], ev("order.paid", { data: { lines: [{ kind: "voucher" }, null] } }), "")).toBe(false);
    expect(matchesExit(["order.paid:package"], ev("order.paid", { data: { lines: "package" } }), "")).toBe(false);
    expect(matchesExit(["consent.withdrawn:newsletter"], ev("consent.withdrawn", { data: { purpose: "newsletter" } }), "")).toBe(true);
    expect(matchesExit(["consent.withdrawn:newsletter"], ev("consent.withdrawn", { data: { purpose: "events" } }), "")).toBe(false);
    expect(matchesExit(["suppression.added:all"], ev("suppression.added", { data: { scope: "all" } }), "")).toBe(true);
    expect(matchesExit(["order.refunded:package"], paid, "")).toBe(false);
  });

  it("same_subject compares ref_type:ref_id with the enrolment subject", () => {
    const exitOn: Definition["exit_on"] = [{ event: "booking.cancelled", same_subject: true }];
    const cancelled = ev("booking.cancelled", { refType: "booking", refId: "b1" });
    expect(matchesExit(exitOn, cancelled, "booking:b1")).toBe(true);
    expect(matchesExit(exitOn, cancelled, "booking:b2")).toBe(false);
    expect(matchesExit(exitOn, ev("booking.cancelled"), "")).toBe(false);
    expect(matchesExit([{ event: "booking.cancelled" }], cancelled, "booking:b2")).toBe(true);
  });

  it("a where with {{trigger.data.credit_kind}} matches credits.granted of the same kind only", () => {
    const exitOn: Definition["exit_on"] = [
      { event: "credits.granted", where: { "data.source": "purchase", "data.credit_kind": "{{trigger.data.credit_kind}}" } },
      "membership.started",
    ];
    const vars = { trigger: { data: { credit_kind: "day", pct: 90 } } };
    expect(matchesExit(exitOn, ev("credits.granted", { data: { source: "purchase", credit_kind: "day" } }), "credit_grant:g1", vars)).toBe(true);
    expect(matchesExit(exitOn, ev("credits.granted", { data: { source: "purchase", credit_kind: "night" } }), "credit_grant:g1", vars)).toBe(false);
    expect(matchesExit(exitOn, ev("credits.granted", { data: { source: "voucher", credit_kind: "day" } }), "credit_grant:g1", vars)).toBe(false);
    expect(matchesExit(exitOn, ev("membership.started"), "credit_grant:g1", vars)).toBe(true);
    expect(matchingExitKind(exitOn, ev("membership.started"), "", vars)).toBe("membership.started");
    expect(matchingExitKind(exitOn, ev("order.paid"), "", vars)).toBeNull();
  });
});

describe("exitGuard (A-22)", () => {
  it("an event never exits the enrolment it created or a later one", () => {
    expect(exitGuard({ triggerEventId: 100n }, ev("credits.threshold_reached", { id: 100n }))).toBe(false);
    expect(exitGuard({ triggerEventId: 101n }, ev("credits.threshold_reached", { id: 100n }))).toBe(false);
    expect(exitGuard({ triggerEventId: 99n }, ev("credits.threshold_reached", { id: 100n }))).toBe(true);
    expect(exitGuard({ triggerEventId: "99" }, ev("x.y", { id: 100 }))).toBe(true);
    expect(exitGuard({ triggerEventId: null }, ev("x.y"))).toBe(true);
  });

  it("edge case 30: the 80 % threshold ends the 75 % enrolment and keeps its own", () => {
    const exitOn: Definition["exit_on"] = [{ event: "credits.threshold_reached", same_subject: true }];
    const e80 = ev("credits.threshold_reached", { id: 201n, refType: "credit_grant", refId: "g1", data: { pct: 80 } });
    const enrol75 = { triggerEventId: 200n, subjectKey: "credit_grant:g1" };
    const enrol80 = { triggerEventId: 201n, subjectKey: "credit_grant:g1" };
    expect(matchesExit(exitOn, e80, enrol75.subjectKey) && exitGuard(enrol75, e80)).toBe(true);
    expect(matchesExit(exitOn, e80, enrol80.subjectKey) && exitGuard(enrol80, e80)).toBe(false);
  });
});

describe("builtInExitReason (A-21, A-24)", () => {
  const marketing = { isMarketing: true, purpose: "newsletter" as const };
  const transactional = { isMarketing: false, purpose: null };

  it("person.merged ends every journey", () => {
    expect(builtInExitReason(ev("person.merged"), marketing)).toBe("merged");
    expect(builtInExitReason(ev("person.merged"), transactional)).toBe("merged");
  });
  it("suppressions end marketing journeys whose purpose is in scope", () => {
    expect(builtInExitReason(ev("suppression.added", { data: { scope: "all" } }), marketing)).toBe("unsubscribed");
    expect(builtInExitReason(ev("suppression.added", { data: { scope: "newsletter" } }), marketing)).toBe("unsubscribed");
    expect(builtInExitReason(ev("suppression.added", { data: { scope: "events" } }), marketing)).toBeNull();
    expect(builtInExitReason(ev("suppression.added", { data: { scope: "all" } }), transactional)).toBeNull();
  });
  it("consent withdrawal needs the automation purpose", () => {
    expect(builtInExitReason(ev("consent.withdrawn", { data: { purpose: "newsletter" } }), marketing)).toBe("consent_withdrawn:newsletter");
    expect(builtInExitReason(ev("consent.withdrawn", { data: { purpose: "events" } }), marketing)).toBeNull();
    expect(builtInExitReason(ev("consent.withdrawn", { data: { purpose: "newsletter" } }), transactional)).toBeNull();
  });
  it("restriction and objection end marketing journeys only", () => {
    expect(builtInExitReason(ev("privacy.restricted"), marketing)).toBe("restricted");
    expect(builtInExitReason(ev("privacy.objected"), marketing)).toBe("objected");
    expect(builtInExitReason(ev("privacy.restricted"), transactional)).toBeNull();
    expect(builtInExitReason(ev("privacy.objected"), transactional)).toBeNull();
    expect(builtInExitReason(ev("order.paid"), marketing)).toBeNull();
  });
  it("suppression scopes and end reasons", () => {
    expect(suppressionCovers("all", "events")).toBe(true);
    expect(suppressionCovers("events", "events")).toBe(true);
    expect(suppressionCovers("newsletter", "events")).toBe(false);
    expect(suppressionCovers("all", null)).toBe(false);
    expect(END_REASONS).toHaveLength(15);
    expect(endReasonBase("exit_event:order.paid")).toBe("exit_event");
    expect(endReasonBase("consent_withdrawn:newsletter")).toBe("consent_withdrawn");
    expect(endReasonBase("manual")).toBe("manual");
  });
});
