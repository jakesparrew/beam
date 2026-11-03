import { describe, expect, it } from "vitest";
import { deriveStatus, isCurrentMembership, isCustomerGrant, isCustomerOrder, statusFromFacts, wasEverMember } from "./status";

const now = new Date("2026-11-03T10:00:00Z");
const paidAt = new Date("2026-10-01T10:00:00Z");
const order = (over: Partial<{ status: string; paidAt: Date | null; totalCents: number; lineKinds: string[] }> = {}) => ({
  status: "paid",
  paidAt,
  totalCents: 9500,
  lineKinds: ["package"],
  ...over,
});
const facts = (over: Partial<Parameters<typeof statusFromFacts>[0]> = {}) =>
  statusFromFacts({ override: null, orders: [], grants: [], memberships: [], now, ...over });

describe("deriveStatus", () => {
  it("derives lead, customer and member", () => {
    expect(deriveStatus({ override: null, hasCurrentMembership: false, hasPaid: false })).toEqual({ derived: "lead", status: "lead" });
    expect(deriveStatus({ override: null, hasCurrentMembership: false, hasPaid: true })).toEqual({ derived: "customer", status: "customer" });
    expect(deriveStatus({ override: null, hasCurrentMembership: true, hasPaid: true })).toEqual({ derived: "member", status: "member" });
    expect(deriveStatus({ override: null, hasCurrentMembership: true, hasPaid: false })).toEqual({ derived: "member", status: "member" });
  });

  it("lets the override win for the status but keeps the derived value", () => {
    expect(deriveStatus({ override: "lead", hasCurrentMembership: false, hasPaid: true })).toEqual({ derived: "customer", status: "lead" });
    expect(deriveStatus({ override: "member", hasCurrentMembership: false, hasPaid: false })).toEqual({ derived: "lead", status: "member" });
    expect(deriveStatus({ override: "customer", hasCurrentMembership: true, hasPaid: true })).toEqual({ derived: "member", status: "customer" });
  });
});

describe("customer orders (rule 58)", () => {
  it.each(["session", "night", "package", "membership", "ticket"])("a paid %s line makes a customer", (kind) => {
    expect(isCustomerOrder(order({ lineKinds: [kind] }))).toBe(true);
  });

  it("an order of only item or voucher lines leaves a lead", () => {
    expect(isCustomerOrder(order({ lineKinds: ["item"] }))).toBe(false);
    expect(isCustomerOrder(order({ lineKinds: ["voucher", "item"] }))).toBe(false);
    expect(isCustomerOrder(order({ lineKinds: ["item", "session"] }))).toBe(true);
  });

  it("a €0 order (free event) does not make a customer", () => {
    expect(isCustomerOrder(order({ totalCents: 0, lineKinds: ["ticket"] }))).toBe(false);
  });

  it("a refunded or partially refunded order keeps the customer", () => {
    expect(isCustomerOrder(order({ status: "refunded" }))).toBe(true);
    expect(isCustomerOrder(order({ status: "partially_refunded" }))).toBe(true);
  });

  it("an unpaid, expired or cancelled order does not count", () => {
    expect(isCustomerOrder(order({ status: "open", paidAt: null }))).toBe(false);
    expect(isCustomerOrder(order({ status: "expired" }))).toBe(false);
    expect(isCustomerOrder(order({ status: "paid", paidAt: null }))).toBe(false);
  });
});

describe("customer grants (rule 58)", () => {
  it("an imported day or night grant makes a customer; a legacy euro import does not", () => {
    expect(isCustomerGrant({ source: "import", creditKind: "day" })).toBe(true);
    expect(isCustomerGrant({ source: "import", creditKind: "night" })).toBe(true);
    expect(isCustomerGrant({ source: "import", creditKind: "euro" })).toBe(false);
    expect(isCustomerGrant({ source: "purchase", creditKind: "day" })).toBe(true);
  });

  it("voucher, bonus, manual, referral, membership and transfer grants do not", () => {
    for (const source of ["voucher", "bonus", "manual", "referral", "membership", "transfer"]) {
      expect(isCustomerGrant({ source, creditKind: source === "voucher" ? "euro" : "day" })).toBe(false);
    }
  });
});

describe("memberships (rules 58, 59)", () => {
  it("active and past_due memberships that started are current", () => {
    expect(isCurrentMembership({ status: "active", startedAt: paidAt }, now)).toBe(true);
    expect(isCurrentMembership({ status: "past_due", startedAt: paidAt }, now)).toBe(true);
    expect(isCurrentMembership({ status: "active", startedAt: new Date("2026-12-01T00:00:00Z") }, now)).toBe(false);
    expect(isCurrentMembership({ status: "pending", startedAt: paidAt }, now)).toBe(false);
    expect(isCurrentMembership({ status: "cancelled", startedAt: paidAt }, now)).toBe(false);
  });

  it("a membership cancelled while pending was never running", () => {
    const start = new Date("2026-12-01T00:00:00Z");
    expect(wasEverMember({ status: "cancelled", startedAt: start, endedAt: new Date("2026-11-20T00:00:00Z") })).toBe(false);
    expect(wasEverMember({ status: "cancelled", startedAt: paidAt, endedAt: now })).toBe(true);
    expect(wasEverMember({ status: "expired", startedAt: paidAt, endedAt: null })).toBe(false);
    expect(wasEverMember({ status: "past_due", startedAt: paidAt, endedAt: null })).toBe(true);
    expect(wasEverMember({ status: "pending", startedAt: start, endedAt: null })).toBe(false);
  });
});

describe("statusFromFacts", () => {
  it("a person with nothing is a lead", () => {
    expect(facts()).toEqual({ derived: "lead", status: "lead", isMember: false });
  });

  it("a waiting lead who pays for a session is reclassified as customer", () => {
    expect(facts({ orders: [order({ lineKinds: ["session"] })] }).status).toBe("customer");
  });

  it("an override lead set by staff stays lead after a payment", () => {
    expect(facts({ override: "lead", orders: [order()] })).toEqual({ derived: "customer", status: "lead", isMember: false });
  });

  it("a redeemed voucher and a goodwill grant leave a lead", () => {
    expect(facts({ grants: [{ source: "voucher", creditKind: "euro" }, { source: "bonus", creditKind: "day" }] }).status).toBe("lead");
  });

  it("past_due counts as member (grace) and sets isMember", () => {
    expect(facts({ memberships: [{ status: "past_due", startedAt: paidAt }] })).toEqual({ derived: "member", status: "member", isMember: true });
  });

  it("the override never grants member benefits", () => {
    expect(facts({ override: "member" }).isMember).toBe(false);
  });

  it("an imported legacy package makes a customer", () => {
    expect(facts({ grants: [{ source: "import", creditKind: "day" }] }).status).toBe("customer");
  });
});
