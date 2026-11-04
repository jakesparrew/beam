/**
 * commerce-P4b privacy registration (section 9, ops rule 62): the export holds orders (with
 * lines and refunds), payments, vouchers, checkouts, mandates and person prices; erase leaves no
 * person reference in commerce's tables (orders are retained without person, payments keep a
 * reduced `raw`, mandates are anonymised and revoked, the rest is deleted or unlinked), cancels
 * open orders first and queues the provider-customer deletion; erasure is refused while an order
 * has a live provider payment; the retention seeds and sweeps follow the policy keys.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson, makeProduct, makeUser } from "@beam/db/testing";
import { makeOrder, makeOrderLine, makePaidOrder } from "@beam/db/testing/commerce-factories";
import type { DbHandle } from "@beam/db";
import { checkouts, jobs, mandates, orders, payments, personPrices, promotionRedemptions, promotions, providerCustomers, refunds, vouchers } from "@beam/db/schema";
import { isValidRetentionSeed } from "@beam/core/privacy";

vi.mock("next/headers", () => ({ cookies: () => Promise.resolve({ get: () => undefined }), headers: () => Promise.resolve(new Headers()) }));
vi.mock("next/server", () => ({ after: () => undefined }));

const { privacy, retention, sweep, noPiiTables } = await import("./privacy");
const { eq, and, sql } = await import("@/lib/ctx");
const { makeCtx, resetRuntime, createFakeIntegrations } = await import("@/lib/testing");
const { rowsOf } = await import("@/lib/sensitive");

let h: DbHandle;
let staffUserId: string;

beforeAll(async () => {
  h = await createTestDb();
  makeCtx(h.db, { integrations: createFakeIntegrations() });
  staffUserId = (await makeUser(h.db)).id;
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

/** A person with one of every commerce row that can name them. */
async function customerWithHistory() {
  const person = await makePerson(h.db);
  const { order, lines } = await makePaidOrder(h.db, { personId: person.id, order: { note: "Prefers the morning slot" } });
  const [paid] = await h.db
    .insert(payments)
    .values({ orderId: order.id, provider: "mollie", providerPaymentId: `tr_pv${randomUUID().slice(0, 8)}`, method: "bancontact", status: "paid", amountCents: 4500, paidAt: new Date(), raw: { consumerName: "Test Person", consumerAccount: "BE00000000000000" } })
    .returning();
  await h.db.insert(refunds).values({ paymentId: paid!.id, orderId: order.id, amountCents: 1000, reason: "goodwill", lines: [{ order_line_id: lines[0]!.id, quantity: 1, amount_cents: 1000 }], creditAction: "none", status: "refunded", createdByUserId: staffUserId });

  const voucherProduct = await makeProduct(h.db, { kind: "voucher" });
  const vLine = await makeOrderLine(h.db, { orderId: order.id, productId: voucherProduct.id, unitAmountCents: 2500, vatRatePct: "0.00" });
  const [bought] = await h.db
    .insert(vouchers)
    .values({ orderLineId: vLine.id, amountCents: 2500, purchaserPersonId: person.id, recipientName: "Friend", recipientEmail: "friend@example.com", message: "Enjoy", status: "active", codeLast4: "AB12" })
    .returning();
  const otherOrder = await makeOrder(h.db, { status: "paid" });
  const otherLine = await makeOrderLine(h.db, { orderId: otherOrder.id, productId: voucherProduct.id, unitAmountCents: 3000, vatRatePct: "0.00" });
  const [redeemed] = await h.db
    .insert(vouchers)
    .values({ orderLineId: otherLine.id, amountCents: 3000, redeemedByPersonId: person.id, redeemedAt: new Date(), status: "redeemed", codeLast4: "CD34" })
    .returning();

  const [checkout] = await h.db.insert(checkouts).values({ personId: person.id, email: "buyer@example.com", channel: "portal", items: [{ productId: lines[0]!.productId, quantity: 1 }], status: "completed", orderId: order.id }).returning();
  await h.db.update(orders).set({ checkoutId: checkout!.id }).where(eq(orders.id, order.id));

  const customerId = `cst_${randomUUID().slice(0, 8)}`;
  await h.db.insert(providerCustomers).values({ personId: person.id, provider: "mollie", providerCustomerId: customerId });
  const [mandate] = await h.db
    .insert(mandates)
    .values({ personId: person.id, provider: "mollie", providerMandateId: `mdt_${randomUUID().slice(0, 8)}`, providerCustomerId: customerId, method: "creditcard", detailsSummary: "Visa ending 4242", status: "revoked", revokedAt: new Date() })
    .returning();
  const product = await makeProduct(h.db, { kind: "package" });
  await h.db.insert(personPrices).values({ personId: person.id, productId: product.id, amountCents: 1000, reason: "Ambassador", createdByUserId: staffUserId });
  const [promo] = await h.db
    .insert(promotions)
    .values({ code: `PRV${randomUUID().slice(0, 6).toUpperCase()}`, name: { en: "P", "nl-BE": "P", "fr-BE": "P" }, kind: "percent", value: 10, startsAt: new Date("2026-01-01"), usesCount: 1, createdByUserId: staffUserId })
    .returning();
  await h.db.insert(promotionRedemptions).values({ promotionId: promo!.id, orderId: order.id, personId: person.id, status: "confirmed" });
  return { person, order, paid: paid!, bought: bought!, redeemed: redeemed!, checkout: checkout!, mandate: mandate!, customerId };
}

