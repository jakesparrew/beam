/**
 * commerce-P9 sales views (R3): `v_sales_lines` has one row per line of a paid, partially
 * refunded or refunded order, marks voucher lines deferred, nets refunds per line from
 * `refunds.lines` (sent and refunded only), lists the order's settled payment providers, carries
 * a partner code's company and has no person column; `v_lightspeed_daily` sums the till lines.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, makePerson, makeProduct, makeUser } from "@beam/db/testing";
import { makeOrder, makeOrderLine, makePaidOrder } from "@beam/db/testing/commerce-factories";
import type { DbHandle } from "@beam/db";
import { lightspeedImports, lightspeedSales, payments, promotions, refunds, SALES_LINES_COLUMNS, vLightspeedDaily, vSalesLines } from "@beam/db/schema";

vi.mock("next/headers", () => ({ cookies: () => Promise.resolve({ get: () => undefined }), headers: () => Promise.resolve(new Headers()) }));
vi.mock("next/server", () => ({ after: () => undefined }));

const { eq, inArray } = await import("@/lib/ctx");
const { makeCtx, resetRuntime } = await import("@/lib/testing");
const { storeFile } = await import("@/lib/files");
const { upsertCompany } = await import("@/modules/crm/api");

let h: DbHandle;
let userId: string;

beforeAll(async () => {
  h = await createTestDb();
  userId = (await makeUser(h.db)).id;
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

async function pay(orderId: string, provider: (typeof payments.$inferInsert)["provider"], amountCents: number, status: (typeof payments.$inferInsert)["status"] = "paid") {
  const [p] = await h.db.insert(payments).values({ orderId, provider, amountCents, status, paidAt: new Date() }).returning();
  return p!;
}

const linesOf = (orderId: string) => h.db.select().from(vSalesLines).where(eq(vSalesLines.orderId, orderId));

describe("v_sales_lines", () => {
  it("marks voucher lines deferred and keeps other lines as revenue", async () => {
    const person = await makePerson(h.db, { isTester: false });
    const voucher = await makeProduct(h.db, { kind: "voucher" });
    const item = await makeProduct(h.db, { kind: "item", itemCategory: "merchandise" });
    const { order, lines } = await makePaidOrder(h.db, {
      personId: person.id,
      lines: [
        { productId: voucher.id, productKind: "voucher", unitAmountCents: 5000, vatRatePct: "0.00", vatCents: 0 },
        { productId: item.id, productKind: "item", unitAmountCents: 2420, quantity: 2 },
      ],
      order: { paidAt: new Date("2026-11-04T22:30:00Z") },
    });
    await pay(order.id, "mollie", 9840);
    const rows = await linesOf(order.id);
    const byLine = new Map(rows.map((r) => [r.orderLineId, r]));
    expect(byLine.get(lines[0]!.id)).toMatchObject({ productKind: "voucher", isDeferred: true, lineTotalCents: 5000, vatCents: 0, netCents: 5000 });
    expect(byLine.get(lines[1]!.id)).toMatchObject({
      productKind: "item",
      productId: item.id,
      isDeferred: false,
      quantity: 2,
      lineTotalCents: 4840,
      vatCents: 840,
      netCents: 4000,
      refundedCents: 0,
      channel: "portal",
      paymentMethods: ["mollie"],
    });
    // 23:30 Brussels (CET) is still 4 November.
    expect(rows[0]!.businessDayOn).toBe("2026-11-04");
  });

  it("nets sent and refunded refunds per line and ignores pending and failed ones", async () => {
    const person = await makePerson(h.db, { isTester: false });
    const { order, lines } = await makePaidOrder(h.db, { personId: person.id, lines: [{ unitAmountCents: 3000 }, { unitAmountCents: 2000 }], order: { status: "partially_refunded", paidAt: new Date() } });
    const payment = await pay(order.id, "terminal", 5000, "partially_refunded");
    const refund = (status: (typeof refunds.$inferInsert)["status"], lineId: string, amount: number) =>
      h.db.insert(refunds).values({
        paymentId: payment.id,
        orderId: order.id,
        amountCents: amount,
        reason: "customer_request",
        lines: [{ order_line_id: lineId, quantity: 1, amount_cents: amount }],
        creditAction: "none",
        status,
        createdByUserId: userId,
      });
    await refund("refunded", lines[0]!.id, 1000);
    await refund("sent", lines[0]!.id, 500);
    await refund("pending", lines[0]!.id, 300);
    await refund("failed", lines[1]!.id, 2000);
    const byLine = new Map((await linesOf(order.id)).map((r) => [r.orderLineId, r]));
    expect(byLine.get(lines[0]!.id)!.refundedCents).toBe(1500);
    expect(byLine.get(lines[1]!.id)!.refundedCents).toBe(0);
    expect(byLine.get(lines[0]!.id)!.paymentMethods).toEqual(["terminal"]);
  });

  it("lists every settled provider once and leaves out unpaid orders", async () => {
    const person = await makePerson(h.db, { isTester: false });
    const { order } = await makePaidOrder(h.db, { personId: person.id, lines: [{ unitAmountCents: 4000 }] });
    await pay(order.id, "credit_balance", 1000);
    await pay(order.id, "cash", 3000);
    await pay(order.id, "mollie", 3000, "failed");
    expect((await linesOf(order.id))[0]!.paymentMethods).toEqual(["cash", "credit_balance"]);

    const pending = await makeOrder(h.db, { personId: person.id, status: "pending_payment" });
    await makeOrderLine(h.db, { orderId: pending.id });
    const cancelled = await makeOrder(h.db, { personId: person.id, status: "cancelled" });
    await makeOrderLine(h.db, { orderId: cancelled.id });
    const rows = await h.db.select().from(vSalesLines).where(inArray(vSalesLines.orderId, [pending.id, cancelled.id]));
    expect(rows).toEqual([]);
  });

  it("attributes a partner code's lines to the partner company", async () => {
    const person = await makePerson(h.db, { isTester: false });
    const { companyId } = await upsertCompany(h.db as never, makeCtx(h.db), { name: "Partner Spa BV", isPartner: true });
    const company = { id: companyId };
    const [promo] = await h.db
      .insert(promotions)
      .values({ code: "PARTNERSPA", name: { "nl-BE": "Partner", "fr-BE": "Partenaire", en: "Partner" }, kind: "percent", value: 10, startsAt: new Date(), partnerCompanyId: company.id, createdByUserId: userId })
      .returning();
    const { order } = await makePaidOrder(h.db, { personId: person.id, order: { promotionId: promo!.id } });
    expect((await linesOf(order.id))[0]).toMatchObject({ promotionId: promo!.id, partnerCompanyId: company.id });
  });

  it("drops tester orders and has no person column", async () => {
    const tester = await makePerson(h.db, { isTester: true });
    const { order } = await makePaidOrder(h.db, { personId: tester.id });
    expect(await linesOf(order.id)).toEqual([]);

    const cols = await h.db.execute(sql`select column_name from information_schema.columns where table_name = 'v_sales_lines' order by ordinal_position`);
    const names = (cols as { rows: { column_name: string }[] }).rows.map((r) => r.column_name);
    expect(names).toEqual([...SALES_LINES_COLUMNS]);
    expect(names.filter((n) => /person|email|name|phone/.test(n))).toEqual([]);
  });
});

describe("v_lightspeed_daily", () => {
  it("sums totals and VAT and counts receipts per business day and category", async () => {
    const { fileId } = await storeFile(makeCtx(h.db), { kind: "import", name: "x.csv", mime: "text/csv", bytes: new Uint8Array([1]) });
    const [imp] = await h.db.insert(lightspeedImports).values({ fileId, createdByUserId: userId }).returning();
    const line = (key: string, receipt: string, day: string, category: string, total: number, vat: number) => ({
      importId: imp!.id,
      externalLineKey: key,
      businessDayOn: day,
      soldAt: new Date(`${day}T12:00:00Z`),
      receiptNumber: receipt,
      productName: "P",
      category,
      quantity: "1.000",
      totalCents: total,
      vatRatePct: "21.00",
      vatCents: vat,
      paymentMethod: "Cash",
    });
    await h.db.insert(lightspeedSales).values([
      line("VD-1:1", "VD-1", "2026-09-01", "Bar", 500, 87),
      line("VD-1:2", "VD-1", "2026-09-01", "Bar", 300, 52),
      line("VD-2:1", "VD-2", "2026-09-01", "Bar", -200, -35),
      line("VD-2:2", "VD-2", "2026-09-01", "Keuken", 1200, 129),
      line("VD-3:1", "VD-3", "2026-09-02", "Bar", 400, 69),
    ]);
    const rows = await h.db.select().from(vLightspeedDaily).where(inArray(vLightspeedDaily.businessDayOn, ["2026-09-01", "2026-09-02"]));
    const sorted = rows.sort((a, b) => `${a.businessDayOn}${a.category}`.localeCompare(`${b.businessDayOn}${b.category}`));
    expect(sorted).toEqual([
      { businessDayOn: "2026-09-01", category: "Bar", totalCents: 600, vatCents: 104, receipts: 2, lines: 3 },
      { businessDayOn: "2026-09-01", category: "Keuken", totalCents: 1200, vatCents: 129, receipts: 1, lines: 1 },
      { businessDayOn: "2026-09-02", category: "Bar", totalCents: 400, vatCents: 69, receipts: 1, lines: 1 },
    ]);
  });

  it("is append-only: a stored till line cannot be changed", async () => {
    await expect(h.db.update(lightspeedSales).set({ totalCents: 1 }).where(eq(lightspeedSales.externalLineKey, "VD-1:1"))).rejects.toThrow();
  });
});
