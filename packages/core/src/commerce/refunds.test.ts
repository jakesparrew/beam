import { describe, expect, it } from "vitest";
import { allocateRefund, daysBetween, refundPlan, withdrawalPlan, type GrantUsage, type RefundPaymentInput } from "./refunds";

const AT = new Date("2026-11-03T10:00:00Z");
const day = (n: number) => new Date(AT.getTime() + n * 86_400_000);

const grants = (used: number[], unitsGranted = 5): GrantUsage[] => used.map((u, i) => ({ grantId: `g${i + 1}`, unitsGranted, usedUnits: u }));
const card = (amountCents: number, over: Partial<RefundPaymentInput> = {}): RefundPaymentInput => ({
  paymentId: `card-${amountCents}`,
  provider: "mollie",
  status: "paid",
  amountCents,
  refundedCents: 0,
  ...over,
});

describe("refundPlan: amounts per line (rule 36, 37)", () => {
  it("defaults a package line to the unused units pro rata", () => {
    // one 5-day package (20000) with 2 of 5 units used -> 3/5 of 20000
    const plan = refundPlan({
      lines: [{ orderLineId: "l1", productKind: "package", quantity: 1, lineTotalCents: 20_000, refundQuantity: 1, grants: grants([2]) }],
      payments: [card(20_000)],
      at: AT,
    });
    expect(plan.ok).toBe(true);
    expect(plan.lines[0]).toMatchObject({ defaultAmountCents: 12_000, amountCents: 12_000, maxAmountCents: 20_000, creditAction: "revoke", grantIds: ["g1"] });
    expect(plan.creditAction).toBe("revoke");
  });

  it("refunds the least used units of a multi-unit package line first and never a fully used one", () => {
    const plan = refundPlan({
      lines: [{ orderLineId: "l1", productKind: "package", quantity: 3, lineTotalCents: 60_000, refundQuantity: 2, grants: grants([5, 1, 0]) }],
      payments: [card(60_000)],
      at: AT,
    });
    // unused of the chosen grants g3 (5) and g2 (4) = 9 of 15 units
    expect(plan.lines[0]!.grantIds).toEqual(["g3", "g2"]);
    expect(plan.lines[0]!.amountCents).toBe(36_000);
  });

  it("refunds session, ticket and item lines in full by quantity and flags the booking cancel", () => {
    const plan = refundPlan({
      lines: [
        { orderLineId: "s", productKind: "session", quantity: 1, lineTotalCents: 4_500, refundQuantity: 1 },
        { orderLineId: "i", productKind: "item", quantity: 3, lineTotalCents: 3_000, refundQuantity: 2 },
      ],
      payments: [card(7_500)],
      at: AT,
    });
    expect(plan.lines.map((l) => [l.amountCents, l.cancelsBooking, l.creditAction])).toEqual([
      [4_500, true, "none"],
      [2_000, false, "none"],
    ]);
    expect(plan.totalCents).toBe(6_500);
  });

  it("defaults a membership line to the unused days of its period", () => {
    const plan = refundPlan({
      lines: [
        {
          orderLineId: "m",
          productKind: "membership",
          quantity: 1,
          lineTotalCents: 9_000,
          refundQuantity: 1,
          membershipPeriod: { startsAt: day(-10), endsAt: day(20) },
        },
      ],
      payments: [card(9_000)],
      at: AT,
    });
    expect(plan.lines[0]!.amountCents).toBe(6_000); // 20 of 30 days
    expect(plan.lines[0]!.creditAction).toBe("revoke");
  });

  it("refunds a voucher only while active and lists the vouchers to void", () => {
    const ok = refundPlan({
      lines: [
        { orderLineId: "v", productKind: "voucher", quantity: 1, lineTotalCents: 5_000, refundQuantity: 1, vouchers: [{ voucherId: "vo1", status: "active" }] },
      ],
      payments: [card(5_000)],
      at: AT,
    });
    expect(ok.lines[0]!.voucherIds).toEqual(["vo1"]);
    const redeemed = refundPlan({
      lines: [
        { orderLineId: "v", productKind: "voucher", quantity: 1, lineTotalCents: 5_000, refundQuantity: 1, vouchers: [{ voucherId: "vo1", status: "redeemed" }] },
      ],
      payments: [card(5_000)],
      at: AT,
    });
    expect(redeemed.ok).toBe(false);
    expect(redeemed.problems).toEqual([{ code: "voucher_not_refundable", orderLineId: "v" }]);
  });

  it("lets staff lower the amount but never raise it above what is left of the line", () => {
    const base = { orderLineId: "s", productKind: "session" as const, quantity: 1, lineTotalCents: 4_500, refundQuantity: 1 };
    expect(refundPlan({ lines: [{ ...base, amountCents: 2_000 }], payments: [card(4_500)], at: AT }).totalCents).toBe(2_000);
    const high = refundPlan({ lines: [{ ...base, amountCents: 4_501 }], payments: [card(4_500)], at: AT });
    expect(high.problems).toEqual([{ code: "line_amount_too_high", orderLineId: "s" }]);
    const partly = refundPlan({ lines: [{ ...base, refundedCents: 2_000, amountCents: 3_000 }], payments: [card(4_500, { refundedCents: 2_000 })], at: AT });
    expect(partly.ok).toBe(false);
    const rest = refundPlan({ lines: [{ ...base, refundedCents: 2_000 }], payments: [card(4_500, { refundedCents: 2_000 })], at: AT });
    expect(rest.lines[0]!.amountCents).toBe(2_500);
  });

  it("refuses a quantity above what is left and a total above the refundable amount (cap)", () => {
    expect(
      refundPlan({
        lines: [{ orderLineId: "i", productKind: "item", quantity: 2, refundedQuantity: 1, lineTotalCents: 2_000, refundQuantity: 2 }],
        payments: [card(2_000)],
        at: AT,
      }).problems,
    ).toEqual([{ code: "quantity_too_high", orderLineId: "i" }]);
    const capped = refundPlan({
      lines: [{ orderLineId: "i", productKind: "item", quantity: 1, lineTotalCents: 5_000, refundQuantity: 1 }],
      payments: [card(3_000), card(1_000, { paymentId: "failed", status: "failed" })],
      at: AT,
    });
    expect(capped.problems).toEqual([{ code: "refund_too_high" }]);
    expect(capped.refundableCents).toBe(3_000);
    expect(capped.allocations).toEqual([]);
  });

  it("says nothing_to_refund for a zero refund", () => {
    const plan = refundPlan({
      lines: [{ orderLineId: "p", productKind: "package", quantity: 1, lineTotalCents: 20_000, refundQuantity: 1, grants: grants([5]) }],
      payments: [card(20_000)],
      at: AT,
    });
    expect(plan.problems).toEqual([{ code: "nothing_to_refund" }]);
  });
});

