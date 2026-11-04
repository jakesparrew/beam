import { describe, expect, it } from "vitest";
import {
  isMemberForPricing,
  isMemberMembership,
  isQualifyingGrant,
  isQualifyingOrder,
  isValidOverrideReason,
  mayApplyOverride,
  overrideConflicts,
  resolveStatus,
} from "./status";

const now = new Date("2026-11-03T10:00:00Z");

describe("commercial status (rules 3.8 to 3.12)", () => {
  it("3.8 derived status: member beats customer beats lead", () => {
    expect(resolveStatus({ override: null, hasActiveMembership: true, hasPaidQualifyingOrder: true }).derivedStatus).toBe("member");
    expect(resolveStatus({ override: null, hasActiveMembership: false, hasPaidQualifyingOrder: true }).derivedStatus).toBe("customer");
    expect(resolveStatus({ override: null, hasActiveMembership: false, hasPaidQualifyingOrder: false }).derivedStatus).toBe("lead");
  });

  it("3.8 only a paid order above 0 with a session, night, package, membership or ticket line qualifies", () => {
    expect(isQualifyingOrder({ totalCents: 3500, status: "paid", lineKinds: ["session"] })).toBe(true);
    expect(isQualifyingOrder({ totalCents: 3500, status: "refunded", lineKinds: ["item", "package"] })).toBe(true);
    expect(isQualifyingOrder({ totalCents: 3500, status: "partially_refunded", lineKinds: ["ticket"] })).toBe(true);
    expect(isQualifyingOrder({ totalCents: 3500, status: "paid", lineKinds: ["item", "voucher"] })).toBe(false);
    expect(isQualifyingOrder({ totalCents: 0, status: "paid", lineKinds: ["ticket"] })).toBe(false);
    expect(isQualifyingOrder({ totalCents: 3500, status: "pending", lineKinds: ["night"] })).toBe(false);
  });

  it("3.8 purchase or import grants of day or night credits qualify; others do not", () => {
    expect(isQualifyingGrant({ source: "purchase", creditKind: "day" })).toBe(true);
    expect(isQualifyingGrant({ source: "import", creditKind: "night" })).toBe(true);
    expect(isQualifyingGrant({ source: "membership", creditKind: "day" })).toBe(false);
    expect(isQualifyingGrant({ source: "purchase", creditKind: "euro" })).toBe(false);
  });

  it("3.8 an active or past-due membership that started makes a member", () => {
    expect(isMemberMembership({ status: "active", startsAt: new Date("2026-10-01T00:00:00Z") }, now)).toBe(true);
    expect(isMemberMembership({ status: "past_due", startsAt: new Date("2026-10-01T00:00:00Z") }, now)).toBe(true);
    expect(isMemberMembership({ status: "active", startsAt: new Date("2026-12-01T00:00:00Z") }, now)).toBe(false);
    expect(isMemberMembership({ status: "pending", startsAt: null }, now)).toBe(false);
    expect(isMemberMembership({ status: "cancelled", startsAt: new Date("2026-01-01T00:00:00Z") }, now)).toBe(false);
  });

  it("3.9 status is the override when set, else the derived status", () => {
    expect(resolveStatus({ override: "lead", hasActiveMembership: false, hasPaidQualifyingOrder: true })).toEqual({ status: "lead", derivedStatus: "customer" });
    expect(resolveStatus({ override: undefined, hasActiveMembership: false, hasPaidQualifyingOrder: true })).toEqual({ status: "customer", derivedStatus: "customer" });
  });

  it("3.9 an override reason has 3 to 500 characters", () => {
    expect(isValidOverrideReason("ok")).toBe(false);
    expect(isValidOverrideReason("   ab  ")).toBe(false);
    expect(isValidOverrideReason("VIP guest")).toBe(true);
    expect(isValidOverrideReason("x".repeat(500))).toBe(true);
    expect(isValidOverrideReason("x".repeat(501))).toBe(false);
    expect(isValidOverrideReason(null)).toBe(false);
  });

  it("3.10 an automation (onlyIfUnset) never replaces an existing override; staff may", () => {
    expect(mayApplyOverride(null, true)).toBe(true);
    expect(mayApplyOverride("customer", true)).toBe(false);
    expect(mayApplyOverride("customer", false)).toBe(true);
  });

  it("3.10 a purchase changes the derived status but never the override", () => {
    const before = resolveStatus({ override: "lead", hasActiveMembership: false, hasPaidQualifyingOrder: false });
    const after = resolveStatus({ override: "lead", hasActiveMembership: false, hasPaidQualifyingOrder: true });
    expect(before.status).toBe("lead");
    expect(after).toEqual({ status: "lead", derivedStatus: "customer" });
  });

  it("3.11 an override that differs from the derived status is a conflict", () => {
    expect(overrideConflicts("lead", "customer")).toBe(true);
    expect(overrideConflicts("customer", "customer")).toBe(false);
    expect(overrideConflicts(null, "member")).toBe(false);
  });

  it("3.12 member pricing reads the membership, never the override", () => {
    expect(isMemberForPricing({ hasActiveMembership: false, override: "member" })).toBe(false);
    expect(isMemberForPricing({ hasActiveMembership: true, override: "lead" })).toBe(true);
  });
});
