/**
 * finance-P10 `getFinanceKpis` on the finance dashboard's seeded book (`dashboard.test.ts`), plus
 * two bank-transfer invoices that were open at the end of October (G paid on 2 November, H
 * cancelled on 3 November) and paid credits (a consume in November, an expiry in October). Each
 * KPI must equal the finance dashboard (`getFinanceDashboard`, custom period) or the deferred
 * revenue page (`getDeferredRevenue`, `getBreakage`) for the same period, and `previous` is filled
 * for the equal-length period before. The clock is pinned (`T`), so the test does not depend on
 * the wall clock, a Brussels midnight or a DST change.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { payments } from "@beam/db/schema";
import { makeMembership } from "@beam/db/testing/credits-factories";
import { makeOrder, makePaidOrder } from "@beam/db/testing/commerce-factories";
import { eq, setAppDb } from "@/lib/ctx";
import { loadJobs } from "@/lib/job-runner";
import { makeCtx, makeJobCtx } from "@/lib/testing";
import { consumeCredits, grantCredits } from "@/modules/credits/api";
import { FINANCE_KPI_DEFINITIONS, FINANCE_KPI_KEYS, getFinanceKpis as apiGetFinanceKpis, issueCreditNote, issueInvoice, markCreditNoteSettled } from "./api";
import { openInvoice } from "./finance-p4.helpers";
import { getBreakage, getDeferredRevenue, getFinanceDashboard } from "./queries";
import { asTx, ctxAt, makePerson, paidOrder, payment, refund, setupDb } from "./service/__tests__/fixtures";
import { getFinanceKpis } from "./service/kpis";

vi.mock("next/server", () => ({ after: () => undefined }));
vi.mock("@/registry/jobs.generated", async (importOriginal) => {
  const { withFinanceJobStubs } = await import("./service/__tests__/fixtures");
  return withFinanceJobStubs(await importOriginal<{ JOB_BY_KIND: Record<string, unknown> }>());
});

let h: DbHandle;
const at = (iso: string) => new Date(iso);
/** The test clock: 4 November 2027, 11:00 Brussels (fiscal years start in 2026). */
const T = at("2027-11-04T10:00:00Z");
const NOVEMBER = { from: "2027-11-01", to: "2027-11-30" };
const OCTOBER = { from: "2027-10-01", to: "2027-10-31" };

async function sale(when: Date, lines: Parameters<typeof paidOrder>[1], pay: { provider?: "mollie" | "stripe"; method?: string } = {}, channel?: "recurring") {
  const person = await makePerson(h.db);
  const { order, lines: orderLines } = await paidOrder(h.db, lines, { personId: person.id, paidAt: when, ...(channel ? { channel } : {}) });
  const p = await payment(h.db, order.id, { amountCents: order.totalCents, paidAt: when, provider: pay.provider ?? "mollie", method: pay.method ?? "bancontact" });
  const r = await issueInvoice(asTx(h.db), ctxAt(h.db, when), { orderId: order.id, paymentId: p.id });
  if (r.status !== "issued") throw new Error("not issued");
  return { invoiceId: r.invoiceId, order, orderLines, pay: p };
}

async function failedPayment(status: "failed" | "expired", amountCents: number, failedAt: string) {
  const order = await makeOrder(h.db, { channel: "portal", status: "pending_payment", totalCents: amountCents, subtotalCents: amountCents });
  await h.db.insert(payments).values({
    orderId: order.id,
    provider: "mollie",
    method: "bancontact",
    status,
    amountCents,
    failedReason: status === "failed" ? "insufficient_funds" : null,
    statusHistory: [
      { status: "open", at: "2027-01-01T00:00:00Z", source: "provider" },
      { status, at: failedAt, source: "provider" },
    ],
  });
}

