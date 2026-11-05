/**
 * commerce-P5 checkouts (rules 16, 26a to 26c, 48 to 50, edge cases 23 and 30): re-quote and the
 * price-changed flag; abandoned after 60 minutes with each reason; the event only with a person;
 * `started -> completed` and `abandoned -> completed` with `checkout.completed`; expired after 30
 * days from both states; a guest gets the public price even with a member's email; the terms
 * version is stored and the acceptance recorded; `terms_unavailable` without a published version;
 * `landingPath` from `from`; `?product=<id>` resolution; billing details passed to finance;
 * `payOrder` refuses an expired order.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson, makeProduct, makeUser } from "@beam/db/testing";
import { ensureTermsVersion, makeOrder, makeOrderLine } from "@beam/db/testing/commerce-factories";
import type { DbHandle, Tx } from "@beam/db";
import { activityEvents, checkouts, jobs, orders, payments, promotions, termsAcceptances } from "@beam/db/schema";
import type * as Catalogue from "./catalogue";

vi.mock("next/headers", () => ({ cookies: () => Promise.resolve({ get: () => undefined, set: () => undefined }), headers: () => Promise.resolve(new Headers()) }));
vi.mock("next/server", () => ({ after: () => undefined }));

const site = { getCurrentLegalVersion: vi.fn<(...a: unknown[]) => unknown>() };
vi.mock("@/modules/site/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getCurrentLegalVersion: (...a: unknown[]) => site.getCurrentLegalVersion(...a),
  // OD-15: an email send inside a PGlite transaction must not read the legal links.
  getLegalLinks: () => Promise.resolve({ privacy: null, terms: null, cookies: null, accessibility: null }),
}));

const finance = { setOrderBillingDetails: vi.fn<(...a: unknown[]) => unknown>() };
vi.mock("@/modules/finance/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  setOrderBillingDetails: (...a: unknown[]) => finance.setOrderBillingDetails(...a),
  issueInvoice: () => Promise.resolve({ status: "issued", invoiceId: randomUUID(), number: "2026-000001" }),
}));

const noMembership = { isMember: false, membershipId: null, planProductId: null, discountPct: 0, status: null, periodEndAt: null, cancelAt: null };
const credits = {
  getMembershipForPerson: vi.fn<(...a: unknown[]) => unknown>(),
  canStartMembership: vi.fn<(...a: unknown[]) => unknown>(),
  getEuroBalance: vi.fn<(...a: unknown[]) => unknown>(),
  consumeCredits: vi.fn<(...a: unknown[]) => unknown>(),
};
vi.mock("@/modules/credits/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getMembershipForPerson: (...a: unknown[]) => credits.getMembershipForPerson(...a),
  canStartMembership: (...a: unknown[]) => credits.canStartMembership(...a),
  getEuroBalance: (...a: unknown[]) => credits.getEuroBalance(...a),
  consumeCredits: (...a: unknown[]) => credits.consumeCredits(...a),
}));

/** Runs before `createOrder`'s own quote (the one with `companyId`), to simulate a concurrent order. */
const catalogueHook: { beforeOrderQuote: ((db: unknown) => Promise<void>) | null } = { beforeOrderQuote: null };
vi.mock("./catalogue", async (importOriginal) => {
  const real = await importOriginal<typeof Catalogue>();
  return {
    ...real,
    getQuote: async (db: Parameters<typeof real.getQuote>[0], input: Parameters<typeof real.getQuote>[1]) => {
      const hook = catalogueHook.beforeOrderQuote;
      if (hook && "companyId" in input) {
        catalogueHook.beforeOrderQuote = null;
        await hook(db);
      }
      return real.getQuote(db, input);
    },
  };
});

const co = await import("./checkouts");
const { startBankTransfer } = await import("./bank-transfer");
const { createCtx, eq, and } = await import("@/lib/ctx");
const { makeCtx, makeJobCtx, resetRuntime, runJobTwice, createFakeIntegrations } = await import("@/lib/testing");

let h: DbHandle;
let termsVersionId: string;
const memberIds = new Set<string>();

