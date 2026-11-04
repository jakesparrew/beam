import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "../client";
import { applyCustomSql, createTestDb, makePerson, makeProduct, makeSession, makeUser } from "../testing";
import {
  checkouts,
  ORDERS_PENDING_CHECKS,
  orderLines,
  orders,
  payments,
  posDayCloses,
  priceVersions,
  products,
  promotions,
  refunds,
  vouchers,
} from "./commerce";
import { vOrderBalances, vPaymentAttention, vProductCurrentPrices } from "./commerce.views";

/** The Postgres error behind a failed query (message and SQLSTATE). */
async function pgError(promise: Promise<unknown>): Promise<{ message: string; code?: string }> {
  try {
    await promise;
  } catch (error) {
    const cause = (error as { cause?: { message?: string; code?: string } }).cause ?? (error as { message?: string; code?: string });
    return { message: String(cause.message ?? error), code: cause.code };
  }
  throw new Error("expected the query to fail");
}

const name = { "nl-BE": "Naam", "fr-BE": "Nom", en: "Name" };
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);

let h: DbHandle;
let personId: string;
let userId: string;
beforeAll(async () => {
  h = await createTestDb();
  await applyCustomSql(h);
  personId = (await makePerson(h.db)).id;
  userId = (await makeUser(h.db)).id;
});
afterAll(() => h.close());

type OrderInsert = typeof orders.$inferInsert;
async function makeOrder(over: Partial<OrderInsert> = {}, db = h.db) {
  const [row] = await db
    .insert(orders)
    .values({
      personId: db === h.db ? personId : null,
      channel: "admin",
      subtotalCents: 4_500,
      vatCents: 781,
      totalCents: 4_500,
      locale: "nl-BE",
      clientKey: randomUUID(),
      ...over,
    })
    .returning();
  return row!;
}

type LineInsert = typeof orderLines.$inferInsert;
async function lineValues(orderId: string, over: Partial<LineInsert> = {}): Promise<LineInsert> {
  const product = over.productId ? { id: over.productId } : await makeProduct(h.db, { kind: "item" });
  return {
    orderId,
    lineNo: 1,
    productId: product.id,
    productKind: "item",
    sku: "ITEM-1",
    description: name,
    quantity: 1,
    unitAmountCents: 4_500,
    lineTotalCents: 4_500,
    vatRatePct: "21.00",
    vatCents: 781,
    pricingTrace: {},
    ...over,
  };
}

async function makePayment(orderId: string, over: Partial<typeof payments.$inferInsert> = {}) {
  const [row] = await h.db.insert(payments).values({ orderId, provider: "mollie", amountCents: 4_500, ...over }).returning();
  return row!;
}

