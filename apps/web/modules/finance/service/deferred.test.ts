/**
 * finance-P9 deferred revenue, breakage and euro voucher redemptions (finance spec rule 43,
 * section 12 finance-P9). Grants and ledger entries are written through credits' real functions
 * (`grantCredits`, `consumeCredits`, `revokeGrantRemainder` and the `credits.expire_grant` job),
 * each at a pinned instant, so the figures do not depend on the wall clock:
 *
 * - G1: 10 day credits at 2,000 cents (21 %), granted 10 August 2026; 2 used on 15 September and
 *   2 on 20 October (6 left).
 * - G2: 2 night credits at 9,000 cents (6 %), granted 1 August, 1 used on 1 September, expired on
 *   16 October (1 unit of breakage in October).
 * - G3: 5 day credits at 1,500 cents (21 %), granted 1 October, revoked by a refund on 5 October.
 * - B: a bonus grant of 3 day credits (value 0), 1 used on 20 October.
 * - V: a gift voucher of 50.00 EUR (multi-purpose), granted 1 October; 30.00 EUR paid an order on
 *   25 October whose invoice is issued that day.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DbHandle, Tx } from "@beam/db";
import { vCreditLiability } from "@beam/db/schema";
import { makePerson } from "@beam/db/testing";
import { makePaidOrder } from "@beam/db/testing/commerce-factories";
import { setAppDb } from "@/lib/ctx";
import { loadJobs } from "@/lib/job-runner";
import { makeCtx, makeJobCtx, resetRuntime } from "@/lib/testing";
import { consumeCredits, grantCredits, revokeGrantRemainder } from "@/modules/credits/api";
import { paidB2c } from "../finance-p4.helpers";
import { getBreakage, getDeferredRevenue, getVoucherRedemptions } from "../queries";
import { setupDb } from "./__tests__/fixtures";
import { endOfDayBrussels, splitGross, startOfDayBrussels } from "./deferred";
import { buildExportCsv } from "./exports";

vi.mock("next/server", () => ({ after: () => undefined }));

const at = (iso: string) => new Date(iso);
/** The test's "now": 4 November 2026, 11:00 Brussels. */
const NOW = at("2026-11-04T10:00:00Z");
const TODAY = "2026-11-04";

let h: DbHandle;
let voucherOrder: { orderId: string; number: string };

const tx = () => h.db as unknown as Tx;
const ctxAt = (iso: string) => makeCtx(h.db, { now: at(iso) });

async function consume(personId: string, kind: "day" | "night" | "euro", units: number, iso: string, ref: { type: "booking" | "order"; id: string } = { type: "booking", id: randomUUID() }) {
  await consumeCredits(tx(), ctxAt(iso), { personId, beneficiaryPersonId: personId, kind, units, ref, validAt: at(iso) });
}