/** Every commerce column that references `persons.id`, with the rows still naming `personId`. */
async function remainingReferences(personId: string): Promise<string[]> {
  const cols = rowsOf<{ table: string; column: string }>(
    await h.db.execute(sql`
      select distinct kcu.table_name as table, kcu.column_name as column
      from information_schema.table_constraints tc
      join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name and kcu.constraint_schema = tc.constraint_schema
      join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name and ccu.constraint_schema = tc.constraint_schema
      where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = 'public' and ccu.table_name = 'persons'`),
  ).filter((c) => privacy.tables.includes(c.table));
  const left: string[] = [];
  for (const c of cols) {
    const n = rowsOf<{ n: number }>(await h.db.execute(sql`select count(*)::int as n from ${sql.identifier(c.table)} where ${sql.identifier(c.column)} = ${personId}::uuid`))[0]!.n;
    if (n > 0) left.push(`${c.table}.${c.column}`);
  }
  return left;
}

describe("commerce privacy registration", () => {
  it("registers the person tables, the retention seeds and a sweep per key", () => {
    for (const t of ["orders", "payments", "mandates", "provider_customers", "checkouts", "person_prices", "promotion_redemptions", "vouchers"]) expect(privacy.tables).toContain(t);
    expect(noPiiTables).toContain("pos_day_closes");
    for (const seed of retention) {
      expect(isValidRetentionSeed(seed)).toBe(true);
      expect(sweep[seed.key]).toBeTypeOf("function");
    }
    expect(retention.map((r) => [r.key, r.days, r.action])).toEqual([
      ["commerce.checkouts", 395, "delete"],
      ["commerce.payments_raw", 90, "anonymise"],
      ["commerce.orders", 3653, "anonymise"],
      ["commerce.person_prices", 730, "delete"],
    ]);
  });

  it("exports orders with lines and refunds, payments as CSV, vouchers, checkouts, mandates and person prices", async () => {
    const { person, order } = await customerWithHistory();
    const out = await h.db.transaction((tx) => privacy.export(tx, person.id));
    expect(Object.keys(out).sort()).toEqual([
      "commerce/checkouts.json",
      "commerce/mandates.json",
      "commerce/orders.json",
      "commerce/payments.csv",
      "commerce/person_prices.json",
      "commerce/vouchers.json",
    ]);
    const exported = out["commerce/orders.json"] as Array<Record<string, unknown> & { lines: unknown[]; refunds: unknown[] }>;
    expect(exported).toHaveLength(1);
    expect(exported[0]).toMatchObject({ reference: order.reference, status: "paid", total_cents: 4500, note: "Prefers the morning slot" });
    expect(exported[0]!.lines).toHaveLength(2);
    expect(exported[0]!.refunds).toEqual([expect.objectContaining({ amount_cents: 1000, reason: "goodwill", status: "refunded" })]);
    const csv = out["commerce/payments.csv"] as string;
    expect(csv.split("\n")[0]).toBe("order_reference,provider,method,amount_cents,refunded_cents,status,created_at,paid_at");
    expect(csv).toContain(`${order.reference},mollie,bancontact,4500,0,paid`);
    expect(csv).not.toContain("BE00000000000000");
    expect(out["commerce/vouchers.json"]).toMatchObject({
      bought: [{ amount_cents: 2500, recipient_name: "Friend", recipient_email: "friend@example.com", message: "Enjoy", status: "active" }],
      redeemed: [{ amount_cents: 3000, code_last4: "CD34" }],
    });
    expect(out["commerce/checkouts.json"]).toEqual([expect.objectContaining({ channel: "portal", status: "completed", email: "buyer@example.com" })]);
    expect(out["commerce/mandates.json"]).toEqual([expect.objectContaining({ method: "creditcard", summary: "Visa ending 4242", status: "revoked" })]);
    expect(out["commerce/person_prices.json"]).toEqual([expect.objectContaining({ amount_cents: 1000, reason: "Ambassador" })]);
  });

  it("erases every person reference, keeps the legal rows and queues the provider customer deletion", async () => {
    const { person, order, paid, bought, redeemed, mandate, customerId } = await customerWithHistory();
    const draft = await makeOrder(h.db, { personId: person.id, status: "draft", expiresAt: null });
    const transferOrder = await makeOrder(h.db, { personId: person.id, channel: "admin", expiresAt: null });
    await makeOrderLine(h.db, { orderId: transferOrder.id });
    await h.db.insert(payments).values({ orderId: transferOrder.id, provider: "bank_transfer", status: "open", amountCents: 4500 });

    const report = await h.db.transaction((tx) => privacy.erase(tx, person.id));
    expect(await remainingReferences(person.id)).toEqual([]);
    expect(report).toEqual(expect.arrayContaining([{ table: "orders", rows: 3, action: "retained_legal" }, { table: "checkouts", rows: 1, action: "deleted" }]));

    const [o] = await h.db.select().from(orders).where(eq(orders.id, order.id));
    expect(o).toMatchObject({ personId: null, isErasedSubject: true, note: null, status: "paid", totalCents: 4500, checkoutId: null });
    expect((await h.db.select().from(orders).where(eq(orders.id, draft.id)))[0]!.status).toBe("cancelled");
    expect((await h.db.select().from(orders).where(eq(orders.id, transferOrder.id)))[0]!.status).toBe("cancelled");
    expect((await h.db.select().from(payments).where(eq(payments.id, paid.id)))[0]!.raw).toEqual({ id: paid.id, status: "paid", method: "bancontact", amount: 4500 });
    expect((await h.db.select().from(mandates).where(eq(mandates.id, mandate.id)))[0]).toMatchObject({ personId: null, detailsSummary: null, status: "revoked" });
    expect(await h.db.select().from(providerCustomers).where(eq(providerCustomers.providerCustomerId, customerId))).toHaveLength(0);
    expect((await h.db.select().from(vouchers).where(eq(vouchers.id, bought.id)))[0]).toMatchObject({ purchaserPersonId: null, recipientName: null, recipientEmail: null, message: null, status: "active", amountCents: 2500 });
    expect((await h.db.select().from(vouchers).where(eq(vouchers.id, redeemed.id)))[0]).toMatchObject({ redeemedByPersonId: null, status: "redeemed" });
    expect(await h.db.select().from(refunds).where(eq(refunds.orderId, order.id))).toHaveLength(1);

    const queued = await h.db.select().from(jobs).where(and(eq(jobs.kind, "commerce.erase_provider_customer"), eq(jobs.idempotencyKey, `mollie_customer:${customerId}:delete`)));
    expect(queued).toHaveLength(1);
    expect(queued[0]!.payload).toEqual({ providerCustomerId: customerId, mandateIds: [mandate.providerMandateId] });

    // A second erase finds nothing left.
    const again = await h.db.transaction((tx) => privacy.erase(tx, person.id));
    expect(again.every((r) => r.rows === 0)).toBe(true);
  });

  it("refuses erasure while an order has a live provider payment", async () => {
    const person = await makePerson(h.db);
    const order = await makeOrder(h.db, { personId: person.id, channel: "portal" });
    await h.db.insert(payments).values({ orderId: order.id, provider: "mollie", providerPaymentId: `tr_live${randomUUID().slice(0, 8)}`, status: "open", amountCents: 4500 });
    await expect(h.db.transaction((tx) => privacy.erase(tx, person.id))).rejects.toThrow(/live_payment/);
    expect((await h.db.select().from(orders).where(eq(orders.id, order.id)))[0]!.personId).toBe(person.id);
  });

  it("sweeps old checkouts and reduces old provider payloads", async () => {
    const old = new Date("2025-01-01T00:00:00Z");
    const [c] = await h.db.insert(checkouts).values({ email: "old@example.com", channel: "site", items: [], createdAt: old }).returning();
    const order = await makeOrder(h.db, { checkoutId: c!.id });
    const [p] = await h.db.insert(payments).values({ orderId: order.id, provider: "mollie", status: "paid", method: "creditcard", amountCents: 4500, raw: { cardHolder: "Old Holder" }, createdAt: old }).returning();
    const cutoff = new Date("2025-06-01T00:00:00Z");
    expect(await h.db.transaction((tx) => sweep["commerce.checkouts"]!(tx, cutoff))).toBeGreaterThanOrEqual(1);
    expect(await h.db.select().from(checkouts).where(eq(checkouts.id, c!.id))).toHaveLength(0);
    expect((await h.db.select().from(orders).where(eq(orders.id, order.id)))[0]!.checkoutId).toBeNull();
    expect(await h.db.transaction((tx) => sweep["commerce.payments_raw"]!(tx, cutoff))).toBeGreaterThanOrEqual(1);
    expect((await h.db.select().from(payments).where(eq(payments.id, p!.id)))[0]!.raw).toEqual({ id: p!.id, status: "paid", method: "creditcard", amount: 4500 });
    expect(await h.db.transaction((tx) => sweep["commerce.payments_raw"]!(tx, cutoff))).toBe(0);
  });
});