describe("products checks", () => {
  const base = { sku: "CHK-001", name, vatRatePct: "21.00" } as const;
  it.each([
    ["products_package_chk", { kind: "package", creditKind: "euro", creditUnits: 5, validityDays: 30 }],
    ["products_package_chk", { kind: "package", creditKind: "day", creditUnits: 5 }],
    ["products_voucher_chk", { kind: "voucher", creditKind: "euro", vatRatePct: "21.00", validityDays: 730 }],
    ["products_voucher_chk", { kind: "voucher", creditKind: "euro", vatRatePct: "0.00", validityDays: 365 }],
    ["products_membership_chk", { kind: "membership" }],
    ["products_membership_chk", { kind: "session", recurringInterval: "month" }],
    ["products_membership_chk", { kind: "membership", recurringInterval: "month", includedCreditKind: "day" }],
    ["products_no_credit_chk", { kind: "item", creditKind: "day" }],
    ["products_custom_amount_chk", { kind: "item", isCustomAmount: true, minAmountCents: 500, maxAmountCents: 1000 }],
    [
      "products_custom_amount_chk",
      { kind: "voucher", creditKind: "euro", vatRatePct: "0.00", validityDays: 730, isCustomAmount: true, minAmountCents: 100, maxAmountCents: 1000 },
    ],
    [
      "products_custom_amount_chk",
      { kind: "voucher", creditKind: "euro", vatRatePct: "0.00", validityDays: 730, isCustomAmount: true, minAmountCents: 2500, maxAmountCents: 200000 },
    ],
    ["products_sku_chk", { kind: "item", sku: "lower-case" }],
    ["products_vat_rate_chk", { kind: "item", vatRatePct: "7.00" }],
  ] as const)("%s rejects %j", async (constraint, values) => {
    const err = await pgError(h.db.insert(products).values({ ...base, ...values } as typeof products.$inferInsert));
    expect(err.message).toContain(constraint);
  });

  it("accepts a valid custom-amount voucher and an item with a category", async () => {
    await h.db.insert(products).values([
      { kind: "voucher", sku: "GIFT-CUSTOM", name, vatRatePct: "0.00", creditKind: "euro", validityDays: 730, isCustomAmount: true, minAmountCents: 2_500, maxAmountCents: 50_000 },
      { kind: "item", sku: "MERCH-TOWEL", name, vatRatePct: "21.00", itemCategory: "merchandise" },
    ]);
  });
});

describe("price_versions", () => {
  it("rejects an empty window and a duplicate version", async () => {
    const p = await makeProduct(h.db, { priceCents: 4_500 });
    const now = new Date();
    const err = await pgError(h.db.insert(priceVersions).values({ productId: p.id, version: 2, audience: "public", amountCents: 1, validFromAt: now, validToAt: now }));
    expect(err.message).toContain("price_versions_window_chk");
    const dup = await pgError(h.db.insert(priceVersions).values({ productId: p.id, version: 1, audience: "public", amountCents: 1 }));
    expect(dup.message).toContain("price_versions_product_audience_version_uq");
  });

  it("rejects update and delete (append-only)", async () => {
    const p = await makeProduct(h.db, { priceCents: 4_500 });
    expect((await pgError(h.db.execute(sql`update price_versions set amount_cents = 1 where product_id = ${p.id}`))).code).toBe("55000");
    expect((await pgError(h.db.execute(sql`delete from price_versions where product_id = ${p.id}`))).code).toBe("55000");
  });
});

describe("promotions", () => {
  const promo = (over: Partial<typeof promotions.$inferInsert> = {}) =>
    h.db.insert(promotions).values({ name, kind: "percent", value: 10, startsAt: new Date(), createdByUserId: userId, ...over });

  it("allows many automatic promotions but a code only once (promotions_code_uq)", async () => {
    await promo();
    await promo();
    await promo({ code: "SPRING10" });
    expect((await pgError(promo({ code: "SPRING10" }))).message).toContain("promotions_code_uq");
  });

  it("checks code format and value per kind", async () => {
    expect((await pgError(promo({ code: "spring" }))).message).toContain("promotions_code_chk");
    expect((await pgError(promo({ value: 101 }))).message).toContain("promotions_value_chk");
    expect((await pgError(promo({ kind: "fixed", value: 0 }))).message).toContain("promotions_value_chk");
    expect((await pgError(promo({ startsAt: new Date(), endsAt: ago(60) }))).message).toContain("promotions_window_chk");
  });
});

