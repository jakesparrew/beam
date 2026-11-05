/**
 * finance-P8 `getFinanceDashboard` (finance spec section 5, rule 44, decision 30) on a seeded
 * book: paid orders over two VAT rates, a voucher sale, a partial refund settled the next day, an
 * October invoice fully credited in November, a recurring membership renewal, two open bank
 * transfer invoices, failed and expired payments around a Brussels midnight, and memberships in
 * every state. Every tile is compared with a value computed by hand from the seed below.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { LOCALES } from "@beam/core/i18n";
import { makeMembership } from "@beam/db/testing/credits-factories";
import { makeOrder } from "@beam/db/testing/commerce-factories";
import { payments } from "@beam/db/schema";
import { eq, setAppDb } from "@/lib/ctx";
import { issueCreditNote, issueInvoice, markCreditNoteSettled } from "./api";
import { openInvoice } from "./finance-p4.helpers";
import { getFinanceDashboard } from "./queries";
import { asTx, ctxAt, makePerson, paidOrder, payment, refund, setupDb } from "./service/__tests__/fixtures";
import { FinanceDashboardView } from "./ui/dashboard/finance-dashboard";
import { financeLabels } from "./ui/labels";

vi.mock("@/registry/jobs.generated", async (importOriginal) => {
  const { withFinanceJobStubs } = await import("./service/__tests__/fixtures");
  return withFinanceJobStubs(await importOriginal<{ JOB_BY_KIND: Record<string, unknown> }>());
});

let h: DbHandle;
const at = (iso: string) => new Date(iso);
/** The test clock: fiscal years start in 2026 (the first series), so "last year" is 2026. */
const T = at("2027-11-04T10:00:00Z");

/** A paid order with `lines`, its payment and its invoice, issued at `when`. */
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

  // Last year: G, 10 November 2025, card, 60.50 at 21 % (net 50.00, VAT 10.50).
  await sale(at("2026-11-02T10:00:00Z"), [{ unitAmountCents: 6_050 }], { provider: "stripe", method: "card" });

  // October: C, 15 October, 121.00 at 21 % (net 100.00, VAT 21.00); fully credited on 4 November.
  const c = await sale(at("2027-10-15T10:00:00Z"), [{ unitAmountCents: 12_100 }]);
  await failedPayment("failed", 2_000, "2027-10-10T10:00:00Z");

  // A, 2 November: item 121.00 at 21 % and package 106.00 at 6 % (net 200.00, VAT 27.00).
  const a = await sale(at("2027-11-02T10:00:00Z"), [{ unitAmountCents: 12_100 }, { productKind: "package", unitAmountCents: 10_600, vatRatePct: "6.00", vatCents: 600 }]);
  await h.db.update(payments).set({ status: "partially_refunded", refundedCents: 12_100 }).where(eq(payments.id, a.pay.id));
  // 3 November: the item of A refunded (credit note -100.00 net, -21.00 VAT), settled the same day.
  const refA = await refund(h.db, a.pay, 12_100);
  await issueCreditNote(asTx(h.db), ctxAt(h.db, at("2027-11-03T09:00:00Z")), {
    invoiceId: a.invoiceId,
    refundId: refA.id,
    reason: "Item returned",
    lines: [{ orderLineId: a.orderLines[0]!.id, quantity: 1 }],
  });
  await markCreditNoteSettled(asTx(h.db), ctxAt(h.db, at("2027-11-03T12:00:00Z")), { refundId: refA.id, settledAt: at("2027-11-03T12:00:00Z") });
  // B, 3 November: a gift voucher of 50.00 (0 %), paid by card: a liability, not revenue.
  await sale(at("2027-11-03T10:00:00Z"), [{ productKind: "voucher", unitAmountCents: 5_000, vatRatePct: "0.00", vatCents: 0 }], { provider: "stripe", method: "card" });

  // 4 November: C fully credited (refund not settled yet, so no cash outflow).
  const refC = await refund(h.db, c.pay, 12_100);
  await issueCreditNote(asTx(h.db), ctxAt(h.db, at("2027-11-04T08:00:00Z")), { invoiceId: c.invoiceId, refundId: refC.id, reason: "Cancelled stay" });
  // D, 4 November: a membership renewal (recurring order) of 36.30 at 21 % (net 30.00, VAT 6.30), direct debit.
  await sale(at("2027-11-04T09:00:00Z"), [{ productKind: "membership", unitAmountCents: 3_630 }], { method: "directdebit" }, "recurring");
  // E and F, 4 November (NOW): open bank-transfer invoices, E overdue (due 20 October 2026).
  await openInvoice(h.db, { totalCents: 12_100, dueOn: "2026-10-20", now: T });
  await openInvoice(h.db, { totalCents: 6_050, dueOn: "2099-01-31", now: T });

  // Failed payments in November: 1 Nov 09:00 UTC; 31 Oct 23:30 UTC = 1 Nov 00:30 Brussels; 3 Nov 23:30 UTC = 4 Nov in Brussels.
  await failedPayment("failed", 3_000, "2027-11-01T09:00:00Z");
  await failedPayment("failed", 2_500, "2027-10-31T23:30:00Z");
  await failedPayment("expired", 4_500, "2027-11-03T23:30:00Z");

  // Memberships: active since September, past due since October, cancelled on 2 November, and a pending one.
  await makeMembership(h.db, { status: "active", startedAt: at("2027-09-01T08:00:00Z") });
  await makeMembership(h.db, { status: "past_due", startedAt: at("2027-10-01T08:00:00Z"), pastDueSinceAt: at("2027-11-01T08:00:00Z") });
  await makeMembership(h.db, { status: "cancelled", startedAt: at("2027-08-01T08:00:00Z"), endedAt: at("2027-11-02T08:00:00Z") });
  await makeMembership(h.db, { status: "pending", startedAt: at("2027-11-04T08:00:00Z") });
});
afterAll(() => h.close());