describe("refund payment order (rule 38)", () => {
  const balance = (amountCents: number, refundedCents = 0): RefundPaymentInput => ({
    paymentId: "credit",
    provider: "credit_balance",
    status: refundedCents ? "partially_refunded" : "paid",
    amountCents,
    refundedCents,
  });

  it("goes to credit balance first, then provider payments, largest first", () => {
    const allocations = allocateRefund([card(1_000, { paymentId: "small" }), card(3_000, { paymentId: "big" }), balance(2_000)], 5_500);
    expect(allocations.map((a) => [a.paymentId, a.amountCents, a.statusAfter])).toEqual([
      ["credit", 2_000, "refunded"],
      ["big", 3_000, "refunded"],
      ["small", 500, "partially_refunded"],
    ]);
  });

  it("releases euro credit when the whole credit balance comes back, grants it when only part does", () => {
    expect(allocateRefund([balance(2_000)], 2_000)[0]!.euroRestore).toBe("release");
    expect(allocateRefund([balance(2_000)], 500)[0]!.euroRestore).toBe("grant");
    // a later refund of the remainder is a grant, never a second release
    expect(allocateRefund([balance(2_000, 500)], 1_500)[0]!.euroRestore).toBe("grant");
    expect(allocateRefund([card(2_000)], 2_000)[0]!.euroRestore).toBeNull();
  });

  it("skips payments that are not paid and the already refunded part", () => {
    const allocations = allocateRefund(
      [card(4_000, { paymentId: "old", refundedCents: 3_500, status: "partially_refunded" }), card(9_000, { paymentId: "open", status: "open" }), card(1_000)],
      1_200,
    );
    expect(allocations.map((a) => [a.paymentId, a.amountCents])).toEqual([
      ["card-1000", 1_000],
      ["old", 200],
    ]);
  });

  it("refundPlan includes the allocation", () => {
    const plan = refundPlan({
      lines: [{ orderLineId: "i", productKind: "item", quantity: 1, lineTotalCents: 5_000, refundQuantity: 1 }],
      payments: [card(3_000), balance(2_000)],
      at: AT,
    });
    expect(plan.allocations.map((a) => a.provider)).toEqual(["credit_balance", "mollie"]);
  });
});

