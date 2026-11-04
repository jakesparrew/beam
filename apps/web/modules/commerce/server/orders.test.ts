/**
 * commerce-P4a `createOrder` (rules 19 to 26c, edge cases 1, 6, 10, 11, 33): client_key double
 * submit; session line rules for `bookingIds`; `bookingIds` stored in `order_lines.data.booking_ids`
 * and `lineIds` in item order; no booking call; the admin `expiresAt`; promotion reservation (and
 * exhaustion); the per-person limit; a zero total paid inline without invoice; the euro credit
 * split; a membership refused by `canStartMembership`.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson, makeProduct, makeSession, makeUser } from "@beam/db/testing";
import { ensureTermsVersion } from "@beam/db/testing/commerce-factories";
import type { DbHandle, Tx } from "@beam/db";
import { activityEvents, invoices, jobs, orderLines, orders, payments, personPrices, promotionRedemptions, promotions, vouchers } from "@beam/db/schema";

vi.mock("next/headers", () => ({ cookies: () => Promise.resolve({ get: () => undefined }), headers: () => Promise.resolve(new Headers()) }));
vi.mock("next/server", () => ({ after: () => undefined }));

const getCurrentLegalVersion = vi.fn<(...a: unknown[]) => unknown>();
vi.mock("@/modules/site/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getCurrentLegalVersion: (...a: unknown[]) => getCurrentLegalVersion(...a),
}));

const noMembership = { isMember: false, membershipId: null, planProductId: null, discountPct: 0, status: null, periodEndAt: null, cancelAt: null };
const credits = {
  getMembershipForPerson: vi.fn<(...a: unknown[]) => unknown>(),
  canStartMembership: vi.fn<(...a: unknown[]) => unknown>(),
  getEuroBalance: vi.fn<(...a: unknown[]) => unknown>(),
  consumeCredits: vi.fn<(...a: unknown[]) => unknown>(),
  grantCredits: vi.fn<(...a: unknown[]) => unknown>(),
  activateMembership: vi.fn<(...a: unknown[]) => unknown>(),
};
vi.mock("@/modules/credits/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getMembershipForPerson: (...a: unknown[]) => credits.getMembershipForPerson(...a),
  canStartMembership: (...a: unknown[]) => credits.canStartMembership(...a),
  getEuroBalance: (...a: unknown[]) => credits.getEuroBalance(...a),
  consumeCredits: (...a: unknown[]) => credits.consumeCredits(...a),
  grantCredits: (...a: unknown[]) => credits.grantCredits(...a),
  activateMembership: (...a: unknown[]) => credits.activateMembership(...a),
}));

/** Every booking api function is spied, so "no booking call" covers the whole door. */
const bookingSpies: Record<string, ReturnType<typeof vi.fn>> = {};
vi.mock("@/modules/booking/api", async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(orig)) {
    if (typeof v === "function") {
      const spy = vi.fn((...a: unknown[]) => (v as (...x: unknown[]) => unknown)(...a));
      bookingSpies[k] = spy;
      out[k] = spy;
    } else out[k] = v;
  }
  return out;
});

const { createOrder } = await import("./orders");
const { createCtx, eq, and } = await import("@/lib/ctx");
const { makeCtx, resetRuntime, createFakeIntegrations } = await import("@/lib/testing");

let h: DbHandle;
let staffUserId: string;