describe("getFinanceDashboard: month of November 2027", () => {
  it("resolves the month with October and November 2025 for comparison", async () => {
    const d = await getFinanceDashboard(h.db, { period: "month", now: T });
    expect(d.period).toMatchObject({
      period: "month",
      from: "2027-11-01",
      to: "2027-11-30",
      previous: { from: "2027-10-01", to: "2027-10-31" },
      lastYear: { from: "2026-11-01", to: "2026-11-30" },
      granularity: "day",
    });
    expect(d.hasData).toBe(true);
  });

  it("every tile equals the hand-computed value", async () => {
    const { tiles } = await getFinanceDashboard(h.db, { period: "month", now: T });
    // A 200.00 - CN(A) 100.00 - CN(C) 100.00 + D 30.00 + E 100.00 + F 50.00; the voucher is left out.
    expect(tiles.netRevenue).toEqual({ current: 18_000, previous: 10_000, lastYear: 5_000 });
    // 27.00 - 21.00 + 0 - 21.00 + 6.30 + 21.00 + 10.50.
    expect(tiles.vatCollected).toEqual({ current: 2_280, previous: 2_100, lastYear: 1_050 });
    expect(tiles.refunds).toEqual({ current: 20_000, previous: 0, lastYear: 0 });
    expect(tiles.voucherSales).toEqual({ current: 5_000, previous: 0, lastYear: 0 });
    // Payments of A (227.00, partially refunded), B (50.00) and D (36.30).
    expect(tiles.cashInflow).toEqual({ current: 31_330, previous: 12_100, lastYear: 6_050 });
    expect(tiles.failedPayments).toEqual({ current: 3, previous: 1, lastYear: 0 });
    expect(tiles.recurringRevenue).toEqual({ current: 3_000, previous: 0, lastYear: 0 });
    // Live now: active and past due; at the end of October also the one cancelled on 2 November.
    expect(tiles.activeMemberships).toEqual({ current: 2, previous: 3, lastYear: 0 });
    expect(tiles.openInvoices).toEqual({ count: 2, amountCents: 18_150, overdueCount: 1, overdueCents: 12_100 });
  });

  it("splits revenue by category (voucher last, as a liability) and by payment method", async () => {
    const d = await getFinanceDashboard(h.db, { period: "month", now: T });
    expect(d.byCategory).toEqual([
      { category: "package", liability: false, current: 10_000, previous: 0, lastYear: 0 },
      { category: "item", liability: false, current: 5_000, previous: 10_000, lastYear: 5_000 },
      { category: "membership", liability: false, current: 3_000, previous: 0, lastYear: 0 },
      { category: "voucher", liability: true, current: 5_000, previous: 0, lastYear: 0 },
    ]);
    expect(d.byMethod).toEqual([
      { method: "unknown", current: 15_000, previous: 0, lastYear: 0 },
      { method: "directdebit", current: 3_000, previous: 0, lastYear: 0 },
      { method: "bancontact", current: 0, previous: 10_000, lastYear: 0 },
      { method: "creditcard", current: 0, previous: 0, lastYear: 5_000 },
    ]);
  });

  it("sums VAT by quarter and rate, vouchers included", async () => {
    const d = await getFinanceDashboard(h.db, { period: "month", now: T });
    expect(d.vatByRate).toEqual([
      { quarter: "2027-Q4", ratePct: 21, netCents: 8_000, vatCents: 1_680, grossCents: 9_680 },
      { quarter: "2027-Q4", ratePct: 6, netCents: 10_000, vatCents: 600, grossCents: 10_600 },
      { quarter: "2027-Q4", ratePct: 0, netCents: 5_000, vatCents: 0, grossCents: 5_000 },
    ]);
    expect(d.vatByRate.reduce((s, r) => s + r.vatCents, 0)).toBe(d.tiles.vatCollected.current);
  });

  it("draws the daily trend with the previous month and last year aligned by day", async () => {
    const { revenueTrend } = await getFinanceDashboard(h.db, { period: "month", now: T });
    expect(revenueTrend.granularity).toBe("day");
    expect(revenueTrend.points).toHaveLength(30);
    const point = (day: string) => revenueTrend.points.find((p) => p.bucket === day);
    expect(point("2027-11-02")).toEqual({ bucket: "2027-11-02", currentCents: 20_000, previousCents: 0, lastYearCents: 5_000 });
    // Credit notes reduce revenue on their own date: 3 November is negative.
    expect(point("2027-11-03")?.currentCents).toBe(-10_000);
    expect(point("2027-11-04")?.currentCents).toBe(8_000);
    expect(point("2027-11-15")?.previousCents).toBe(10_000);
    expect(revenueTrend.points.reduce((s, p) => s + p.currentCents, 0)).toBe(18_000);
  });

  it("shows cash in and out per day with the totals", async () => {
    const { cashFlow } = await getFinanceDashboard(h.db, { period: "month", now: T });
    expect(cashFlow.totals).toEqual({ inflowCents: 31_330, outflowCents: 12_100, netCents: 19_230 });
    expect(cashFlow.points.filter((p) => p.inflowCents || p.outflowCents)).toEqual([
      { bucket: "2027-11-02", inflowCents: 22_700, outflowCents: 0 },
      { bucket: "2027-11-03", inflowCents: 5_000, outflowCents: 12_100 },
      { bucket: "2027-11-04", inflowCents: 3_630, outflowCents: 0 },
    ]);
  });

  it("lists the open invoices most overdue first and the failed payments of the period newest first", async () => {
    const d = await getFinanceDashboard(h.db, { period: "month", now: T });
    expect(d.openInvoices.rows.map((r) => [r.amountDueCents, r.daysOverdue > 0, r.dueOn])).toEqual([
      [12_100, true, "2026-10-20"],
      [6_050, false, "2099-01-31"],
    ]);
    expect(d.failedPayments).toMatchObject({ count: 3, amountCents: 10_000, pastDueMemberships: 1 });
    expect(d.failedPayments.rows.map((r) => [r.status, r.amountCents, r.failedAt.toISOString()])).toEqual([
      ["expired", 4_500, "2027-11-03T23:30:00.000Z"],
      ["failed", 3_000, "2027-11-01T09:00:00.000Z"],
      ["failed", 2_500, "2027-10-31T23:30:00.000Z"],
    ]);
    expect(d.failedPayments.rows[1]).toMatchObject({ provider: "mollie", method: "bancontact", reason: "insufficient_funds" });
  });

  it("reports the recurring renewal per month", async () => {
    const { recurring } = await getFinanceDashboard(h.db, { period: "month", now: T });
    expect(recurring).toEqual({
      invoiceCount: 1,
      netCents: 3_000,
      grossCents: 3_630,
      activeMemberships: 2,
      months: [{ month: "2027-11-01", invoiceCount: 1, netCents: 3_000, grossCents: 3_630 }],
    });
  });
});