describe("orders checks", () => {
  it("generates a BO- reference when none is given", async () => {
    const o = await makeOrder();
    expect(o.reference).toMatch(/^BO-[0-9A-F]{8}$/);
  });

  it("orders_total_chk", async () => {
    expect((await pgError(makeOrder({ discountCents: 500 }))).message).toContain("orders_total_chk");
  });

  it("orders_renewal_chk: membership and period end together", async () => {
    expect((await pgError(makeOrder({ channel: "recurring", renewalMembershipId: randomUUID() }))).message).toContain("orders_renewal_chk");
  });

  it("orders_renewal_uq refuses a second live renewal order for one period", async () => {
    const membershipId = randomUUID();
    const renewal = { channel: "recurring" as const, renewalMembershipId: membershipId, renewalPeriodEndOn: "2026-12-01" };
    const first = await makeOrder(renewal);
    expect((await pgError(makeOrder(renewal))).message).toContain("orders_renewal_uq");
    // a cancelled renewal order frees the period; the next period is independent
    await h.db.execute(sql`update orders set status = 'cancelled' where id = ${first.id}`);
    await makeOrder(renewal);
    await makeOrder({ ...renewal, renewalPeriodEndOn: "2027-01-01" });
  });

  it("client_key and reference are unique", async () => {
    const o = await makeOrder();
    expect((await pgError(makeOrder({ clientKey: o.clientKey }))).message).toContain("orders_client_key_unique");
    expect((await pgError(makeOrder({ reference: o.reference }))).message).toContain("orders_reference_unique");
  });
});

describe("ORDERS_PENDING_CHECKS (orders_person_chk, orders_terms_chk)", () => {
  let h2: DbHandle;
  let person2: string;
  beforeAll(async () => {
    h2 = await createTestDb();
    for (const [constraint, check] of Object.entries(ORDERS_PENDING_CHECKS)) {
      await h2.db.execute(sql.raw(`alter table orders add constraint ${constraint} check (${check})`));
    }
    person2 = (await makePerson(h2.db)).id;
  });
  afterAll(() => h2.close());

  it("orders_person_chk: a person, a company, a POS sale or an erased subject", async () => {
    expect((await pgError(makeOrder({}, h2.db))).message).toContain("orders_person_chk");
    await makeOrder({ personId: person2 }, h2.db);
    await makeOrder({ channel: "pos" }, h2.db);
    await makeOrder({ companyId: randomUUID() }, h2.db);
    await makeOrder({ isErasedSubject: true }, h2.db);
  });

  it("orders_terms_chk: portal, site and link orders need a terms version unless draft", async () => {
    for (const channel of ["portal", "site", "link"] as const) {
      expect((await pgError(makeOrder({ channel, personId: person2 }, h2.db))).message).toContain("orders_terms_chk");
      await makeOrder({ channel, personId: person2, status: "draft" }, h2.db);
      await makeOrder({ channel, personId: person2, termsVersionId: randomUUID() }, h2.db);
    }
    await makeOrder({ channel: "pos" }, h2.db);
  });
});

describe("order_lines", () => {
  it("order_lines_total_chk", async () => {
    const o = await makeOrder();
    const err = await pgError(h.db.insert(orderLines).values(await lineValues(o.id, { lineTotalCents: 4_000 })));
    expect(err.message).toContain("order_lines_total_chk");
  });

  it("order_lines_session_chk refuses a session line with quantity 2, without session or with two booking ids", async () => {
    const o = await makeOrder();
    const session = await makeSession(h.db);
    const product = await makeProduct(h.db, { kind: "session" });
    const sessionLine = { productId: product.id, productKind: "session" as const, sessionId: session.id };
    const qty2 = await pgError(
      h.db.insert(orderLines).values(await lineValues(o.id, { ...sessionLine, quantity: 2, unitAmountCents: 2_250 })),
    );
    expect(qty2.message).toContain("order_lines_session_chk");
    const noSession = await pgError(h.db.insert(orderLines).values(await lineValues(o.id, { ...sessionLine, sessionId: null })));
    expect(noSession.message).toContain("order_lines_session_chk");
    const twoBookings = await pgError(
      h.db.insert(orderLines).values(await lineValues(o.id, { ...sessionLine, data: { booking_ids: [randomUUID(), randomUUID()] } })),
    );
    expect(twoBookings.message).toContain("order_lines_session_chk");
    await h.db.insert(orderLines).values(await lineValues(o.id, { ...sessionLine, data: { booking_ids: [randomUUID()] } }));
    await h.db.insert(orderLines).values(await lineValues(o.id, { ...sessionLine, lineNo: 2 }));
  });

  it("line numbers are unique per order", async () => {
    const o = await makeOrder();
    await h.db.insert(orderLines).values(await lineValues(o.id));
    expect((await pgError(h.db.insert(orderLines).values(await lineValues(o.id)))).message).toContain("order_lines_order_line_no_uq");
  });

  it("rejects update and delete (append-only)", async () => {
    const o = await makeOrder();
    const [line] = await h.db.insert(orderLines).values(await lineValues(o.id)).returning();
    expect((await pgError(h.db.execute(sql`update order_lines set quantity = 2 where id = ${line!.id}`))).code).toBe("55000");
    expect((await pgError(h.db.execute(sql`delete from order_lines where id = ${line!.id}`))).code).toBe("55000");
  });
});