beforeAll(async () => {
  h = await createTestDb();
  makeCtx(h.db, { integrations: createFakeIntegrations() });
  staffUserId = (await makeUser(h.db)).id;
  const terms = await ensureTermsVersion(h.db);
  getCurrentLegalVersion.mockImplementation(() => Promise.resolve({ versionId: terms.id, version: 1 }));
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(() => {
  credits.getMembershipForPerson.mockReset().mockResolvedValue(noMembership);
  credits.canStartMembership.mockReset().mockResolvedValue({ ok: true });
  credits.getEuroBalance.mockReset().mockResolvedValue({ remainingCents: 0, grants: [] });
  credits.consumeCredits.mockReset().mockResolvedValue({ entries: [], remainingUnits: 0 });
  credits.grantCredits.mockReset().mockImplementation(() => Promise.resolve({ grantId: randomUUID(), created: true }));
  credits.activateMembership.mockReset().mockResolvedValue({ membershipId: randomUUID(), status: "active", created: true });
  for (const s of Object.values(bookingSpies)) s.mockClear();
});

function inTx<T>(fn: (tx: Tx, ctx: ReturnType<typeof createCtx>) => Promise<T>): Promise<T> {
  return h.db.transaction((tx) => fn(tx, createCtx({ tx, actor: { kind: "system", jobId: "" }, durableMode: "immediate" })));
}

const base = (personId: string, items: Parameters<typeof createOrder>[2]["items"], extra: Partial<Parameters<typeof createOrder>[2]> = {}) => ({
  personId,
  channel: "portal" as const,
  items,
  clientKey: randomUUID(),
  locale: "nl-BE" as const,
  ...extra,
});

describe("createOrder", () => {
  it("returns the existing order for a second submit with the same client_key (rule 20)", async () => {
    const person = await makePerson(h.db);
    const product = await makeProduct(h.db, { kind: "item", priceCents: 2500 });
    const input = base(person.id, [{ productId: product.id, quantity: 2 }]);
    const first = await inTx((tx, ctx) => createOrder(tx, ctx, input));
    const second = await inTx((tx, ctx) => createOrder(tx, ctx, input));
    expect(first.isExisting).toBe(false);
    expect(second).toMatchObject({ orderId: first.orderId, isExisting: true, lineIds: first.lineIds, totalCents: 5000 });
    expect(await h.db.select().from(orders).where(eq(orders.clientKey, input.clientKey))).toHaveLength(1);
  });

  it("refuses session lines with quantity 2 or without exactly one booking id outside the POS (rule 21)", async () => {
    const person = await makePerson(h.db);
    const product = await makeProduct(h.db, { kind: "session", priceCents: 4500 });
    const session = await makeSession(h.db);
    const cases = [
      [{ productId: product.id, quantity: 2, sessionId: session.id, bookingIds: [randomUUID()] }],
      [{ productId: product.id, quantity: 1, sessionId: session.id }],
      [{ productId: product.id, quantity: 1, sessionId: session.id, bookingIds: [randomUUID(), randomUUID()] }],
      [{ productId: product.id, quantity: 1, bookingIds: [randomUUID()] }],
    ];
    for (const items of cases) {
      const input = base(person.id, items);
      await expect(inTx((tx, ctx) => createOrder(tx, ctx, input))).rejects.toMatchObject({ code: "validation" });
      expect(await h.db.select().from(orders).where(eq(orders.clientKey, input.clientKey))).toHaveLength(0);
    }
    // A POS walk-in line has no booking ids yet (posSell books it afterwards).
    const pos = await inTx((tx, ctx) => createOrder(tx, ctx, { ...base(person.id, [{ productId: product.id, quantity: 1, sessionId: session.id }]), channel: "pos" }));
    expect(pos.lineIds).toHaveLength(1);
  });

  it("stores bookingIds in order_lines.data.booking_ids, returns lineIds in item order and never calls booking", async () => {
    const person = await makePerson(h.db);
    const sessionProduct = await makeProduct(h.db, { kind: "session", priceCents: 4500 });
    const item = await makeProduct(h.db, { kind: "item", priceCents: 1200 });
    const s1 = await makeSession(h.db);
    const s2 = await makeSession(h.db);
    const b1 = randomUUID();
    const b2 = randomUUID();
    const result = await inTx((tx, ctx) =>
      createOrder(
        tx,
        ctx,
        base(person.id, [
          { productId: sessionProduct.id, quantity: 1, sessionId: s1.id, bookingIds: [b1] },
          { productId: item.id, quantity: 1 },
          { productId: sessionProduct.id, quantity: 1, sessionId: s2.id, bookingIds: [b2] },
        ]),
      ),
    );
    const lines = await h.db.select().from(orderLines).where(eq(orderLines.orderId, result.orderId)).orderBy(orderLines.lineNo);
    expect(result.lineIds).toEqual(lines.map((l) => l.id));
    expect(lines.map((l) => l.data.booking_ids ?? null)).toEqual([[b1], null, [b2]]);
    expect(lines.map((l) => l.sessionId)).toEqual([s1.id, null, s2.id]);
    expect(lines[0]!.description["nl-BE"]).toMatch(/·/);
    expect(result).toMatchObject({ status: "pending_payment", totalCents: 10_200 });
    for (const [name, spy] of Object.entries(bookingSpies)) expect(spy, name).not.toHaveBeenCalled();
  });

  it("keeps an admin expiresAt and refuses it on other channels", async () => {
    const person = await makePerson(h.db);
    const product = await makeProduct(h.db, { kind: "item", priceCents: 1000 });
    const endsAt = new Date(Date.now() + 5 * 3600_000);
    const admin = await inTx((tx, ctx) => createOrder(tx, ctx, { ...base(person.id, [{ productId: product.id, quantity: 1 }]), channel: "admin", expiresAt: endsAt }));
    expect(admin.expiresAt?.getTime()).toBe(endsAt.getTime());
    const [row] = await h.db.select().from(orders).where(eq(orders.id, admin.orderId));
    expect(row!.expiresAt?.getTime()).toBe(endsAt.getTime());

    await expect(inTx((tx, ctx) => createOrder(tx, ctx, { ...base(person.id, [{ productId: product.id, quantity: 1 }]), expiresAt: endsAt }))).rejects.toMatchObject({
      code: "validation",
      fields: { expiresAt: "admin_only" },
    });
    const portal = await inTx((tx, ctx) => createOrder(tx, ctx, base(person.id, [{ productId: product.id, quantity: 1 }])));
    const minutes = (portal.expiresAt!.getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(28);
    expect(minutes).toBeLessThanOrEqual(30.1);
  });

  it("reserves the winning promotion under its lock and prices a used-up code without it (rule 19, edge case 6)", async () => {
    const product = await makeProduct(h.db, { kind: "item", priceCents: 10_000 });
    const [promo] = await h.db
      .insert(promotions)
      .values({ code: "SPRING10", name: { en: "Spring", "nl-BE": "Lente", "fr-BE": "Printemps" }, kind: "percent", value: 10, startsAt: new Date(Date.now() - 3600_000), maxUses: 1, createdByUserId: staffUserId })
      .returning();
    const p1 = await makePerson(h.db);
    const first = await inTx((tx, ctx) => createOrder(tx, ctx, { ...base(p1.id, [{ productId: product.id, quantity: 1 }]), promoCode: "spring10" }));
    expect(first.totalCents).toBe(9000);
    const [o1] = await h.db.select().from(orders).where(eq(orders.id, first.orderId));
    expect(o1!.promotionId).toBe(promo!.id);
    const redemptions = await h.db.select().from(promotionRedemptions).where(eq(promotionRedemptions.orderId, first.orderId));
    expect(redemptions).toMatchObject([{ promotionId: promo!.id, personId: p1.id, status: "reserved" }]);
    expect((await h.db.select().from(promotions).where(eq(promotions.id, promo!.id)))[0]!.usesCount).toBe(1);

    const p2 = await makePerson(h.db);
    const second = await inTx((tx, ctx) => createOrder(tx, ctx, { ...base(p2.id, [{ productId: product.id, quantity: 1 }]), promoCode: "SPRING10" }));
    expect(second.totalCents).toBe(10_000);
    expect(await h.db.select().from(promotionRedemptions).where(eq(promotionRedemptions.orderId, second.orderId))).toHaveLength(0);
    expect((await h.db.select().from(promotions).where(eq(promotions.id, promo!.id)))[0]!.usesCount).toBe(1);
  });

  it("applies max_uses_per_person through the non-released redemptions of the person (rule 17)", async () => {
    const product = await makeProduct(h.db, { kind: "item", priceCents: 4000 });
    await h.db.insert(promotions).values({
      code: "ONCEEACH",
      name: { en: "Once", "nl-BE": "Eenmalig", "fr-BE": "Unique" },
      kind: "fixed",
      value: 1000,
      startsAt: new Date(Date.now() - 3600_000),
      maxUsesPerPerson: 1,
      createdByUserId: staffUserId,
    });
    const person = await makePerson(h.db);
    const a = await inTx((tx, ctx) => createOrder(tx, ctx, { ...base(person.id, [{ productId: product.id, quantity: 1 }]), promoCode: "ONCEEACH" }));
    const b = await inTx((tx, ctx) => createOrder(tx, ctx, { ...base(person.id, [{ productId: product.id, quantity: 1 }]), promoCode: "ONCEEACH" }));
    const other = await makePerson(h.db);
    const c = await inTx((tx, ctx) => createOrder(tx, ctx, { ...base(other.id, [{ productId: product.id, quantity: 1 }]), promoCode: "ONCEEACH" }));
    expect([a.totalCents, b.totalCents, c.totalCents]).toEqual([3000, 4000, 3000]);
  });

  it("pays a zero total inline without a payment or an invoice (rule 24, edge case 10)", async () => {
    const person = await makePerson(h.db);
    const product = await makeProduct(h.db, { kind: "item", priceCents: 3500 });
    await h.db.insert(personPrices).values({ personId: person.id, productId: product.id, amountCents: 0, reason: "Ambassador", createdByUserId: staffUserId });
    const r = await inTx((tx, ctx) => createOrder(tx, ctx, base(person.id, [{ productId: product.id, quantity: 1 }])));
    expect(r).toMatchObject({ status: "paid", totalCents: 0 });
    const [row] = await h.db.select().from(orders).where(eq(orders.id, r.orderId));
    expect(row!.status).toBe("paid");
    expect(row!.paidAt).not.toBeNull();
    expect(await h.db.select().from(payments).where(eq(payments.orderId, r.orderId))).toHaveLength(0);
    expect(await h.db.select().from(invoices).where(eq(invoices.orderId, r.orderId))).toHaveLength(0);
    expect(await h.db.select().from(activityEvents).where(and(eq(activityEvents.kind, "order.paid"), eq(activityEvents.personId, person.id)))).toHaveLength(1);
    expect(await h.db.select().from(jobs).where(eq(jobs.idempotencyKey, `receipt:${r.orderId}`))).toHaveLength(1);
  });

  it("splits euro credit from the provider amount, and pays a fully covered order inline (rule 25)", async () => {
    const person = await makePerson(h.db);
    const product = await makeProduct(h.db, { kind: "item", priceCents: 4500 });
    credits.getEuroBalance.mockResolvedValue({ remainingCents: 1500, grants: [] });
    const part = await inTx((tx, ctx) => createOrder(tx, ctx, { ...base(person.id, [{ productId: product.id, quantity: 1 }]), useEuroCredit: true }));
    expect(part.status).toBe("pending_payment");
    expect(credits.consumeCredits).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      personId: person.id,
      beneficiaryPersonId: person.id,
      kind: "euro",
      units: 1500,
      ref: { type: "order", id: part.orderId },
    });
    expect(await h.db.select().from(payments).where(eq(payments.orderId, part.orderId))).toMatchObject([{ provider: "credit_balance", status: "paid", amountCents: 1500 }]);

    credits.getEuroBalance.mockResolvedValue({ remainingCents: 10_000, grants: [] });
    const full = await inTx((tx, ctx) => createOrder(tx, ctx, { ...base(person.id, [{ productId: product.id, quantity: 1 }]), useEuroCredit: true }));
    expect(full.status).toBe("paid");
    expect(await h.db.select().from(payments).where(eq(payments.orderId, full.orderId))).toMatchObject([{ provider: "credit_balance", status: "paid", amountCents: 4500 }]);
  });

  it("refuses a membership the person cannot start (rule 26c)", async () => {
    const person = await makePerson(h.db);
    const plan = await makeProduct(h.db, { kind: "membership", priceCents: 8900 });
    credits.canStartMembership.mockResolvedValue({ ok: false, reason: "already_member" });
    const input = base(person.id, [{ productId: plan.id, quantity: 1 }]);
    await expect(inTx((tx, ctx) => createOrder(tx, ctx, input))).rejects.toMatchObject({ code: "conflict", message: "already_member" });
    expect(await h.db.select().from(orders).where(eq(orders.clientKey, input.clientKey))).toHaveLength(0);
  });

  it("inserts one pending voucher per unit and refuses an order without terms (rule 26a)", async () => {
    const person = await makePerson(h.db);
    const voucher = await makeProduct(h.db, { kind: "voucher", priceCents: 5000 });
    const r = await inTx((tx, ctx) => createOrder(tx, ctx, base(person.id, [{ productId: voucher.id, quantity: 2, voucher: { recipientName: "Ann" } }])));
    const rows = await h.db.select().from(vouchers).where(eq(vouchers.orderLineId, r.lineIds[0]!));
    expect(rows).toHaveLength(2);
    expect(rows.every((v) => v.status === "pending" && v.amountCents === 5000 && v.purchaserPersonId === person.id)).toBe(true);

    getCurrentLegalVersion.mockResolvedValueOnce(null);
    await expect(inTx((tx, ctx) => createOrder(tx, ctx, base(person.id, [{ productId: voucher.id, quantity: 1 }])))).rejects.toMatchObject({ message: "terms_unavailable" });
  });
});