describe("getFinanceDashboard: other periods", () => {
  it("credit notes reduce revenue on their own date, never on the invoice's date", async () => {
    const nov3 = await getFinanceDashboard(h.db, { period: "custom", from: "2027-11-03", to: "2027-11-03", now: T });
    expect(nov3.tiles.netRevenue).toEqual({ current: -10_000, previous: 20_000, lastYear: 0 });
    expect(nov3.tiles.refunds.current).toBe(10_000);
    expect(nov3.tiles.voucherSales.current).toBe(5_000);
    const oct15 = await getFinanceDashboard(h.db, { period: "custom", from: "2027-10-15", to: "2027-10-15", now: T });
    expect(oct15.tiles.netRevenue.current).toBe(10_000);
    expect(oct15.tiles.refunds.current).toBe(0);
  });

  it("counts a failure at 00:30 Brussels on the Brussels day", async () => {
    const day = await getFinanceDashboard(h.db, { period: "day", now: at("2027-11-04T10:00:00Z") });
    expect(day.tiles.failedPayments).toEqual({ current: 1, previous: 0, lastYear: 0 });
    expect(day.tiles.netRevenue).toEqual({ current: 8_000, previous: -10_000, lastYear: 0 });
  });

  it("uses monthly buckets for year to date", async () => {
    const ytd = await getFinanceDashboard(h.db, { period: "ytd", now: T });
    expect(ytd.revenueTrend.granularity).toBe("month");
    expect(ytd.revenueTrend.points.map((p) => p.bucket)).toHaveLength(11);
    expect(ytd.revenueTrend.points.at(-2)).toMatchObject({ bucket: "2027-10-01", currentCents: 10_000 });
    expect(ytd.revenueTrend.points.at(-1)).toMatchObject({ bucket: "2027-11-01", currentCents: 18_000, lastYearCents: 5_000 });
    expect(ytd.tiles.netRevenue).toEqual({ current: 28_000, previous: 5_000, lastYear: 5_000 });
  });

  it("an empty period has zero tiles and no data; open invoices stay the state now", async () => {
    const empty = await getFinanceDashboard(h.db, { period: "custom", from: "2024-01-01", to: "2024-01-31", now: T });
    expect(empty.hasData).toBe(false);
    expect(empty.tiles.netRevenue).toEqual({ current: 0, previous: 0, lastYear: 0 });
    expect(empty.tiles.cashInflow.current).toBe(0);
    expect(empty.byCategory).toEqual([]);
    expect(empty.failedPayments.rows).toEqual([]);
    expect(empty.tiles.openInvoices.count).toBe(2);
  });

  it("refuses an invalid custom range", async () => {
    await expect(getFinanceDashboard(h.db, { period: "custom", from: "2027-11-05", to: "2027-11-01", now: T })).rejects.toThrow(RangeError);
  });
});