describe("payments, refunds, vouchers, checkouts, POS day", () => {
  it("payments checks", async () => {
    const o = await makeOrder();
    expect((await pgError(makePayment(o.id, { amountCents: 0 }))).message).toContain("payments_amount_chk");
    expect((await pgError(makePayment(o.id, { refundedCents: 5_000 }))).message).toContain("payments_refunded_chk");
  });

  it("refunds and vouchers amounts", async () => {
    const o = await makeOrder();
    const p = await makePayment(o.id);
    const err = await pgError(
      h.db.insert(refunds).values({ paymentId: p.id, orderId: o.id, amountCents: 0, reason: "test", lines: [], creditAction: "none", createdByUserId: userId }),
    );
    expect(err.message).toContain("refunds_amount_chk");
    const [line] = await h.db.insert(orderLines).values(await lineValues(o.id)).returning();
    expect((await pgError(h.db.insert(vouchers).values({ orderLineId: line!.id, amountCents: 100 }))).message).toContain("vouchers_amount_chk");
    expect((await pgError(h.db.insert(vouchers).values({ orderLineId: line!.id, amountCents: 5_000, message: "x".repeat(501) }))).message).toContain(
      "vouchers_message_chk",
    );
  });

  it("checkouts_contact_chk and locale", async () => {
    await h.db.insert(checkouts).values({ channel: "site", items: [] });
    expect((await pgError(h.db.insert(checkouts).values({ channel: "site", items: [], status: "abandoned" }))).message).toContain("checkouts_contact_chk");
    expect((await pgError(h.db.insert(checkouts).values({ channel: "site", items: [], locale: "de" }))).message).toContain("checkouts_locale_chk");
    const [c] = await h.db.insert(checkouts).values({ channel: "portal", items: [], personId }).returning();
    expect(c!.expiresAt.getTime() - c!.createdAt.getTime()).toBeGreaterThan(29 * 86_400_000);
  });

  it("pos_day_closes needs a note for a difference and a count to close", async () => {
    expect((await pgError(h.db.insert(posDayCloses).values({ businessDayOn: "2026-11-01", differenceCents: -500 }))).message).toContain(
      "pos_day_closes_note_chk",
    );
    expect((await pgError(h.db.insert(posDayCloses).values({ businessDayOn: "2026-11-02", status: "closed" }))).message).toContain(
      "pos_day_closes_closed_chk",
    );
    await h.db.insert(posDayCloses).values({ businessDayOn: "2026-11-03", status: "closed", countedCashCents: 15_000, differenceCents: 0, closedAt: new Date() });
    expect((await pgError(h.db.insert(posDayCloses).values({ businessDayOn: "2026-11-03" }))).message).toContain("pos_day_closes_business_day_on_unique");
  });
});