describe("withdrawalPlan (rule 54)", () => {
  const paidAt = day(-3);

  it("refunds an unused package in full", () => {
    const plan = withdrawalPlan({
      lines: [{ orderLineId: "p", productKind: "package", quantity: 1, lineTotalCents: 20_000, grants: grants([0]) }],
      paidAt,
      at: AT,
    });
    expect(plan.allowed).toBe(true);
    expect(plan.lines[0]).toMatchObject({ outcome: "refund", amountCents: 20_000, grantIds: ["g1"] });
    expect(plan.totalCents).toBe(20_000);
  });

  it("deducts used units at the line's unit value", () => {
    const plan = withdrawalPlan({
      lines: [{ orderLineId: "p", productKind: "package", quantity: 2, lineTotalCents: 38_000, grants: grants([3, 0], 10) }],
      paidAt,
      at: AT,
    });
    // 20 units for 38000 = 1900 per unit; 3 used -> 17 * 1900
    expect(plan.lines[0]!.amountCents).toBe(32_300);
    expect(plan.lines[0]!.grantIds).toEqual(["g1", "g2"]);
  });

  it("turns a membership into a staff task, pro rata by days elapsed", () => {
    const plan = withdrawalPlan({
      lines: [{ orderLineId: "m", productKind: "membership", quantity: 1, lineTotalCents: 8_900, membershipPeriod: { startsAt: paidAt, endsAt: day(27) } }],
      paidAt,
      at: AT,
    });
    // 3 of 30 days elapsed -> 27/30 of 8900
    expect(plan.lines[0]).toMatchObject({ outcome: "task", reason: "membership_needs_staff", amountCents: 8_010 });
    expect(plan.totalCents).toBe(0);
    expect(daysBetween(paidAt, AT)).toBe(3);
  });

  it("refunds an unredeemed voucher and refuses a redeemed one", () => {
    const plan = withdrawalPlan({
      lines: [
        { orderLineId: "v1", productKind: "voucher", quantity: 1, lineTotalCents: 5_000, vouchers: [{ voucherId: "a", status: "active" }] },
        { orderLineId: "v2", productKind: "voucher", quantity: 1, lineTotalCents: 5_000, vouchers: [{ voucherId: "b", status: "redeemed" }] },
      ],
      paidAt,
      at: AT,
    });
    expect(plan.lines.map((l) => [l.outcome, l.reason])).toEqual([
      ["refund", null],
      ["refused", "voucher_used"],
    ]);
  });

  it("exempts dated lines (sessions, nights, tickets)", () => {
    const plan = withdrawalPlan({
      lines: [
        { orderLineId: "s", productKind: "session", quantity: 1, lineTotalCents: 4_500 },
        { orderLineId: "n", productKind: "night", quantity: 1, lineTotalCents: 9_500 },
        { orderLineId: "t", productKind: "ticket", quantity: 1, lineTotalCents: 2_500 },
      ],
      paidAt,
      at: AT,
    });
    expect(plan.lines.every((l) => l.outcome === "refused" && l.reason === "dated_service")).toBe(true);
    expect(plan.allowed).toBe(false);
    expect(plan.reason).toBe("nothing_to_withdraw");
  });

  it("is refused after 14 days", () => {
    const lines = [{ orderLineId: "p", productKind: "package" as const, quantity: 1, lineTotalCents: 20_000, grants: grants([0]) }];
    expect(withdrawalPlan({ lines, paidAt, at: day(11) }).allowed).toBe(true); // day 14 exactly
    const late = withdrawalPlan({ lines, paidAt, at: day(11.01) });
    expect(late).toMatchObject({ allowed: false, reason: "withdrawal_expired", totalCents: 0 });
    expect(late.deadlineAt.toISOString()).toBe(day(11).toISOString());
  });
});

describe("package share against the whole line after a partial refund (review fix 10)", () => {
  // Package qty 2 x 10 units for 200 EUR; grant A has 5 units used, grant B (refunded first) none.
  const a: GrantUsage = { grantId: "A", unitsGranted: 10, usedUnits: 5 };
  const b: GrantUsage = { grantId: "B", unitsGranted: 10, usedUnits: 0 };
  const line = { orderLineId: "p", productKind: "package" as const, quantity: 2, lineTotalCents: 20_000 };

  it("the second partial refund pays only A's unused units", () => {
    const first = refundPlan({ lines: [{ ...line, refundQuantity: 1, grants: [a, b] }], payments: [card(20_000)], at: AT });
    expect(first.lines[0]).toMatchObject({ amountCents: 10_000, grantIds: ["B"] });
    const second = refundPlan({
      lines: [{ ...line, refundQuantity: 1, refundedQuantity: 1, refundedCents: 10_000, grants: [a] }],
      payments: [card(20_000, { refundedCents: 10_000, status: "partially_refunded" })],
      at: AT,
    });
    expect(second.lines[0]).toMatchObject({ amountCents: 5_000, grantIds: ["A"] });
    expect(second.totalCents).toBe(5_000);
  });

  it("a withdrawal after a partial refund pays only the unused units of the grants left", () => {
    const plan = withdrawalPlan({ lines: [{ ...line, refundedCents: 10_000, grants: [a] }], paidAt: day(-3), at: AT });
    expect(plan.lines[0]).toMatchObject({ outcome: "refund", amountCents: 5_000, grantIds: ["A"] });
  });
});