beforeAll(async () => {
  h = await setupDb();
  setAppDb(h.db);
  const tx = asTx(h.db);

  // The dashboard's book (dashboard.test.ts).
  await sale(at("2026-11-02T10:00:00Z"), [{ unitAmountCents: 6_050 }], { provider: "stripe", method: "card" });
  const c = await sale(at("2027-10-15T10:00:00Z"), [{ unitAmountCents: 12_100 }]);
  await failedPayment("failed", 2_000, "2027-10-10T10:00:00Z");
  // Documents are issued in date order (the numbering refuses an earlier issue day).
  // G: open 242.00 issued 20 October, due 27 October (overdue at the end of October), paid 2 November.
  const g = await openInvoice(h.db, { totalCents: 24_200, dueOn: "2027-10-27", now: at("2027-10-20T09:00:00Z") });
  // H: open 121.00 issued 25 October, due 8 November, cancelled (credit note without refund) on 3 November.
  const hInv = await openInvoice(h.db, { totalCents: 12_100, dueOn: "2027-11-08", now: at("2027-10-25T09:00:00Z") });
  await issueInvoice(tx, ctxAt(h.db, at("2027-11-02T09:00:00Z")), { orderId: g.orderId, status: "paid", paidAt: at("2027-11-02T09:00:00Z"), settledVia: "manual" });
  const a = await sale(at("2027-11-02T10:00:00Z"), [{ unitAmountCents: 12_100 }, { productKind: "package", unitAmountCents: 10_600, vatRatePct: "6.00", vatCents: 600 }]);
  await h.db.update(payments).set({ status: "partially_refunded", refundedCents: 12_100 }).where(eq(payments.id, a.pay.id));
  const refA = await refund(h.db, a.pay, 12_100);
  await issueCreditNote(tx, ctxAt(h.db, at("2027-11-03T09:00:00Z")), { invoiceId: a.invoiceId, refundId: refA.id, reason: "Item returned", lines: [{ orderLineId: a.orderLines[0]!.id, quantity: 1 }] });
  await issueCreditNote(tx, ctxAt(h.db, at("2027-11-03T09:30:00Z")), { orderId: hInv.orderId, reason: "Order cancelled", noRefund: true });
  await markCreditNoteSettled(tx, ctxAt(h.db, at("2027-11-03T12:00:00Z")), { refundId: refA.id, settledAt: at("2027-11-03T12:00:00Z") });
  await sale(at("2027-11-03T10:00:00Z"), [{ productKind: "voucher", unitAmountCents: 5_000, vatRatePct: "0.00", vatCents: 0 }], { provider: "stripe", method: "card" });
  const refC = await refund(h.db, c.pay, 12_100);
  await issueCreditNote(tx, ctxAt(h.db, at("2027-11-04T08:00:00Z")), { invoiceId: c.invoiceId, refundId: refC.id, reason: "Cancelled stay" });
  await sale(at("2027-11-04T09:00:00Z"), [{ productKind: "membership", unitAmountCents: 3_630 }], { method: "directdebit" }, "recurring");
  await openInvoice(h.db, { totalCents: 12_100, dueOn: "2026-10-20", now: T });
  await openInvoice(h.db, { totalCents: 6_050, dueOn: "2099-01-31", now: T });
  await failedPayment("failed", 3_000, "2027-11-01T09:00:00Z");
  await failedPayment("failed", 2_500, "2027-10-31T23:30:00Z");
  await failedPayment("expired", 4_500, "2027-11-03T23:30:00Z");
  await makeMembership(h.db, { status: "active", startedAt: at("2027-09-01T08:00:00Z") });
  await makeMembership(h.db, { status: "past_due", startedAt: at("2027-10-01T08:00:00Z"), pastDueSinceAt: at("2027-11-01T08:00:00Z") });
  await makeMembership(h.db, { status: "cancelled", startedAt: at("2027-08-01T08:00:00Z"), endedAt: at("2027-11-02T08:00:00Z") });
  await makeMembership(h.db, { status: "pending", startedAt: at("2027-11-04T08:00:00Z") });

  // Paid credits: 10 day credits at 20.00 (21 %) granted in October, 2 used on 2 November; 2 nights
  // at 90.00 (6 %) granted in August, expired unused on 16 October (breakage in October).
  const person = await makePerson(h.db);
  const { lines } = await makePaidOrder(h.db, {
    personId: person.id,
    order: { paidAt: at("2027-08-01T08:00:00Z") },
    lines: [
      { productKind: "package", unitAmountCents: 20_000, vatCents: 3_471 },
      { productKind: "package", unitAmountCents: 18_000, vatRatePct: "6.00", vatCents: 1_019 },
    ],
  });
  const ctx = (iso: string) => makeCtx(h.db, { now: at(iso) });
  await grantCredits(tx, ctx("2027-10-05T10:00:00Z"), {
    personId: person.id, kind: "day", units: 10, source: "purchase", orderLineId: lines[0]!.id, lineUnitIndex: 1,
    unitValueCents: 2_000, vatRatePct: 21, expiresAt: at("2028-10-05T10:00:00Z"), key: `grant:order_line:${lines[0]!.id}:1`,
  });
  await consumeCredits(tx, ctx("2027-11-02T09:00:00Z"), {
    personId: person.id, beneficiaryPersonId: person.id, kind: "day", units: 2, ref: { type: "booking", id: randomUUID() }, validAt: at("2027-11-02T09:00:00Z"),
  });
  const nights = await grantCredits(tx, ctx("2027-08-01T10:00:00Z"), {
    personId: person.id, kind: "night", units: 2, source: "purchase", orderLineId: lines[1]!.id, lineUnitIndex: 1,
    unitValueCents: 9_000, vatRatePct: 6, expiresAt: at("2027-10-15T08:00:00Z"), key: `grant:order_line:${lines[1]!.id}:1`,
  });
  const expireJob = (await loadJobs())["credits.expire_grant"]!;
  await expireJob.run(makeJobCtx(h.db, "credits.expire_grant", { now: at("2027-10-16T00:10:00Z") }), { grantId: nights.grantId });
});
afterAll(() => h.close());