describe("the dashboard screen", () => {
  it.each(LOCALES)("renders the seeded month in %s with the tiles, charts, tables and a CSV per table", async (locale) => {
    const data = await getFinanceDashboard(h.db, { period: "month", now: T });
    const html = renderToStaticMarkup(createElement(FinanceDashboardView, { data, labels: financeLabels(locale, ["dashboard"]), locale }));
    expect(html).toContain('data-testid="tile-net-revenue" data-value="18000"');
    expect(html).toContain('data-testid="tile-open-invoices" data-value="18150"');
    for (const id of ["chart-revenue-trend", "chart-cash-flow", "breakdown-category", "breakdown-method", "table-vat", "table-open-invoices", "table-failed-payments", "table-recurring"]) {
      expect(html, id).toContain(`data-testid="${id}"`);
    }
    expect(html.match(/download="beam-dashboard-[a-z-]+-2027-11-01-2027-11-30\.csv"/g)).toHaveLength(8);
    expect(html).not.toContain("dashboard.");
    expect(html).not.toContain('data-testid="dashboard-no-data"');
  });

  it("puts the hand-computed figures in the CSV of the open invoices", async () => {
    const data = await getFinanceDashboard(h.db, { period: "month", now: T });
    const html = renderToStaticMarkup(createElement(FinanceDashboardView, { data, labels: financeLabels("en", ["dashboard"]), locale: "en" }));
    const href = /href="(data:text\/csv[^"]+)" download="beam-dashboard-open-invoices/.exec(html)?.[1];
    const csv = decodeURIComponent(href!.replace(/&amp;/g, "&").slice("data:text/csv;charset=utf-8,".length));
    const lines = csv.replace(/^﻿/, "").trim().split("\r\n");
    expect(lines[0]).toBe("number;customer;issued_on;due_on;amount_due_eur;days_overdue");
    expect(lines.slice(1).map((line) => line.split(";").slice(3, 5))).toEqual([
      ["2026-10-20", "121.00"],
      ["2099-01-31", "60.50"],
    ]);
  });

  it("shows zero tiles and the no-data notice for an empty period", async () => {
    const data = await getFinanceDashboard(h.db, { period: "custom", from: "2024-01-01", to: "2024-01-31", now: T });
    const html = renderToStaticMarkup(createElement(FinanceDashboardView, { data, labels: financeLabels("nl-BE", ["dashboard"]), locale: "nl-BE" }));
    expect(html).toContain('data-testid="dashboard-no-data"');
    expect(html).toContain("Geen gegevens in deze periode.");
    expect(html).toContain('data-testid="tile-net-revenue" data-value="0"');
  });
});