beforeAll(async () => {
  h = await createTestDb();
  makeCtx(h.db, { integrations: createFakeIntegrations() });
  termsVersionId = (await ensureTermsVersion(h.db)).id;
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(() => {
  site.getCurrentLegalVersion.mockReset().mockImplementation(() => Promise.resolve({ versionId: termsVersionId, version: 1 }));
  finance.setOrderBillingDetails.mockReset().mockResolvedValue(undefined);
  credits.getMembershipForPerson.mockReset().mockImplementation((_db: unknown, personId: unknown) =>
    Promise.resolve(memberIds.has(personId as string) ? { ...noMembership, isMember: true, discountPct: 10, status: "active" } : noMembership),
  );
  credits.canStartMembership.mockReset().mockResolvedValue({ ok: true });
  credits.getEuroBalance.mockReset().mockResolvedValue({ remainingCents: 0, grants: [] });
  credits.consumeCredits.mockReset().mockResolvedValue({ consumed: [] });
});

type Viewer = Parameters<typeof co.startCheckout>[3];
const NOW = () => new Date();

function inTx<T>(fn: (tx: Tx, ctx: ReturnType<typeof createCtx>) => Promise<T>, now: Date = NOW()): Promise<T> {
  return h.db.transaction((tx) => fn(tx, createCtx({ tx, actor: { kind: "public" }, now, durableMode: "immediate" })));
}

/** Moves a checkout back in time (created and last active at `at`, expiry 30 days later). */
async function backdate(checkoutId: string, at: Date) {
  await h.db
    .update(checkouts)
    .set({ createdAt: at, lastActivityAt: at, expiresAt: new Date(at.getTime() + co.CHECKOUT_TTL_MS) })
    .where(eq(checkouts.id, checkoutId));
}

async function portalCheckout(personId: string, items: { productId: string; quantity: number }[], at?: Date) {
  const viewer: Viewer = { personId };
  const out = await inTx((tx, ctx) => co.startCheckout(tx, ctx, { channel: "portal", items, locale: "nl-BE" }, viewer));
  if (at) await backdate(out.checkoutId, at);
  return { ...out, viewer };
}

async function checkoutRow(id: string) {
  const [row] = await h.db.select().from(checkouts).where(eq(checkouts.id, id));
  return row!;
}

async function eventsOf(kind: string, checkoutId: string) {
  return h.db
    .select()
    .from(activityEvents)
    .where(and(eq(activityEvents.kind, kind), eq(activityEvents.dedupeKey, `checkout:${checkoutId}:${kind.split(".")[1]}`)));
}

describe("startCheckout and updateCheckout (rules 16, 48)", () => {
  it("stores items, the quote total, landing path and writes checkout.started for a known person", async () => {
    const person = await makePerson(h.db);
    const product = await makeProduct(h.db, { kind: "package", priceCents: 10000 });
    const { checkoutId, quote } = await portalCheckout(person.id, [{ productId: product.id, quantity: 2 }]);
    expect(quote.totalCents).toBe(20000);
    const row = await checkoutRow(checkoutId);
    expect(row).toMatchObject({ status: "started", channel: "portal", personId: person.id, totalCents: 20000 });
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBeGreaterThanOrEqual(co.CHECKOUT_TTL_MS - 1000);
    expect(await eventsOf("checkout.started", checkoutId)).toHaveLength(1);
  });

  it("stores landingPath from `from`, else from a same-origin Referer", async () => {
    expect(co.landingPathFrom("/nl/offers/day-pass", "https://other.example.com/x", "https://beam.example.com")).toBe("/nl/offers/day-pass");
    expect(co.landingPathFrom(null, "https://beam.example.com/fr/tarifs?x=1", "https://beam.example.com")).toBe("/fr/tarifs");
    expect(co.landingPathFrom("//evil.example.com", "https://other.example.com/x", "https://beam.example.com")).toBeNull();
    const product = await makeProduct(h.db, { kind: "voucher", priceCents: 5000, validityDays: 730 });
    const { checkoutId } = await inTx((tx, ctx) =>
      co.startCheckout(tx, ctx, { channel: "site", items: [{ productId: product.id, quantity: 1 }], locale: "en", email: "Guest.Landing@Example.com", landingPath: "/en/gift" }, { personId: null }),
    );
    const row = await checkoutRow(checkoutId);
    expect(row).toMatchObject({ landingPath: "/en/gift", email: "guest.landing@example.com", personId: null, channel: "site" });
    expect(await eventsOf("checkout.started", checkoutId)).toHaveLength(0);
  });

  it("refuses session products, a portal checkout without a person and a site guest without email", async () => {
    const person = await makePerson(h.db);
    const session = await makeProduct(h.db, { kind: "session", priceCents: 4500 });
    await expect(portalCheckout(person.id, [{ productId: session.id, quantity: 1 }])).rejects.toMatchObject({ code: "validation" });
    const item = await makeProduct(h.db, { kind: "item", priceCents: 1000 });
    await expect(inTx((tx, ctx) => co.startCheckout(tx, ctx, { channel: "portal", items: [{ productId: item.id, quantity: 1 }], locale: "en" }, { personId: null }))).rejects.toMatchObject({ code: "unauthorized" });
    await expect(inTx((tx, ctx) => co.startCheckout(tx, ctx, { channel: "site", items: [{ productId: item.id, quantity: 1 }], locale: "en" }, { personId: null }))).rejects.toMatchObject({ code: "validation" });
  });

  it("re-quotes on every step and flags a price change against the stored total", async () => {
    const person = await makePerson(h.db);
    const product = await makeProduct(h.db, { kind: "item", priceCents: 1000 });
    const { checkoutId, viewer } = await portalCheckout(person.id, [{ productId: product.id, quantity: 1 }]);
    const same = await inTx((tx, ctx) => co.updateCheckout(tx, ctx, { checkoutId, items: [{ productId: product.id, quantity: 3 }] }, viewer));
    expect(same).toMatchObject({ priceChanged: false });
    expect(same.quote.totalCents).toBe(3000);
    // A stored total from an older price: the next step reports the change and stores the new total.
    await h.db.update(checkouts).set({ totalCents: 2500 }).where(eq(checkouts.id, checkoutId));
    const changed = await inTx((tx, ctx) => co.updateCheckout(tx, ctx, { checkoutId }, viewer));
    expect(changed.priceChanged).toBe(true);
    expect((await checkoutRow(checkoutId)).totalCents).toBe(3000);
    const view = await co.getCheckout(h.db, checkoutId, viewer, "nl-BE");
    expect(view).toMatchObject({ priceChanged: false, isGuest: false });
    expect(view!.lines[0]).toMatchObject({ quantity: 3, lineTotalCents: 3000 });
    // Someone else cannot see or change it.
    expect(await co.getCheckout(h.db, checkoutId, { personId: randomUUID() }, "nl-BE")).toBeNull();
    await expect(inTx((tx, ctx) => co.updateCheckout(tx, ctx, { checkoutId }, { personId: randomUUID() }))).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("placeOrder (rules 20, 26a to 26c)", () => {
  it("stores the terms version, records the acceptance, passes billing details to finance and starts the payment", async () => {
    const person = await makePerson(h.db);
    const product = await makeProduct(h.db, { kind: "package", priceCents: 10000 });
    const { checkoutId, viewer } = await portalCheckout(person.id, [{ productId: product.id, quantity: 1 }]);
    const billingDetails = { isCompany: true, legalName: "Example BV", vatNumber: "BE0123456749", address: { line1: "Main street 1", postal_code: "1000", city: "Brussels", country: "BE" } };
    const parsed = co.PlaceOrderInput.parse({ checkoutId, clientKey: randomUUID(), useEuroCredit: false, acceptTerms: true, billingDetails, expectedTotalCents: 10000 });
    const out = await inTx((tx, ctx) => co.placeOrder(tx, ctx, parsed, viewer));
    expect(out.redirectUrl).toContain("fake-pay");
    const [order] = await h.db.select().from(orders).where(eq(orders.id, out.orderId));
    expect(order).toMatchObject({ termsVersionId, checkoutId, channel: "portal", status: "pending_payment", totalCents: 10000 });
    const acceptances = await h.db.select().from(termsAcceptances).where(eq(termsAcceptances.personId, person.id));
    expect(acceptances).toHaveLength(1);
    expect(acceptances[0]).toMatchObject({ pageVersionId: termsVersionId, context: "checkout" });
    expect(finance.setOrderBillingDetails).toHaveBeenCalledWith(expect.anything(), expect.anything(), { orderId: out.orderId, details: expect.objectContaining({ legalName: "Example BV", vatNumber: "BE0123456749" }) });
    expect((await checkoutRow(checkoutId)).orderId).toBe(out.orderId);
    // A second submit with the same key returns the same order (rule 20).
    const again = await inTx((tx, ctx) => co.placeOrder(tx, ctx, { ...parsed }, viewer));
    expect(again.orderId).toBe(out.orderId);
    expect(await h.db.select().from(termsAcceptances).where(eq(termsAcceptances.personId, person.id))).toHaveLength(1);
  });

  it("refuses with terms_unavailable when no terms version is published (edge case 30)", async () => {
    site.getCurrentLegalVersion.mockResolvedValue(null);
    const person = await makePerson(h.db);
    const product = await makeProduct(h.db, { kind: "item", priceCents: 1000 });
    const { checkoutId, viewer } = await portalCheckout(person.id, [{ productId: product.id, quantity: 1 }]);
    await expect(inTx((tx, ctx) => co.placeOrder(tx, ctx, { checkoutId, clientKey: randomUUID(), useEuroCredit: false, acceptTerms: true }, viewer))).rejects.toMatchObject({
      code: "conflict",
      message: "terms_unavailable",
    });
    expect(await h.db.select().from(orders).where(eq(orders.checkoutId, checkoutId))).toHaveLength(0);
  });

  it("refuses a changed price before payment and a membership the person cannot start (rule 26c)", async () => {
    const person = await makePerson(h.db);
    const product = await makeProduct(h.db, { kind: "item", priceCents: 1000 });
    const { checkoutId, viewer } = await portalCheckout(person.id, [{ productId: product.id, quantity: 1 }]);
    await expect(inTx((tx, ctx) => co.placeOrder(tx, ctx, { checkoutId, clientKey: randomUUID(), useEuroCredit: false, acceptTerms: true, expectedTotalCents: 900 }, viewer))).rejects.toMatchObject({
      message: "price_changed",
    });
    const plan = await makeProduct(h.db, { kind: "membership", priceCents: 5900 });
    credits.canStartMembership.mockResolvedValue({ ok: false, reason: "already_member" });
    const m = await portalCheckout(person.id, [{ productId: plan.id, quantity: 1 }]);
    expect(m.quote.warnings).toContainEqual({ code: "already_member", productId: plan.id });
    await expect(inTx((tx, ctx) => co.placeOrder(tx, ctx, { checkoutId: m.checkoutId, clientKey: randomUUID(), useEuroCredit: false, acceptTerms: true }, m.viewer))).rejects.toMatchObject({
      code: "conflict",
      message: "already_member",
    });
  });

  it("quotes and orders a site guest as public even with a member's email, attached to the member (edge case 23)", async () => {
    const member = await makePerson(h.db, { email: `member-${randomUUID().slice(0, 8)}@example.com` });
    memberIds.add(member.id);
    const product = await makeProduct(h.db, { kind: "package", priceCents: 10000 });
    const items = [{ productId: product.id, quantity: 1 }];
    // Signed in: the member price.
    const signedIn = await portalCheckout(member.id, items);
    expect(signedIn.quote.totalCents).toBe(9000);
    // Guest with the member's email: the public price, and no order at the member price.
    const guestViewer = { personId: null, checkoutIds: [] as string[] };
    const guest = await inTx((tx, ctx) => co.startCheckout(tx, ctx, { channel: "site", items, locale: "nl-BE", email: member.email! }, guestViewer));
    expect(guest.quote.totalCents).toBe(10000);
    const viewer = { personId: null, checkoutIds: [guest.checkoutId] };
    expect((await co.getCheckout(h.db, guest.checkoutId, viewer, "nl-BE"))!.quote.totalCents).toBe(10000);
    // The order attaches to the member at the public price (pricingPersonId null); no login needed.
    const out = await inTx((tx, ctx) => co.placeOrder(tx, ctx, { checkoutId: guest.checkoutId, clientKey: randomUUID(), useEuroCredit: false, acceptTerms: true, expectedTotalCents: 10000 }, viewer));
    const placed = await h.db.select().from(orders).where(eq(orders.checkoutId, guest.checkoutId));
    expect(placed).toHaveLength(1);
    expect(placed[0]).toMatchObject({ id: out.orderId, personId: member.id, totalCents: 10000 });
  });

  it("creates the guest's person from the email and attaches the site order to it", async () => {
    const product = await makeProduct(h.db, { kind: "voucher", priceCents: 5000, validityDays: 730 });
    const email = `guest-${randomUUID().slice(0, 8)}@example.com`;
    const started = await inTx((tx, ctx) => co.startCheckout(tx, ctx, { channel: "site", items: [{ productId: product.id, quantity: 1 }], locale: "en", email }, { personId: null }));
    const viewer = { personId: null, checkoutIds: [started.checkoutId] };
    const out = await inTx((tx, ctx) => co.placeOrder(tx, ctx, { checkoutId: started.checkoutId, clientKey: randomUUID(), useEuroCredit: false, acceptTerms: true }, viewer));
    const [order] = await h.db.select().from(orders).where(eq(orders.id, out.orderId));
    expect(order).toMatchObject({ channel: "site", totalCents: 5000, termsVersionId });
    expect(order!.personId).toBeTruthy();
    expect((await checkoutRow(started.checkoutId)).personId).toBe(order!.personId);
    expect(co.canSeeOrder(order!, { personId: null, orderIds: [order!.id] })).toBe(true);
    expect(co.canSeeOrder(order!, { personId: null })).toBe(false);
  });
});

describe("placeOrder against a stale or re-priced order (review fixes 8, 9)", () => {
  it("does not return the pending order of a basket changed since; it is replaced once its payment ended", async () => {
    const person = await makePerson(h.db);
    const a = await makeProduct(h.db, { kind: "package", priceCents: 10000 });
    const b = await makeProduct(h.db, { kind: "item", priceCents: 2500 });
    const { checkoutId, viewer } = await portalCheckout(person.id, [{ productId: a.id, quantity: 1 }]);
    const first = await inTx((tx, ctx) => co.placeOrder(tx, ctx, { checkoutId, clientKey: randomUUID(), useEuroCredit: false, acceptTerms: true, expectedTotalCents: 10000 }, viewer));
    // The checkout stays `started`: the customer changes the basket.
    const changed = await inTx((tx, ctx) => co.updateCheckout(tx, ctx, { checkoutId, items: [{ productId: b.id, quantity: 2 }] }, viewer));
    expect(changed.quote.totalCents).toBe(5000);
    // While the old order's provider payment is live it cannot be cancelled: refused, not the old basket.
    await expect(inTx((tx, ctx) => co.placeOrder(tx, ctx, { checkoutId, clientKey: randomUUID(), useEuroCredit: false, acceptTerms: true, expectedTotalCents: 5000 }, viewer))).rejects.toMatchObject({
      code: "conflict",
      message: "payment_in_progress",
    });
    // The payment ended (failed): the stale order is cancelled and a new one placed for the basket shown.
    await h.db.update(payments).set({ status: "failed" }).where(eq(payments.orderId, first.orderId));
    const second = await inTx((tx, ctx) => co.placeOrder(tx, ctx, { checkoutId, clientKey: randomUUID(), useEuroCredit: false, acceptTerms: true, expectedTotalCents: 5000 }, viewer));
    expect(second.orderId).not.toBe(first.orderId);
    const [old] = await h.db.select().from(orders).where(eq(orders.id, first.orderId));
    const [fresh] = await h.db.select().from(orders).where(eq(orders.id, second.orderId));
    expect(old!.status).toBe("cancelled");
    expect(fresh).toMatchObject({ status: "pending_payment", totalCents: 5000, checkoutId });
    expect(await checkoutRow(checkoutId)).toMatchObject({ orderId: second.orderId, totalCents: 5000 });
  });

  it("refuses with price_changed when a promotion is used up between the shown quote and the order", async () => {
    const staff = await makeUser(h.db);
    const code = `LAST${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
    const [promo] = await h.db
      .insert(promotions)
      .values({ code, name: { en: "Last", "nl-BE": "Laatste", "fr-BE": "Dernier" }, kind: "percent", value: 10, startsAt: new Date(Date.now() - 3600_000), maxUses: 1, createdByUserId: staff.id })
      .returning();
    const person = await makePerson(h.db);
    const product = await makeProduct(h.db, { kind: "package", priceCents: 10000 });
    const { checkoutId, viewer } = await portalCheckout(person.id, [{ productId: product.id, quantity: 1 }]);
    const shown = await inTx((tx, ctx) => co.updateCheckout(tx, ctx, { checkoutId, promoCode: code }, viewer));
    expect(shown.quote.totalCents).toBe(9000);
    // A concurrent order takes the last use after placeOrder's early check, before createOrder's locked quote.
    catalogueHook.beforeOrderQuote = async (db) => {
      await (db as Tx).update(promotions).set({ usesCount: 1 }).where(eq(promotions.id, promo!.id));
    };
    await expect(inTx((tx, ctx) => co.placeOrder(tx, ctx, { checkoutId, clientKey: randomUUID(), useEuroCredit: false, acceptTerms: true, expectedTotalCents: 9000 }, viewer))).rejects.toMatchObject({
      code: "conflict",
      message: "price_changed",
    });
    expect(catalogueHook.beforeOrderQuote).toBeNull();
    expect(await h.db.select().from(orders).where(eq(orders.checkoutId, checkoutId))).toHaveLength(0);
  });
});

describe("checkout completion (rule 50)", () => {
  it("completes `started -> completed` and `abandoned -> completed` with checkout.completed", async () => {
    const person = await makePerson(h.db);
    const free = await makeProduct(h.db, { kind: "item", priceCents: 0 });
    const a = await portalCheckout(person.id, [{ productId: free.id, quantity: 1 }]);
    const outA = await inTx((tx, ctx) => co.placeOrder(tx, ctx, { checkoutId: a.checkoutId, clientKey: randomUUID(), useEuroCredit: false, acceptTerms: true }, a.viewer));
    expect(outA.redirectUrl).toContain(`/checkout/return/${outA.orderId}`);
    expect(await checkoutRow(a.checkoutId)).toMatchObject({ status: "completed", orderId: outA.orderId });
    expect(await eventsOf("checkout.completed", a.checkoutId)).toHaveLength(1);

    const old = new Date(Date.now() - 2 * 60 * 60_000);
    const b = await portalCheckout(person.id, [{ productId: free.id, quantity: 1 }], old);
    await co.markAbandoned(makeJobCtx(h.db, "checkouts.mark_abandoned"));
    expect((await checkoutRow(b.checkoutId)).status).toBe("abandoned");
    await inTx((tx, ctx) => co.placeOrder(tx, ctx, { checkoutId: b.checkoutId, clientKey: randomUUID(), useEuroCredit: false, acceptTerms: true }, b.viewer));
    expect((await checkoutRow(b.checkoutId)).status).toBe("completed");
    expect(await eventsOf("checkout.completed", b.checkoutId)).toHaveLength(1);
  });
});

describe("checkouts.mark_abandoned (rules 49, 50)", () => {
  const twoHoursAgo = () => new Date(Date.now() - 2 * 60 * 60_000);

  async function withEndedPayment(checkoutId: string, personId: string, status: "failed" | "expired" | null) {
    const order = await makeOrder(h.db, { personId, checkoutId, channel: "portal", totalCents: 1000, subtotalCents: 1000 });
    await makeOrderLine(h.db, { orderId: order.id });
    await h.db.update(checkouts).set({ orderId: order.id }).where(eq(checkouts.id, checkoutId));
    if (status) await h.db.insert(payments).values({ orderId: order.id, provider: "mollie", status, amountCents: 1000, providerPaymentId: `tr_${randomUUID().slice(0, 10)}` });
  }

  it("abandons idle checkouts with each reason, writes the event only with a person, and is idempotent", async () => {
    const product = await makeProduct(h.db, { kind: "item", priceCents: 1000 });
    const items = [{ productId: product.id, quantity: 1 }];
    const pLeft = await makePerson(h.db);
    const pFailed = await makePerson(h.db);
    const pExpired = await makePerson(h.db);
    const left = await portalCheckout(pLeft.id, items, twoHoursAgo());
    const failed = await portalCheckout(pFailed.id, items, twoHoursAgo());
    const expired = await portalCheckout(pExpired.id, items, twoHoursAgo());
    await withEndedPayment(failed.checkoutId, pFailed.id, "failed");
    await withEndedPayment(expired.checkoutId, pExpired.id, "expired");
    const guest = await inTx((tx, ctx) => co.startCheckout(tx, ctx, { channel: "site", items, locale: "en", email: "idle.guest@example.com" }, { personId: null }));
    await backdate(guest.checkoutId, twoHoursAgo());
    const recent = await portalCheckout(pLeft.id, items);

    const first = await co.markAbandoned(makeJobCtx(h.db, "checkouts.mark_abandoned"));
    expect(first.abandoned).toBeGreaterThanOrEqual(4);
    expect(await checkoutRow(left.checkoutId)).toMatchObject({ status: "abandoned", abandonedReason: "left" });
    expect(await checkoutRow(failed.checkoutId)).toMatchObject({ status: "abandoned", abandonedReason: "payment_failed" });
    expect(await checkoutRow(expired.checkoutId)).toMatchObject({ status: "abandoned", abandonedReason: "payment_expired" });
    expect(await checkoutRow(guest.checkoutId)).toMatchObject({ status: "abandoned", abandonedReason: "left" });
    expect((await checkoutRow(recent.checkoutId)).status).toBe("started");

    const [ev] = await eventsOf("checkout.abandoned", failed.checkoutId);
    expect(ev).toMatchObject({ personId: pFailed.id });
    expect(ev!.data).toMatchObject({ checkout_id: failed.checkoutId, total_cents: 1000, product_ids: [product.id], channel: "portal", reason: "payment_failed" });
    expect(await eventsOf("checkout.abandoned", guest.checkoutId)).toHaveLength(0);

    // Double run: nothing changes, no second event.
    const second = await co.markAbandoned(makeJobCtx(h.db, "checkouts.mark_abandoned"));
    expect(second).toMatchObject({ abandoned: 0, events: 0 });
    expect(await eventsOf("checkout.abandoned", left.checkoutId)).toHaveLength(1);
  });

  it("runs twice through the job registry with the same result state (double-run)", async () => {
    const person = await makePerson(h.db);
    const product = await makeProduct(h.db, { kind: "item", priceCents: 1000 });
    const c = await portalCheckout(person.id, [{ productId: product.id, quantity: 1 }], twoHoursAgo());
    const { first, second } = await runJobTwice(h.db, "checkouts.mark_abandoned", {});
    expect((first as { abandoned: number }).abandoned).toBeGreaterThanOrEqual(1);
    expect(second).toMatchObject({ abandoned: 0, expired: 0, events: 0 });
    expect(await checkoutRow(c.checkoutId)).toMatchObject({ status: "abandoned", abandonedReason: "left" });
    expect(await eventsOf("checkout.abandoned", c.checkoutId)).toHaveLength(1);
  });

  it("expires checkouts 30 days after creation from started and abandoned; completed stays final", async () => {
    const person = await makePerson(h.db);
    const product = await makeProduct(h.db, { kind: "item", priceCents: 1000 });
    const items = [{ productId: product.id, quantity: 1 }];
    const old = new Date(Date.now() - 31 * 24 * 60 * 60_000);
    const started = await portalCheckout(person.id, items, old);
    const abandoned = await portalCheckout(person.id, items, old);
    await h.db.update(checkouts).set({ status: "abandoned", abandonedAt: old, abandonedReason: "left" }).where(eq(checkouts.id, abandoned.checkoutId));
    const completed = await portalCheckout(person.id, items, old);
    await h.db.update(checkouts).set({ status: "completed", completedAt: old }).where(eq(checkouts.id, completed.checkoutId));

    const out = await co.markAbandoned(makeJobCtx(h.db, "checkouts.mark_abandoned"));
    expect(out.expired).toBeGreaterThanOrEqual(2);
    expect((await checkoutRow(started.checkoutId)).status).toBe("expired");
    expect((await checkoutRow(abandoned.checkoutId)).status).toBe("expired");
    expect((await checkoutRow(completed.checkoutId)).status).toBe("completed");
    await expect(inTx((tx, ctx) => co.updateCheckout(tx, ctx, { checkoutId: started.checkoutId }, started.viewer))).rejects.toMatchObject({ message: "checkout_closed" });
  });
});

describe("shop product resolution (`?product=<id>`)", () => {
  it("resolves an active shop product by id or SKU and returns null for unknown, hidden or dated products", async () => {
    const person = await makePerson(h.db);
    const visible = await makeProduct(h.db, { kind: "package", priceCents: 8000, isShopVisible: true });
    const hidden = await makeProduct(h.db, { kind: "package", priceCents: 8000, isShopVisible: false });
    const session = await makeProduct(h.db, { kind: "session", priceCents: 4500, isShopVisible: true });
    const byId = await co.getShopProduct(h.db, { productId: visible.id, personId: person.id, locale: "en" });
    expect(byId).toMatchObject({ sku: visible.sku, unitCents: 8000 });
    expect(await co.getShopProduct(h.db, { sku: visible.sku, personId: person.id, locale: "en" })).toMatchObject({ productId: visible.id });
    expect(await co.getShopProduct(h.db, { productId: randomUUID(), personId: person.id, locale: "en" })).toBeNull();
    expect(await co.getShopProduct(h.db, { productId: "not-a-uuid", personId: person.id, locale: "en" })).toBeNull();
    expect(await co.getShopProduct(h.db, { productId: hidden.id, personId: person.id, locale: "en" })).toBeNull();
    expect(await co.getShopProduct(h.db, { productId: session.id, personId: person.id, locale: "en" })).toBeNull();
    const catalogue = await co.getShopCatalogue(h.db, { personId: person.id, locale: "en" });
    expect(catalogue.map((p) => p.productId)).toContain(visible.id);
    expect(catalogue.map((p) => p.productId)).not.toContain(hidden.id);
  });
});

describe("payOrder and retryPayment", () => {
  it("refuses an expired order and an order of someone else", async () => {
    const person = await makePerson(h.db);
    const expired = await makeOrder(h.db, { personId: person.id, channel: "portal", totalCents: 4500, subtotalCents: 4500, expiresAt: new Date(Date.now() - 60_000), termsVersionId });
    await makeOrderLine(h.db, { orderId: expired.id });
    const viewer = { personId: person.id };
    await expect(inTx((tx, ctx) => co.payOrder(tx, ctx, { orderId: expired.id, clientKey: randomUUID(), useEuroCredit: false }, viewer))).rejects.toMatchObject({ message: "order_expired" });
    await expect(inTx((tx, ctx) => co.retryPayment(tx, ctx, { orderId: expired.id, clientKey: randomUUID() }, viewer))).rejects.toMatchObject({ message: "order_expired" });
    await expect(inTx((tx, ctx) => co.payOrder(tx, ctx, { orderId: expired.id, clientKey: randomUUID(), useEuroCredit: false }, { personId: randomUUID() }))).rejects.toMatchObject({ code: "not_found" });
  });

  it("pays a booking-created order without asking again for the same terms version, and polls status", async () => {
    const person = await makePerson(h.db);
    const order = await makeOrder(h.db, { personId: person.id, channel: "portal", totalCents: 4500, subtotalCents: 4500, expiresAt: new Date(Date.now() + 10 * 60_000), termsVersionId });
    await makeOrderLine(h.db, { orderId: order.id, unitAmountCents: 4500, lineTotalCents: 4500 });
    const viewer = { personId: person.id };
    const out = await inTx((tx, ctx) => co.payOrder(tx, ctx, { orderId: order.id, clientKey: randomUUID(), useEuroCredit: false }, viewer));
    expect(out.redirectUrl).toContain("fake-pay");
    expect(await h.db.select().from(termsAcceptances).where(eq(termsAcceptances.personId, person.id))).toHaveLength(0);
    const view = await co.getOrderForViewer(h.db, order.id, viewer, "en");
    expect(view).toMatchObject({ status: "pending_payment", needsTerms: false, dueCents: 4500 });
    const status = await inTx((tx, ctx) => co.pollOrderStatus(tx, ctx, order.id, viewer));
    expect(status).toMatchObject({ status: "pending_payment", paymentStatus: "open" });
    const syncJobs = await h.db.select().from(jobs).where(eq(jobs.kind, "payments.sync"));
    expect(syncJobs.some((j) => j.idempotencyKey.startsWith("payment_sync:"))).toBe(true);
  });

  it("asks for the terms when the published version changed since the order was created", async () => {
    const person = await makePerson(h.db);
    const order = await makeOrder(h.db, { personId: person.id, channel: "portal", totalCents: 4500, subtotalCents: 4500, expiresAt: new Date(Date.now() + 10 * 60_000), termsVersionId });
    await makeOrderLine(h.db, { orderId: order.id });
    site.getCurrentLegalVersion.mockResolvedValue({ versionId: randomUUID(), version: 2 });
    await expect(inTx((tx, ctx) => co.payOrder(tx, ctx, { orderId: order.id, clientKey: randomUUID(), useEuroCredit: false }, { personId: person.id }))).rejects.toMatchObject({
      code: "validation",
      fields: { acceptTerms: "required" },
    });
  });
});

describe("euro credit on an existing order (review fixes 2, 3, 7)", () => {
  async function pendingOrder(personId: string, channel: "site" | "portal" = "portal") {
    const order = await makeOrder(h.db, { personId, channel, totalCents: 5000, subtotalCents: 5000, expiresAt: new Date(Date.now() + 10 * 60_000), termsVersionId });
    await makeOrderLine(h.db, { orderId: order.id, unitAmountCents: 5000, lineTotalCents: 5000 });
    return order;
  }
  const creditPayments = (orderId: string) => h.db.select().from(payments).where(and(eq(payments.orderId, orderId), eq(payments.provider, "credit_balance")));

  it("a viewer holding the order only through the cookie neither sees nor spends the person's euro credit", async () => {
    const member = await makePerson(h.db, { email: `victim-${randomUUID().slice(0, 8)}@example.com` });
    credits.getEuroBalance.mockResolvedValue({ remainingCents: 8000, grants: [] });
    // A guest-placed site order attached to the member through the email, held in the guest's cookie.
    const order = await pendingOrder(member.id, "site");
    const guest = { personId: null, orderIds: [order.id] };
    expect(await co.getOrderForViewer(h.db, order.id, guest, "en")).toMatchObject({ euroBalanceCents: 0, dueCents: 5000 });
    const out = await inTx((tx, ctx) => co.payOrder(tx, ctx, { orderId: order.id, clientKey: randomUUID(), useEuroCredit: true }, guest));
    expect(out.redirectUrl).toContain("fake-pay");
    expect(credits.consumeCredits).not.toHaveBeenCalled();
    expect(await creditPayments(order.id)).toHaveLength(0);
    // A guest who signed in to another account of their own and still holds the cookie: the same.
    const other = await makePerson(h.db);
    expect(await co.getOrderForViewer(h.db, order.id, { personId: other.id, orderIds: [order.id] }, "en")).toMatchObject({ euroBalanceCents: 0 });
    // The member themself sees the balance.
    expect(await co.getOrderForViewer(h.db, order.id, { personId: member.id }, "en")).toMatchObject({ euroBalanceCents: 8000 });
  });

  it("the signed-in owner spends their euro credit on the due", async () => {
    const person = await makePerson(h.db);
    credits.getEuroBalance.mockResolvedValue({ remainingCents: 2000, grants: [] });
    const order = await pendingOrder(person.id);
    await inTx((tx, ctx) => co.payOrder(tx, ctx, { orderId: order.id, clientKey: randomUUID(), useEuroCredit: true }, { personId: person.id }));
    expect(credits.consumeCredits).toHaveBeenCalledTimes(1);
    expect(credits.consumeCredits.mock.calls[0]![2]).toMatchObject({ personId: person.id, kind: "euro", units: 2000, ref: { type: "order", id: order.id } });
    expect(await creditPayments(order.id)).toHaveLength(1);
  });

  it("does not consume credit on top of a live provider payment that is reused at its amount", async () => {
    const person = await makePerson(h.db);
    const order = await pendingOrder(person.id);
    const viewer = { personId: person.id };
    const first = await inTx((tx, ctx) => co.payOrder(tx, ctx, { orderId: order.id, clientKey: randomUUID(), useEuroCredit: false }, viewer));
    expect(first.redirectUrl).toContain("fake-pay");
    credits.getEuroBalance.mockResolvedValue({ remainingCents: 2000, grants: [] });
    const again = await inTx((tx, ctx) => co.payOrder(tx, ctx, { orderId: order.id, clientKey: randomUUID(), useEuroCredit: true }, viewer));
    expect(again.redirectUrl).toBe(first.redirectUrl);
    expect(credits.consumeCredits).not.toHaveBeenCalled();
    expect(await creditPayments(order.id)).toHaveLength(0);
    const all = await h.db.select().from(payments).where(eq(payments.orderId, order.id));
    expect(all).toHaveLength(1);
    expect(all[0]!.amountCents).toBe(5000);
  });
});

describe("an open bank transfer blocks paying online (review fix 11)", () => {
  it("payOrder and retryPayment refuse with payment_in_progress and create no provider payment", async () => {
    const person = await makePerson(h.db);
    const order = await makeOrder(h.db, { personId: person.id, channel: "portal", totalCents: 4500, subtotalCents: 4500, expiresAt: new Date(Date.now() + 10 * 60_000), termsVersionId });
    await makeOrderLine(h.db, { orderId: order.id, productKind: "package", unitAmountCents: 4500, lineTotalCents: 4500 });
    await inTx((tx, ctx) => startBankTransfer(tx, ctx, { orderId: order.id }));
    const viewer = { personId: person.id };
    await expect(inTx((tx, ctx) => co.payOrder(tx, ctx, { orderId: order.id, clientKey: randomUUID(), useEuroCredit: false }, viewer))).rejects.toMatchObject({ code: "conflict", message: "payment_in_progress" });
    await expect(inTx((tx, ctx) => co.retryPayment(tx, ctx, { orderId: order.id, clientKey: randomUUID() }, viewer))).rejects.toMatchObject({ code: "conflict", message: "payment_in_progress" });
    const rows = await h.db.select().from(payments).where(eq(payments.orderId, order.id));
    expect(rows.map((p) => p.provider)).toEqual(["bank_transfer"]);
  });
});

describe("viewer cookie", () => {
  it("round-trips signed entries and drops forged ones", () => {
    const c = randomUUID();
    const o = randomUUID();
    const value = co.addToViewerCookie(co.addToViewerCookie(null, "checkout", c), "order", o);
    expect(co.parseViewerCookie(value)).toEqual({ checkoutIds: [c], orderIds: [o] });
    expect(co.parseViewerCookie(`c.${randomUUID()}.forged`)).toEqual({ checkoutIds: [], orderIds: [] });
  });
});
