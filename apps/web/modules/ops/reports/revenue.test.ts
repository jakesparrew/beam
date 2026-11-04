/**
 * ops rule 34 and 35 (ops-P3): the revenue report over `v_revenue_daily` on `createTestDb()`.
 * Every case uses its own past month and an explicit `at`, so the cases never see each other's
 * orders and never depend on today. Orders come from the commerce factories; refunds and credit
 * notes get minimal rows (no shared factory).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@beam/db";
import { companies, invoices, payments, refunds } from "@beam/db/schema";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import { makeOrder, makeOrderLine, makePaidOrder } from "@beam/db/testing/commerce-factories";
import { resetRuntime, staffActor } from "@/lib/testing";
import { getRevenueReport } from "./queries";
import { brusselsDate, computeRevenueReport, parsePeriod, parseReportAt, revenueCsvRows } from "./revenue";

let h: DbHandle;
const customer = () => makePerson(h.db, { isTester: false });
const at = (iso: string) => new Date(iso);

async function paid(paidAt: string, cents: number, over: { kind?: "item" | "package" | "voucher" | "night" | "membership"; channel?: "portal" | "admin" | "pos" | "site"; personId?: string } = {}) {
  const personId = over.personId ?? (await customer()).id;
  return makePaidOrder(h.db, {
    personId,
    lines: [{ productKind: over.kind ?? "item", unitAmountCents: cents }],
    order: { paidAt: at(paidAt), channel: over.channel ?? "portal" },
  });
}

async function refund(orderId: string, personId: string, cents: number, vatCents: number, on: string) {
  const user = await makeUser(h.db, { roleKey: "owner" });
  const [pay] = await h.db.insert(payments).values({ orderId, provider: "mollie", status: "paid", amountCents: cents * 2, paidAt: at(`${on}T08:00:00Z`) }).returning();
  const base = {
    orderId,
    personId,
    locale: "nl-BE" as const,
    customerSnapshot: { person_id: personId } as never,
    sellerSnapshot: {} as never,
    lines: [{}] as never,
    vatBreakdown: [] as never,
    issuedOn: on,
    fiscalYear: Number(on.slice(0, 4)),
    issuedBy: { kind: "system", id: null } as never,
  };
  const seq = Math.floor(Math.random() * 1_000_000);
  const year = on.slice(0, 4);
  const [inv] = await h.db
    .insert(invoices)
    .values({ ...base, kind: "invoice", number: `BEAM-${year}-${String(seq).padStart(6, "0")}`, sequenceNumber: seq, subtotalCents: 2 * (cents - vatCents), vatCents: 2 * vatCents, totalCents: 2 * cents, status: "paid", paidAt: at(`${on}T08:00:00Z`) })
    .returning();
  const [cn] = await h.db
    .insert(invoices)
    .values({ ...base, kind: "credit_note", number: `CN-${year}-${String(seq).padStart(6, "0")}`, sequenceNumber: seq, subtotalCents: -(cents - vatCents), vatCents: -vatCents, totalCents: -cents, status: "issued", reversesInvoiceId: inv!.id, reason: "Refund" })
    .returning();
  await h.db.insert(refunds).values({ paymentId: pay!.id, orderId, amountCents: cents, reason: "test", lines: [], creditAction: "none", status: "refunded", creditNoteId: cn!.id, createdByUserId: user.id, createdAt: at(`${on}T10:00:00Z`) });
}

beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

describe("rule 34: periods and comparisons", () => {
  it("day, ISO week, month to date (31 March against all of February) and YTD, on Brussels days", async () => {
    // 2025-03-31 is a Monday; 00:30 Brussels (CEST) on the 31st is still 30 March in UTC.
    await paid("2025-03-30T22:30:00Z", 1_000);
    await paid("2025-03-30T10:00:00Z", 2_000);
    await paid("2025-02-15T10:00:00Z", 4_000);
    await paid("2024-03-20T10:00:00Z", 8_000);
    await paid("2024-04-10T10:00:00Z", 16_000);
    const r = await computeRevenueReport(h.db, { period: "month", at: at("2025-03-31T10:00:00Z") });
    expect(r.tiles.day).toEqual({ current: 1_000, previous: 2_000, change: -1_000, changePct: -50 });
    expect(r.tiles.week).toEqual({ current: 1_000, previous: 2_000, change: -1_000, changePct: -50 });
    expect(r.tiles.month).toMatchObject({ current: 3_000, previous: 4_000, changePct: -25 });
    expect(r.tiles.ytd).toMatchObject({ current: 7_000, previous: 8_000, changePct: -12.5 });
    expect(r.net).toEqual(r.tiles.month);
    expect(r.range).toEqual({ from: "2025-03-01", to: "2025-04-01", prevFrom: "2025-02-01", prevTo: "2025-03-01" });
    expect(r.orders.current).toBe(2);
  });

  it("the percentage is blank (null) when the previous period is 0", async () => {
    await paid("2023-06-14T10:00:00Z", 2_500);
    const r = await computeRevenueReport(h.db, { period: "day", at: at("2023-06-14T12:00:00Z") });
    expect(r.net).toEqual({ current: 2_500, previous: 0, change: 2_500, changePct: null });
  });

  it("the daily line covers the 90 Brussels days up to at, zero days included", async () => {
    const r = await computeRevenueReport(h.db, { period: "day", at: at("2023-06-14T12:00:00Z") });
    expect(r.daily).toHaveLength(90);
    expect(r.daily.at(-1)).toEqual({ day: "2023-06-14", netCents: 2_500 });
    expect(r.daily[0]!.day).toBe("2023-03-17");
    expect(r.daily.filter((d) => d.netCents !== 0)).toHaveLength(1);
  });
});

describe("rule 35: net of refunds, VAT included and excluded", () => {
  it("subtracts refunds on their day; excl. VAT also takes the credit-note VAT back", async () => {
    const p = await customer();
    const { order } = await paid("2022-06-10T10:00:00Z", 12_100, { personId: p.id });
    await refund(order.id, p.id, 6_050, 1_050, "2022-06-12");
    const incl = await computeRevenueReport(h.db, { period: "month", at: at("2022-06-20T10:00:00Z") });
    expect(incl.sales.current).toBe(12_100);
    expect(incl.refunds.current).toBe(6_050);
    expect(incl.net.current).toBe(6_050);
    const excl = await computeRevenueReport(h.db, { period: "month", at: at("2022-06-20T10:00:00Z"), vat: "excl" });
    expect(excl.sales.current).toBe(10_000);
    expect(excl.refunds.current).toBe(5_000);
    expect(excl.net.current).toBe(5_000);
    const refundDay = await computeRevenueReport(h.db, { period: "day", at: at("2022-06-12T12:00:00Z") });
    expect(refundDay.net.current).toBe(-6_050);
  });
});

describe("rule 35: sales mix by product kind and channel", () => {
  it("groups the period's sales by kind and by channel; a company order counts", async () => {
    await paid("2021-08-03T10:00:00Z", 30_000, { kind: "package", channel: "portal" });
    await paid("2021-08-04T10:00:00Z", 5_000, { kind: "voucher", channel: "site" });
    await paid("2021-08-05T10:00:00Z", 1_500, { kind: "item", channel: "admin" });
    const pos = await makeOrder(h.db, { channel: "pos", status: "paid", paidAt: at("2021-08-06T10:00:00Z"), subtotalCents: 2_000, totalCents: 2_000 });
    await makeOrderLine(h.db, { orderId: pos.id, productKind: "item", unitAmountCents: 2_000 });
    const [company] = await h.db.insert(companies).values({ name: "Example BV" }).returning();
    const b2b = await makeOrder(h.db, { channel: "admin", companyId: company!.id, status: "paid", paidAt: at("2021-08-07T10:00:00Z"), subtotalCents: 10_000, totalCents: 10_000 });
    await makeOrderLine(h.db, { orderId: b2b.id, productKind: "package", unitAmountCents: 10_000 });

    const r = await computeRevenueReport(h.db, { period: "month", at: at("2021-08-20T10:00:00Z") });
    const kind = Object.fromEntries(r.byKind.map((k) => [k.kind, k.amountCents]));
    expect(kind).toMatchObject({ package: 40_000, voucher: 5_000, item: 3_500, night: 0, session: 0, membership: 0, ticket: 0 });
    expect(r.byKind.map((k) => k.kind)).toEqual(["package", "night", "session", "membership", "item", "ticket", "voucher"]);
    const channel = Object.fromEntries(r.byChannel.map((c) => [c.channel, c.amountCents]));
    expect(channel).toEqual({ portal: 30_000, site: 5_000, admin: 11_500, pos: 2_000, link: 0, recurring: 0 });
    expect(r.byChannel.find((c) => c.channel === "admin")!.orders).toBe(2);
    expect(r.net.current).toBe(48_500);
    const excl = await computeRevenueReport(h.db, { period: "month", at: at("2021-08-20T10:00:00Z"), vat: "excl" });
    expect(excl.byKind.find((k) => k.kind === "voucher")!.amountCents).toBe(5_000 - Math.round((5_000 * 21) / 121));
  });
});

describe("tester exclusion", () => {
  it("orders of tester persons are left out", async () => {
    const tester = await makePerson(h.db, { isTester: true });
    await paid("2020-05-05T10:00:00Z", 9_900, { personId: tester.id });
    await paid("2020-05-06T10:00:00Z", 100);
    const r = await computeRevenueReport(h.db, { period: "month", at: at("2020-05-20T10:00:00Z") });
    expect(r.net.current).toBe(100);
  });
});

describe("getRevenueReport and the CSV rows", () => {
  it("needs reports.read on the actor", async () => {
    const ctx = { tx: h.db, now: new Date(), locale: "en" as const };
    await expect(getRevenueReport({ ...ctx, actor: staffActor({ permissions: ["tasks.all"] }) }, { period: "day", at: new Date() })).rejects.toThrow(/forbidden/);
    const r = await getRevenueReport({ ...ctx, actor: staffActor({ permissions: ["reports.read"] }) }, { period: "month", at: at("2020-05-20T10:00:00Z") });
    expect(r.net.current).toBe(100);
  });

  it("revenueCsvRows yields one row per day, channel and kind of the period with the net per VAT filter", async () => {
    const ctx = { tx: h.db, actor: staffActor({ permissions: ["reports.read"] }), now: new Date(), locale: "en" as const };
    const rows: unknown[][] = [];
    for await (const r of revenueCsvRows(ctx, { period: "month", at: "2022-06-20", vat: "excl" })) rows.push(r);
    expect(rows).toEqual([
      ["2022-06-10", "portal", "item", 1, 12_100, 2_100, 0, 0, 10_000],
      ["2022-06-12", "portal", "refund", 0, 0, 0, 6_050, 1_050, -5_000],
    ]);
  });

  it("parses the URL filters with safe fallbacks", () => {
    const now = new Date("2026-11-04T09:00:00Z");
    expect(brusselsDate(parseReportAt("2026-03-29", now))).toBe("2026-03-29");
    expect(parseReportAt("2026-02-30", now)).toBe(now);
    expect(parseReportAt("yesterday", now)).toBe(now);
    expect(parsePeriod("ytd")).toBe("ytd");
    expect(parsePeriod("decade")).toBe("month");
  });
});
