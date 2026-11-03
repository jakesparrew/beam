import { describe, expect, it } from "vitest";
import {
  assertGrantTransition,
  assertMembershipTransition,
  ConflictError,
  GRANT_STATUSES,
  GRANT_TRANSITIONS,
  isGrantTransitionAllowed,
  isMembershipTransitionAllowed,
  MEMBERSHIP_STATUSES,
  MEMBERSHIP_TRANSITIONS,
  type GrantTransitionFrom,
  type MembershipTransitionFrom,
} from "./state-machines";

const grantAllowed = new Set([
  "new>active",
  "active>exhausted",
  "exhausted>active",
  "active>expired",
  "exhausted>expired",
  "expired>active",
  "active>revoked",
  "exhausted>revoked",
  "expired>revoked",
]);

const membershipAllowed = new Set([
  "new>active",
  "new>pending",
  "pending>active",
  "pending>cancelled",
  "active>past_due",
  "past_due>active",
  "active>cancelled",
  "past_due>cancelled",
  "past_due>expired",
  "active>expired",
  "pending>expired",
  "expired>active",
  "imported>active",
  "imported>cancelled",
  "imported>expired",
]);

describe("grant status machine", () => {
  it("lists exactly the section 2 table", () => {
    expect(new Set(GRANT_TRANSITIONS.map((t) => `${t.from}>${t.to}`))).toEqual(grantAllowed);
  });

  const froms: GrantTransitionFrom[] = ["new", ...GRANT_STATUSES];
  for (const from of froms) {
    for (const to of GRANT_STATUSES) {
      const key = `${from}>${to}`;
      if (grantAllowed.has(key)) {
        it(`allows ${key}`, () => {
          expect(() => assertGrantTransition(from, to)).not.toThrow();
          expect(isGrantTransitionAllowed(from, to)).toBe(true);
        });
      } else {
        it(`refuses ${key}`, () => {
          expect(() => assertGrantTransition(from, to)).toThrow(ConflictError);
          expect(isGrantTransitionAllowed(from, to)).toBe(false);
        });
      }
    }
  }

  it("revoked is terminal", () => {
    for (const to of GRANT_STATUSES) expect(isGrantTransitionAllowed("revoked", to)).toBe(false);
  });

  it("throws a conflict error with code and message", () => {
    try {
      assertGrantTransition("revoked", "active");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConflictError);
      expect((e as ConflictError).code).toBe("conflict");
      expect((e as Error).message).toBe("invalid_transition: grant revoked -> active");
      expect((e as Error).name).toBe("ConflictError");
    }
  });
});

describe("membership status machine", () => {
  it("lists exactly the section 2 table", () => {
    expect(new Set(MEMBERSHIP_TRANSITIONS.map((t) => `${t.from}>${t.to}`))).toEqual(membershipAllowed);
  });

  const froms: MembershipTransitionFrom[] = ["new", "imported", ...MEMBERSHIP_STATUSES];
  for (const from of froms) {
    for (const to of MEMBERSHIP_STATUSES) {
      const key = `${from}>${to}`;
      if (membershipAllowed.has(key)) {
        it(`allows ${key}`, () => {
          expect(() => assertMembershipTransition(from, to)).not.toThrow();
          expect(isMembershipTransitionAllowed(from, to)).toBe(true);
        });
      } else {
        it(`refuses ${key}`, () => {
          expect(() => assertMembershipTransition(from, to)).toThrow(ConflictError);
          expect(isMembershipTransitionAllowed(from, to)).toBe(false);
        });
      }
    }
  }

  it("cancelled has no way out", () => {
    for (const to of MEMBERSHIP_STATUSES) expect(isMembershipTransitionAllowed("cancelled", to)).toBe(false);
  });

  it("checks end reasons when given", () => {
    expect(() => assertMembershipTransition("pending", "cancelled", { endReason: "merged" })).not.toThrow();
    expect(() => assertMembershipTransition("active", "cancelled", { endReason: "merged" })).toThrow(/invalid_end_reason/);
    expect(() => assertMembershipTransition("past_due", "expired", { endReason: "payment_failed" })).not.toThrow();
    expect(() => assertMembershipTransition("past_due", "expired", { endReason: "not_renewed" })).not.toThrow();
    expect(() => assertMembershipTransition("active", "expired", { endReason: "payment_failed" })).toThrow(ConflictError);
    expect(() => assertMembershipTransition("active", "expired", { endReason: "erased" })).not.toThrow();
    expect(() => assertMembershipTransition("active", "past_due", { endReason: null })).not.toThrow();
    expect(() => assertMembershipTransition("imported", "expired", { endReason: "not_renewed" })).not.toThrow();
  });

  it("reactivates an expired membership only after a failed payment or a missed link renewal", () => {
    expect(() => assertMembershipTransition("expired", "active", { endReason: "payment_failed" })).not.toThrow();
    expect(() => assertMembershipTransition("expired", "active", { endReason: "not_renewed" })).not.toThrow();
    expect(() => assertMembershipTransition("expired", "active", { endReason: "erased" })).toThrow(/expired \(erased\) -> active/);
  });
});