describe("views", () => {
  it("v_product_current_prices picks the highest valid version per audience", async () => {
    const p = await makeProduct(h.db, { priceCents: 4_500 });
    await h.db.insert(priceVersions).values([
      { productId: p.id, version: 2, audience: "public", amountCents: 3_900, validFromAt: ago(60), validToAt: new Date(Date.now() + 86_400_000) },
      { productId: p.id, version: 3, audience: "public", amountCents: 3_000, validFromAt: new Date(Date.now() + 86_400_000) },
      { productId: p.id, version: 4, audience: "public", amountCents: 2_000, validFromAt: ago(120), validToAt: ago(60) },
      { productId: p.id, version: 1, audience: "member", amountCents: 4_000 },
    ]);
    const rows = await h.db.select().from(vProductCurrentPrices).where(sql`product_id = ${p.id}`).orderBy(vProductCurrentPrices.audience);
    expect(rows.map((r) => [r.audience, r.version, r.amountCents])).toEqual([
      ["public", 2, 3_900],
      ["member", 1, 4_000],
    ]);
  });

  it("v_order_balances sums paid and refunded payments", async () => {
    const o = await makeOrder({ subtotalCents: 10_000, vatCents: 1_736, totalCents: 10_000 });
    await makePayment(o.id, { amountCents: 6_000, status: "paid", refundedCents: 1_000 });
    await makePayment(o.id, { amountCents: 4_000, status: "cancelled" });
    const [row] = await h.db.select().from(vOrderBalances).where(sql`order_id = ${o.id}`);
    expect(row).toEqual({ orderId: o.id, totalCents: 10_000, paidCents: 6_000, refundedCents: 1_000, dueCents: 4_000 });
    const empty = await makeOrder();
    const [none] = await h.db.select().from(vOrderBalances).where(sql`order_id = ${empty.id}`);
    expect(none).toMatchObject({ paidCents: 0, refundedCents: 0, dueCents: 4_500 });
  });

  it("v_payment_attention returns each kind", async () => {
    const failedOrder = await makeOrder();
    const failed = await makePayment(failedOrder.id, { status: "failed", updatedAt: ago(60) });
    await makePayment((await makeOrder({ status: "paid" })).id, { status: "failed" }); // paid later: not shown
    await makePayment((await makeOrder()).id, { status: "failed", updatedAt: ago(8 * 24 * 60) }); // older than 7 days
    const pending = await makePayment((await makeOrder()).id, { status: "pending", createdAt: ago(20) });
    await makePayment((await makeOrder()).id, { status: "open", createdAt: ago(5) }); // too young
    const transfer = await makePayment((await makeOrder()).id, { provider: "bank_transfer", status: "open", createdAt: ago(60), expiresAt: ago(10) });
    await makePayment((await makeOrder()).id, { provider: "bank_transfer", status: "open", expiresAt: new Date(Date.now() + 86_400_000) });
    const refundOrder = await makeOrder({ status: "paid" });
    const refundPayment = await makePayment(refundOrder.id, { status: "paid" });
    await h.db.insert(refunds).values({
      paymentId: refundPayment.id,
      orderId: refundOrder.id,
      amountCents: 1_000,
      reason: "test",
      lines: [],
      creditAction: "none",
      status: "failed",
      createdByUserId: userId,
    });
    const charged = await makePayment((await makeOrder({ status: "paid" })).id, { status: "paid", chargebackCents: 4_500 });

    const rows = await h.db.select().from(vPaymentAttention);
    const ids = (kind: string) => rows.filter((r) => r.kind === kind).map((r) => r.paymentId);
    expect(ids("payment_failed")).toEqual([failed.id]);
    expect(ids("payment_pending_15m")).toEqual([pending.id]);
    expect(ids("bank_transfer_overdue")).toEqual([transfer.id]);
    expect(ids("refund_failed")).toEqual([refundPayment.id]);
    expect(ids("chargeback")).toEqual([charged.id]);
    expect(rows.find((r) => r.kind === "chargeback")).toMatchObject({ amountCents: 4_500, personId });
  });
});