describe("getFinanceKpis equals the finance dashboard for the same period", () => {
  for (const [name, range] of [["November (includes today)", NOVEMBER], ["October (in the past)", OCTOBER]] as const) {
    it(`${name}: flows, memberships and their previous period`, async () => {
      const k = await getFinanceKpis(h.db, range, T);
      const d = await getFinanceDashboard(h.db, { period: "custom", ...range, now: T });
      const pairs: [keyof typeof d.tiles, "netRevenueCents" | "vatCents" | "cashInCents" | "refundsCents" | "failedPaymentsCount" | "recurringRevenueCents" | "activeMemberships"][] = [
        ["netRevenue", "netRevenueCents"],
        ["vatCollected", "vatCents"],
        ["cashInflow", "cashInCents"],
        ["refunds", "refundsCents"],
        ["failedPayments", "failedPaymentsCount"],
        ["recurringRevenue", "recurringRevenueCents"],
        ["activeMemberships", "activeMemberships"],
      ];
      for (const [tile, key] of pairs) {
        const figure = d.tiles[tile] as { current: number; previous: number };
        expect(k[key], `${key} current`).toBe(figure.current);
        expect(k.previous[key], `${key} previous`).toBe(figure.previous);
      }
      // The comparison period is the dashboard's previous period for a custom range.
      expect(d.period.previous.to).toBe(range === NOVEMBER ? "2027-10-31" : "2027-09-30");
    });

    it(`${name}: deferred revenue and breakage equal the deferred revenue page`, async () => {
      const k = await getFinanceKpis(h.db, range, T);
      const prevTo = range === NOVEMBER ? "2027-10-31" : "2027-09-30";
      const prev = range === NOVEMBER ? { from: "2027-10-02", to: prevTo } : { from: "2027-08-31", to: prevTo };
      expect(k.deferredRevenueCents).toBe((await getDeferredRevenue(h.db, { asOf: range.to, now: T })).total.netCents);
      expect(k.previous.deferredRevenueCents).toBe((await getDeferredRevenue(h.db, { asOf: prevTo, now: T })).total.netCents);
      const breakage = async (r: { from: string; to: string }) => (await getBreakage(h.db, r)).reduce((s, row) => s + row.breakage.netCents, 0);
      expect(k.breakageCents).toBe(await breakage(range));
      expect(k.previous.breakageCents).toBe(await breakage(prev));
    });
  }

  it("November: hand-computed figures for the period and for October", async () => {
    const k = await getFinanceKpis(h.db, NOVEMBER, T);
    // Dashboard book 180.00, minus H's credit note 100.00 on 3 November; October: C 100.00 + G 200.00 + H 100.00.
    expect(k.netRevenueCents).toBe(8_000);
    expect(k.previous.netRevenueCents).toBe(40_000);
    expect(k.refundsCents).toBe(30_000);
    expect(k.failedPaymentsCount).toBe(3);
    expect(k.previous.failedPaymentsCount).toBe(1);
    expect(k.activeMemberships).toBe(2);
    expect(k.previous.activeMemberships).toBe(3);
    // 8 day credits left: 160.00 gross at 21 % is 132.23 net; expiry of 2 nights at 90.00 (6 %) in October.
    expect(k.deferredRevenueCents).toBe(13_223);
    expect(k.breakageCents).toBe(0);
    expect(k.previous.breakageCents).toBe(16_981);
  });

  it("open invoices: now for a period that reaches today, rebuilt at the end of an earlier period", async () => {
    const k = await getFinanceKpis(h.db, NOVEMBER, T);
    const d = await getFinanceDashboard(h.db, { period: "custom", ...NOVEMBER, now: T });
    expect({ count: k.openInvoicesCount, cents: k.openInvoicesCents, overdue: k.overdueCents }).toEqual({
      count: d.openInvoices.count,
      cents: d.openInvoices.amountCents,
      overdue: d.openInvoices.overdueCents,
    });
    expect({ count: k.openInvoicesCount, cents: k.openInvoicesCents, overdue: k.overdueCents }).toEqual({ count: 2, cents: 18_150, overdue: 12_100 });
    // At the end of October G (overdue since 27 October) and H were open; E and F did not exist yet.
    expect({ count: k.previous.openInvoicesCount, cents: k.previous.openInvoicesCents, overdue: k.previous.overdueCents }).toEqual({ count: 2, cents: 36_300, overdue: 24_200 });
    // At the end of 24 October only G (overdue); at the end of 19 October none.
    const oct24 = await getFinanceKpis(h.db, { from: "2027-10-24", to: "2027-10-24" }, T);
    expect({ count: oct24.openInvoicesCount, cents: oct24.openInvoicesCents, overdue: oct24.overdueCents }).toEqual({ count: 1, cents: 24_200, overdue: 0 });
    // At the end of 2 November G is paid (that morning) and H not yet cancelled.
    const nov2 = await getFinanceKpis(h.db, { from: "2027-11-02", to: "2027-11-02" }, T);
    expect({ count: nov2.openInvoicesCount, cents: nov2.openInvoicesCents, overdue: nov2.overdueCents }).toEqual({ count: 1, cents: 12_100, overdue: 0 });
    expect({ count: nov2.previous.openInvoicesCount, cents: nov2.previous.openInvoicesCents }).toEqual({ count: 2, cents: 36_300 });
    const oct19 = await getFinanceKpis(h.db, { from: "2027-10-19", to: "2027-10-19" }, T);
    expect(oct19.openInvoicesCount).toBe(0);
    expect(oct19.openInvoicesCents).toBe(0);
  });
});

describe("api getFinanceKpis", () => {
  it("returns every defined KPI for the period and for previous", async () => {
    const k = await apiGetFinanceKpis(h.db, NOVEMBER);
    for (const key of FINANCE_KPI_KEYS) {
      expect(Number.isInteger(k[key]), key).toBe(true);
      expect(Number.isInteger(k.previous[key]), `previous ${key}`).toBe(true);
    }
    expect(FINANCE_KPI_DEFINITIONS.map((def) => def.key)).toEqual([...FINANCE_KPI_KEYS]);
  });

  it("refuses an invalid range", async () => {
    await expect(apiGetFinanceKpis(h.db, { from: "2027-11-30", to: "2027-11-01" })).rejects.toThrow(RangeError);
    await expect(apiGetFinanceKpis(h.db, { from: "2027-11", to: "2027-11-30" })).rejects.toThrow(RangeError);
  });
});