beforeAll(async () => {
  h = await setupDb();
  setAppDb(h.db);
  const db = h.db;
  const person = await makePerson(db);
  const pid = person.id;

  // G1 and G3 (day packages) and G2 (nights) come from paid package lines.
  const { lines } = await makePaidOrder(db, {
    personId: pid,
    order: { paidAt: at("2026-08-01T08:00:00Z") },
    lines: [
      { productKind: "package", unitAmountCents: 20_000, vatCents: 3_471 },
      { productKind: "package", unitAmountCents: 18_000, vatRatePct: "6.00", vatCents: 1_019 },
      { productKind: "package", unitAmountCents: 7_500, vatCents: 1_302 },
    ],
  });
  const [l1, l2, l3] = lines as [(typeof lines)[number], (typeof lines)[number], (typeof lines)[number]];

  await grantCredits(tx(), ctxAt("2026-08-10T10:00:00Z"), {
    personId: pid, kind: "day", units: 10, source: "purchase", orderLineId: l1.id, lineUnitIndex: 1,
    unitValueCents: 2_000, vatRatePct: 21, expiresAt: at("2027-08-10T10:00:00Z"), key: `grant:order_line:${l1.id}:1`,
  });
  await consume(pid, "day", 2, "2026-09-15T09:00:00Z");
  await consume(pid, "day", 2, "2026-10-20T09:00:00Z");

  const g2 = await grantCredits(tx(), ctxAt("2026-08-01T10:00:00Z"), {
    personId: pid, kind: "night", units: 2, source: "purchase", orderLineId: l2.id, lineUnitIndex: 1,
    unitValueCents: 9_000, vatRatePct: 6, expiresAt: at("2026-10-15T08:00:00Z"), key: `grant:order_line:${l2.id}:1`,
  });
  await consume(pid, "night", 1, "2026-09-01T18:00:00Z");
  const expireJob = (await loadJobs())["credits.expire_grant"]!;
  await expireJob.run(makeJobCtx(db, "credits.expire_grant", { now: at("2026-10-16T00:10:00Z") }), { grantId: g2.grantId });

  await grantCredits(tx(), ctxAt("2026-10-01T10:00:00Z"), {
    personId: pid, kind: "day", units: 5, source: "purchase", orderLineId: l3.id, lineUnitIndex: 1,
    unitValueCents: 1_500, vatRatePct: 21, expiresAt: at("2027-10-01T10:00:00Z"), key: `grant:order_line:${l3.id}:1`,
  });
  await revokeGrantRemainder(tx(), ctxAt("2026-10-05T10:00:00Z"), { orderLineId: l3.id, reason: "refund" });

  await grantCredits(tx(), ctxAt("2026-10-02T10:00:00Z"), {
    personId: pid, kind: "day", units: 3, source: "bonus", expiresAt: at("2027-01-31T10:00:00Z"), key: `grant:bonus:${randomUUID()}`,
  });

  // The voucher: bought on an order of its own, redeemed on another order.
  const { lines: vLines } = await makePaidOrder(db, { personId: pid, lines: [{ productKind: "voucher", unitAmountCents: 5_000, vatRatePct: "0.00", vatCents: 0 }] });
  await grantCredits(tx(), ctxAt("2026-10-01T12:00:00Z"), {
    personId: pid, kind: "euro", units: 5_000, source: "voucher", orderLineId: vLines[0]!.id, voucherId: randomUUID(),
    expiresAt: at("2027-10-01T12:00:00Z"), key: `grant:voucher:${vLines[0]!.id}`,
  });
  const paying = await paidB2c(db, undefined, at("2026-10-25T09:00:00Z"));
  voucherOrder = { orderId: paying.orderId, number: paying.number };
  await consume(pid, "euro", 3_000, "2026-10-25T09:00:00Z", { type: "order", id: paying.orderId });
  // Consumed bonus credit (value 0).
  await consume(pid, "day", 1, "2026-10-20T10:00:00Z");
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

describe("Brussels day bounds", () => {
  it("ends a day at 23:59:59.999 Brussels, in summer, in winter and on the DST change", () => {
    expect(endOfDayBrussels("2026-09-30").toISOString()).toBe("2026-09-30T21:59:59.999Z");
    expect(endOfDayBrussels("2026-12-31").toISOString()).toBe("2026-12-31T22:59:59.999Z");
    expect(startOfDayBrussels("2026-10-25").toISOString()).toBe("2026-10-24T22:00:00.000Z");
    expect(endOfDayBrussels("2026-10-25").toISOString()).toBe("2026-10-25T22:59:59.999Z");
    expect(endOfDayBrussels("2026-03-29").toISOString()).toBe("2026-03-29T21:59:59.999Z");
  });
});

describe("getDeferredRevenue", () => {
  it("today: the unused day credits are 6 x 2,000 gross with the 21 % split", async () => {
    const d = await getDeferredRevenue(h.db, { asOf: TODAY, now: NOW });
    expect(d.source).toBe("today");
    const day = d.byRate.find((r) => r.creditKind === "day" && r.vatRatePct === 21)!;
    expect(day).toMatchObject({ vatTreatment: "single_purpose", units: 6, ...splitGross(12_000, 21) });
    expect(day).toMatchObject({ grossCents: 12_000, vatCents: 2_083, netCents: 9_917 });
    // The revoked package and the expired nights hold nothing.
    expect(d.byKind.night).toEqual({ grossCents: 0, netCents: 0, vatCents: 0 });
  });

  it("bonus credits of zero value add nothing; the multi-purpose euro credit is split at 0 %", async () => {
    const d = await getDeferredRevenue(h.db, { asOf: TODAY, now: NOW });
    const bonus = d.byRate.find((r) => r.creditKind === "day" && r.vatTreatment === "not_applicable")!;
    expect(bonus).toMatchObject({ units: 2, grossCents: 0, netCents: 0, vatCents: 0 });
    expect(d.byKind.day.grossCents).toBe(12_000);
    const euro = d.byRate.find((r) => r.creditKind === "euro")!;
    expect(euro).toMatchObject({ vatTreatment: "multi_purpose", units: 2_000, grossCents: 2_000, netCents: 2_000, vatCents: 0 });
    expect(d.total).toEqual({ grossCents: 14_000, netCents: 9_917 + 2_000, vatCents: 2_083 });
  });

  it("the as-of-today total equals the sum of v_credit_liability.remaining_value_cents", async () => {
    const d = await getDeferredRevenue(h.db, { asOf: TODAY, now: NOW });
    const view = await h.db.select().from(vCreditLiability);
    expect(d.total.grossCents).toBe(view.reduce((n, v) => n + Number(v.remainingValueCents), 0));
    expect(d.total.netCents + d.total.vatCents).toBe(d.total.grossCents);
    // A later day reads today's view too.
    expect((await getDeferredRevenue(h.db, { asOf: "2027-01-31", now: NOW })).total).toEqual(d.total);
  });

  it("a past day, through getCreditLiabilityAsOf, counts a later consume as unused", async () => {
    const sep = await getDeferredRevenue(h.db, { asOf: "2026-09-30", now: NOW });
    expect(sep).toMatchObject({ source: "as_of", asOf: "2026-09-30" });
    // 30 September: 8 day credits (the October consumes are later), 1 night, no October grant yet.
    expect(sep.byRate.find((r) => r.creditKind === "day")).toMatchObject({ units: 8, ...splitGross(16_000, 21) });
    expect(sep.byRate.find((r) => r.creditKind === "night")).toMatchObject({ units: 1, ...splitGross(9_000, 6) });
    expect(sep.byKind.euro.grossCents).toBe(0);
    expect(sep.total.grossCents).toBe(25_000);
    // The end of 15 September (Brussels) already counts that day's consume.
    expect((await getDeferredRevenue(h.db, { asOf: "2026-09-14", now: NOW })).byKind.day.grossCents).toBe(20_000);
    expect((await getDeferredRevenue(h.db, { asOf: "2026-09-15", now: NOW })).byKind.day.grossCents).toBe(16_000);
  });

  it("refuses a date that is not a day", async () => {
    await expect(getDeferredRevenue(h.db, { asOf: "2026-02-30", now: NOW })).rejects.toThrow(/period_invalid/);
  });
});

describe("getBreakage", () => {
  it("expiry shows as breakage in the expiry month, a revocation as revoked (not breakage)", async () => {
    const rows = await getBreakage(h.db, { from: "2026-08-01", to: "2026-10-31" });
    const octNight = rows.find((r) => r.month === "2026-10-01" && r.creditKind === "night")!;
    expect(octNight.breakage).toEqual(splitGross(9_000, 6));
    expect(octNight.breakage).toEqual({ grossCents: 9_000, netCents: 8_491, vatCents: 509 });
    expect(octNight.revoked.grossCents).toBe(0);
    const sepNight = rows.find((r) => r.month === "2026-09-01" && r.creditKind === "night")!;
    expect(sepNight).toMatchObject({ recognised: { grossCents: 9_000 }, breakage: { grossCents: 0 } });

    const octDay = rows.find((r) => r.month === "2026-10-01" && r.creditKind === "day" && r.vatRatePct === 21)!;
    expect(octDay.recognised).toEqual(splitGross(4_000, 21));
    expect(octDay.revoked).toEqual(splitGross(7_500, 21));
    expect(octDay.breakage.grossCents).toBe(0);
    expect(rows.find((r) => r.month === "2026-09-01" && r.creditKind === "day")!.recognised.grossCents).toBe(4_000);
  });

  it("a month with only grants, or only zero-value bonus use, has no row; months outside the period are left out", async () => {
    const rows = await getBreakage(h.db, { from: "2026-08-01", to: "2026-10-31" });
    expect(rows.some((r) => r.month === "2026-08-01")).toBe(false);
    expect(rows.some((r) => r.creditKind === "day" && r.vatRatePct === null)).toBe(false);
    expect((await getBreakage(h.db, { from: "2026-10-15", to: "2026-10-20" })).every((r) => r.month === "2026-10-01")).toBe(true);
    expect(await getBreakage(h.db, { from: "2025-01-01", to: "2025-12-31" })).toEqual([]);
  });

  it("the euro spend is recognised at 0 %", async () => {
    const rows = await getBreakage(h.db, { from: "2026-10-01", to: "2026-10-31" });
    expect(rows.find((r) => r.creditKind === "euro")!.recognised).toEqual({ grossCents: 3_000, netCents: 3_000, vatCents: 0 });
  });
});

describe("getVoucherRedemptions", () => {
  it("lists the paying order with its invoice number and no person column", async () => {
    const rows = await getVoucherRedemptions(h.db, { from: "2026-10-01", to: "2026-10-31" });
    expect(rows).toEqual([{ redeemedOn: "2026-10-25", orderId: voucherOrder.orderId, invoiceNumber: voucherOrder.number, amountCents: 3_000, isReversed: false }]);
    expect(Object.keys(rows[0]!).some((k) => /person|email|name/i.test(k))).toBe(false);
    expect(await getVoucherRedemptions(h.db, { from: "2026-10-26", to: "2026-10-31" })).toEqual([]);
  });
});

const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
async function csvRows(kind: "deferred_revenue" | "breakage" | "voucher_redemptions", from: string, to: string, pageSize?: number) {
  const built = await buildExportCsv(h.db, kind, { from, to }, pageSize ? { pageSize } : {});
  if (!built.ok) throw new Error(built.error);
  const lines = decoder.decode(built.bytes).replace(/^\uFEFF/, "").trimEnd().split("\r\n");
  return { header: lines[0]!.split(";"), rows: lines.slice(1).map((l) => l.split(";")), rowCount: built.rowCount };
}
const euros = (s: string) => Math.round(Number(s) * 100);

describe("exports equal the query totals", () => {
  it("deferred_revenue: one row per kind, treatment and rate at the end of the period", async () => {
    const { header, rows } = await csvRows("deferred_revenue", "2026-09-01", "2026-09-30");
    const q = await getDeferredRevenue(h.db, { asOf: "2026-09-30", now: NOW });
    expect(header).toEqual(["as_of", "credit_kind", "vat_treatment", "vat_rate", "units", "gross", "net", "vat"]);
    expect(rows).toHaveLength(q.byRate.length);
    expect(rows.every((r) => r[0] === "2026-09-30")).toBe(true);
    const sum = (i: number) => rows.reduce((n, r) => n + euros(r[i]!), 0);
    expect({ grossCents: sum(5), netCents: sum(6), vatCents: sum(7) }).toEqual(q.total);
    expect(rows.find((r) => r[1] === "day")).toEqual(["2026-09-30", "day", "single_purpose", "21", "8", "160.00", "132.23", "27.77"]);
  });

  it("breakage: the monthly rows and their totals", async () => {
    const { header, rows } = await csvRows("breakage", "2026-08-01", "2026-10-31");
    const q = await getBreakage(h.db, { from: "2026-08-01", to: "2026-10-31" });
    expect(header).toEqual(["month", "credit_kind", "vat_rate", "recognised_gross", "breakage_gross", "breakage_net", "breakage_vat", "revoked_gross"]);
    expect(rows).toHaveLength(q.length);
    const sum = (i: number) => rows.reduce((n, r) => n + euros(r[i]!), 0);
    expect(sum(3)).toBe(q.reduce((n, r) => n + r.recognised.grossCents, 0));
    expect(sum(4)).toBe(q.reduce((n, r) => n + r.breakage.grossCents, 0));
    expect(sum(5) + sum(6)).toBe(sum(4));
    expect(sum(7)).toBe(q.reduce((n, r) => n + r.revoked.grossCents, 0));
    expect(rows).toContainEqual(["2026-10-01", "night", "6", "0.00", "90.00", "84.91", "5.09", "0.00"]);
  });

  it("voucher_redemptions: the paying order and its invoice, paged", async () => {
    const { header, rows, rowCount } = await csvRows("voucher_redemptions", "2026-10-01", "2026-10-31", 1);
    expect(header).toEqual(["redeemed_on", "order_id", "invoice_number", "amount", "is_reversed"]);
    expect(rowCount).toBe(1);
    expect(rows).toEqual([["2026-10-25", voucherOrder.orderId, voucherOrder.number, "30.00", "false"]]);
  });
});
