/**
 * Owner decisions on the public booking flow, end to end through `booking.book_as_guest` (and
 * `bookSeats` for a signed-in member or package holder) with the real commerce:
 * - companions: other adults without an account, one seat each or a shared bed on a night (R13),
 *   priced as adults, member discounts only for the member themself;
 * - the "discount code or gift voucher" field: a promotion code applied by the quote, a gift
 *   voucher paying part or all of the order, and clear refusals for unknown or expired codes;
 * - booking extras as extra order lines, with the member's discount from the quote;
 * - several sessions in one order: held, confirmed and released together, credits per kind;
 * - campaign links: the visit's UTM on the order and on a new person's acquisition only.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson, makeProduct, makeUser } from "@beam/db/testing";
import { ensureTermsVersion, makePaidOrder } from "@beam/db/testing/commerce-factories";
import { makeCreditGrant, makeMembership } from "@beam/db/testing/credits-factories";
import type { DbHandle } from "@beam/db";
import { bookings, creditEntries, orderLines, orders, payments, persons, promotions, vouchers } from "@beam/db/schema";
import { deriveVoucherCode, hashVoucherCode, voucherCodeLast4 } from "@beam/core/commerce";

const jar = new Map<string, string>();
// A new visitor IP per request: the public action's per-IP limit (20 a minute) is not under test.
let ipN = 0;
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": `198.51.100.${(ipN++ % 250) + 1}` })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));
const terms = { versionId: "" };
vi.mock("@/modules/site/api", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getCurrentLegalVersion: () => Promise.resolve({ versionId: terms.versionId, version: 1 }),
  hasAcceptedCurrentTerms: () => Promise.resolve(false),
  getLegalLinks: () => Promise.resolve({ privacy: null, terms: null, cookies: null, accessibility: null }),
}));
vi.mock("@/modules/finance/api", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  issueInvoice: () => Promise.resolve({ status: "issued", invoiceId: randomUUID(), number: "2026-000001" }),
}));

const SECRET = "test-voucher-secret-party";
process.env.VOUCHER_CODE_SECRET = SECRET;

const { bookAsGuest } = await import("./bookings");
const { bookSeats } = await import("../server/book");
const { releaseOrderBookings } = await import("../server/order-hooks");
const { finalizePaidOrder } = await import("@/modules/commerce/server/paid");
const { createCtx, eq, inArray } = await import("@/lib/ctx");
const { makeCtx, resetRuntime, createFakeIntegrations } = await import("@/lib/testing");
const { openSession, setBookingRules, inTx, customerActor, DAY } = await import("../server/booking-p3a.fixtures");

let h: DbHandle;
let staffUserId: string;
const emergencyContact = { name: "Mieke Peeters", phone: "+32 470 00 00 00" };

beforeAll(async () => {
  h = await createTestDb();
  makeCtx(h.db, { integrations: createFakeIntegrations() });
  await setBookingRules(h.db);
  terms.versionId = (await ensureTermsVersion(h.db)).id;
  staffUserId = (await makeUser(h.db)).id;
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

const paid = (orderId: string) => h.db.transaction((tx) => finalizePaidOrder(tx, createCtx({ tx, actor: { kind: "webhook", provider: "stripe" }, durableMode: "immediate" }), orderId));
const email = (tag: string) => `${tag}-${randomUUID().slice(0, 8)}@example.com`;
const guest = (over: Record<string, unknown> = {}) => ({
  email: email("party"),
  firstName: "Sofie",
  lastName: "Peeters",
  phone: "+32 470 11 22 33",
  pay: "order" as const,
  acceptTerms: true,
  clientKey: randomUUID(),
  ...over,
});
async function checkout(input: Parameters<typeof bookAsGuest>[0]) {
  jar.clear();
  const res = await bookAsGuest(input);
  if (!res.ok) throw new Error(JSON.stringify(res.error));
  if (res.data.kind !== "checkout") throw new Error("expected a checkout");
  return res.data;
}
const linesOf = (orderId: string) => h.db.select().from(orderLines).where(eq(orderLines.orderId, orderId)).orderBy(orderLines.lineNo);
const seatsOf = (sessionId: string) => h.db.select().from(bookings).where(eq(bookings.sessionId, sessionId)).orderBy(bookings.createdAt);

async function daySession(priceCents = 12_000, over: Parameters<typeof openSession>[1] = {}) {
  const product = await makeProduct(h.db, { kind: "session", priceCents });
  return openSession(h.db, { kind: "day", productId: product.id, ...over });
}
async function nightSession(priceCents = 42_000, over: Parameters<typeof openSession>[1] = {}) {
  const product = await makeProduct(h.db, { kind: "night", priceCents, vatRatePct: "6.00" });
  return openSession(h.db, { kind: "night", productId: product.id, ...over });
}

describe("companions (owner decision: several adults without an account)", () => {
  it("books each companion as an adult seat of the same order; a shared bed takes no bed on a night", async () => {
    const night = await nightSession();
    const data = await checkout({
      ...guest(),
      sessionId: night.id,
      emergencyContact,
      companions: [
        { firstName: "Jan", lastName: "Claes", sharesBed: true },
        { firstName: "An", lastName: "Wouters", email: email("an") },
      ],
    });
    const seats = await seatsOf(night.id);
    expect(seats).toHaveLength(3);
    const [owner, jan, an] = seats;
    expect(owner).toMatchObject({ guestOfBookingId: null, capacityUnits: 1, status: "reserved" });
    expect([jan!.guestOfBookingId, jan!.capacityUnits, an!.guestOfBookingId, an!.capacityUnits]).toEqual([owner!.id, 0, owner!.id, 1]);
    const people = await h.db.select().from(persons).where(inArray(persons.id, [jan!.personId, an!.personId]));
    expect(people.map((p) => [p.firstName, p.email === null]).sort()).toEqual([
      ["An", false],
      ["Jan", true],
    ]);
    // Three adult night lines at the public price, one order.
    const lines = await linesOf(data.orderId);
    expect(lines.map((l) => [l.sessionId, l.lineTotalCents])).toEqual([
      [night.id, 42_000],
      [night.id, 42_000],
      [night.id, 42_000],
    ]);
    await paid(data.orderId);
    expect((await seatsOf(night.id)).every((s) => s.status === "confirmed")).toBe(true);
  });

  it("refuses more companions than the rules allow, a shared bed on a day session and beyond the shared-bed limit", async () => {
    const day = await daySession();
    const four = Array.from({ length: 4 }, (_, i) => ({ firstName: `P${i}`, lastName: "Test" }));
    expect(await bookAsGuest({ ...guest(), sessionId: day.id, companions: four })).toMatchObject({ ok: false, error: { message: "too_many_guests" } });
    expect(await bookAsGuest({ ...guest(), sessionId: day.id, companions: [{ firstName: "Jan", lastName: "Claes", sharesBed: true }] })).toMatchObject({
      ok: false,
      error: { message: "shared_bed_limit" },
    });
    const night = await nightSession();
    const sharers = [
      { firstName: "Jan", lastName: "Claes", sharesBed: true },
      { firstName: "An", lastName: "Wouters", sharesBed: true },
    ];
    expect(await bookAsGuest({ ...guest(), sessionId: night.id, emergencyContact, companions: sharers })).toMatchObject({ ok: false, error: { message: "shared_bed_limit" } });
    expect(await seatsOf(day.id)).toHaveLength(0);
    expect(await seatsOf(night.id)).toHaveLength(0);
  });

  it("gives a member's discount to the member only: companions pay the adult price", async () => {
    const plan = await makeProduct(h.db, { kind: "membership", recurringInterval: "year", memberDiscountPct: "20.00", priceCents: 39_600 });
    const member = await makePerson(h.db);
    await makeMembership(h.db, { personId: member.id, productId: plan.id, discountPct: "20.00" });
    const day = await daySession(12_000);
    const result = await inTx(h.db, customerActor(member.id), (tx, ctx) =>
      bookSeats(tx, ctx, {
        sessionId: day.id,
        personId: member.id,
        payWith: "order",
        guests: [{ firstName: "Jan", lastName: "Claes", payWith: "order" }],
        acceptTerms: true,
        clientKey: randomUUID(),
        source: "portal",
        by: "customer",
      }),
    );
    if (result.kind !== "checkout") throw new Error("expected a checkout");
    expect((await linesOf(result.orderId)).map((l) => l.lineTotalCents)).toEqual([9_600, 12_000]);
  });
});

describe("the discount code or gift voucher field", () => {
  async function promo(code: string, over: Partial<typeof promotions.$inferInsert> = {}) {
    await h.db
      .insert(promotions)
      .values({ code, name: { "nl-BE": "Korting", "fr-BE": "Réduction", en: "Discount" }, kind: "percent", value: 10, startsAt: new Date(Date.now() - DAY), createdByUserId: staffUserId, ...over });
  }
  async function activeVoucher(amountCents: number) {
    const buyer = await makePerson(h.db);
    const product = await makeProduct(h.db, { kind: "voucher" });
    const { lines } = await makePaidOrder(h.db, { personId: buyer.id, lines: [{ productId: product.id, productKind: "voucher", unitAmountCents: amountCents, vatRatePct: "0.00" }] });
    const id = randomUUID();
    const code = await deriveVoucherCode(SECRET, id);
    await h.db.insert(vouchers).values({
      id,
      orderLineId: lines[0]!.id,
      amountCents,
      purchaserPersonId: buyer.id,
      status: "active",
      activatedAt: new Date(),
      expiresAt: new Date(Date.now() + 730 * DAY),
      codeHash: await hashVoucherCode(code),
      codeLast4: voucherCodeLast4(code),
    });
    return { id, code };
  }

  it("applies a promotion code through the quote and shows it on the order", async () => {
    const code = `PARTY${randomUUID().slice(0, 4).toUpperCase()}`;
    await promo(code);
    const day = await daySession(12_000);
    const data = await checkout({ ...guest(), sessionId: day.id, code: code.toLowerCase() });
    const [order] = await h.db.select().from(orders).where(eq(orders.id, data.orderId));
    expect(order).toMatchObject({ subtotalCents: 12_000, discountCents: 1_200, totalCents: 10_800 });
    expect(order!.promotionId).not.toBeNull();
  });

  it("refuses an unknown or expired code with its reason and books nothing", async () => {
    const day = await daySession();
    expect(await bookAsGuest({ ...guest(), sessionId: day.id, code: "NOSUCHCODE" })).toMatchObject({ ok: false, error: { message: "promo_unknown", fields: { promoCode: "promo_unknown" } } });
    const old = `OLD${randomUUID().slice(0, 4).toUpperCase()}`;
    await promo(old, { startsAt: new Date(Date.now() - 10 * DAY), endsAt: new Date(Date.now() - DAY) });
    expect(await bookAsGuest({ ...guest(), sessionId: day.id, code: old })).toMatchObject({ ok: false, error: { message: "promo_expired" } });
    expect(await seatsOf(day.id)).toHaveLength(0);
  });

  it("redeems a gift voucher against the order: the rest stays due", async () => {
    const { id, code } = await activeVoucher(5_000);
    const day = await daySession(12_000);
    const input = { ...guest(), sessionId: day.id, code };
    const data = await checkout(input);
    const pays = await h.db.select().from(payments).where(eq(payments.orderId, data.orderId));
    expect(pays.map((p) => [p.provider, p.status, p.amountCents])).toEqual([["credit_balance", "paid", 5_000]]);
    // The same submit again (edge case 2) returns the same order and applies nothing twice.
    expect((await checkout(input)).orderId).toBe(data.orderId);
    expect(await h.db.select().from(payments).where(eq(payments.orderId, data.orderId))).toHaveLength(1);
    const [order] = await h.db.select().from(orders).where(eq(orders.id, data.orderId));
    expect(order!.status).toBe("pending_payment");
    const [voucher] = await h.db.select().from(vouchers).where(eq(vouchers.id, id));
    expect(voucher).toMatchObject({ status: "redeemed", redeemedByPersonId: order!.personId });
    // The voucher is used once.
    const again = await bookAsGuest({ ...guest(), sessionId: (await daySession()).id, code });
    expect(again).toMatchObject({ ok: false, error: { message: "voucher_used" } });
  });

  it("confirms the booking at once when the voucher covers the total, and refuses an unknown voucher code", async () => {
    const { code } = await activeVoucher(20_000);
    const day = await daySession(12_000);
    const data = await checkout({ ...guest(), sessionId: day.id, code });
    const [order] = await h.db.select().from(orders).where(eq(orders.id, data.orderId));
    expect(order!.status).toBe("paid");
    expect((await seatsOf(day.id)).map((s) => s.status)).toEqual(["confirmed"]);

    const other = await daySession();
    expect(await bookAsGuest({ ...guest(), sessionId: other.id, code: "BEAM-0000-0000-0000" })).toMatchObject({ ok: false, error: { message: "voucher_invalid" } });
    expect(await seatsOf(other.id)).toHaveLength(0);
  });
});

describe("booking extras (owner decision)", () => {
  async function extra(priceCents: number, over: Parameters<typeof makeProduct>[1] = {}) {
    return makeProduct(h.db, { kind: "item", itemCategory: "wellness_product", isBookingExtra: true, priceCents, ...over });
  }

  it("adds the chosen extras as order lines after the seats", async () => {
    const salt = await extra(2_500);
    const robe = await extra(500, { bookingExtraKinds: ["day"] });
    const day = await daySession(12_000);
    const data = await checkout({ ...guest(), sessionId: day.id, extras: [{ productId: salt.id, quantity: 2 }, { productId: robe.id, quantity: 1 }] });
    expect((await linesOf(data.orderId)).map((l) => [l.productId, l.quantity, l.lineTotalCents, l.sessionId])).toEqual([
      [day.productId, 1, 12_000, day.id],
      [salt.id, 2, 5_000, null],
      [robe.id, 1, 500, null],
    ]);
  });

  it("refuses a product that is not a booking extra, or one offered with other session kinds only", async () => {
    const plain = await makeProduct(h.db, { kind: "item", itemCategory: "merchandise", priceCents: 1_000 });
    const nightOnly = await extra(800, { bookingExtraKinds: ["night"] });
    const day = await daySession();
    expect(await bookAsGuest({ ...guest(), sessionId: day.id, extras: [{ productId: plain.id, quantity: 1 }] })).toMatchObject({ ok: false, error: { message: "extra_not_available" } });
    expect(await bookAsGuest({ ...guest(), sessionId: day.id, extras: [{ productId: nightOnly.id, quantity: 1 }] })).toMatchObject({ ok: false, error: { message: "extra_not_available" } });
    expect(await seatsOf(day.id)).toHaveLength(0);
  });

  it("applies the member's discount on an extra through the quote", async () => {
    const plan = await makeProduct(h.db, { kind: "membership", recurringInterval: "year", memberDiscountPct: "15.00", priceCents: 39_600 });
    const member = await makePerson(h.db);
    await makeMembership(h.db, { personId: member.id, productId: plan.id, discountPct: "15.00" });
    const salt = await extra(2_500, { memberDiscountPct: "30.00" });
    const day = await daySession(12_000);
    await makeCreditGrant(h.db, { personId: member.id, creditKind: "day", units: 2, startsAt: new Date(Date.now() - DAY) });
    const result = await inTx(h.db, customerActor(member.id), (tx, ctx) =>
      bookSeats(tx, ctx, { sessionId: day.id, personId: member.id, payWith: "credit", extras: [{ productId: salt.id, quantity: 2 }], acceptTerms: true, clientKey: randomUUID(), source: "portal", by: "customer" }),
    );
    // The seat is paid with a credit; the order carries the extras only, 30 % off for the member.
    if (result.kind !== "checkout") throw new Error("expected a checkout");
    expect((await linesOf(result.orderId)).map((l) => [l.productId, l.lineTotalCents])).toEqual([[salt.id, 3_500]]);
    expect((await seatsOf(day.id)).map((s) => [s.status, s.paidWith])).toEqual([["confirmed", "credit"]]);
  });
});

describe("several sessions in one payment (owner decision)", () => {
  it("holds every seat on one order, confirms them together when paid", async () => {
    const day = await daySession(12_000);
    const night = await nightSession(42_000, { startsAt: new Date(Date.now() + 3 * DAY) });
    const data = await checkout({ ...guest(), sessionId: day.id, moreSessionIds: [night.id], emergencyContact, companions: [{ firstName: "Jan", lastName: "Claes", sharesBed: true }] });
    const lines = await linesOf(data.orderId);
    expect(lines.map((l) => [l.sessionId, l.lineTotalCents])).toEqual([
      [day.id, 12_000],
      [day.id, 12_000],
      [night.id, 42_000],
      [night.id, 42_000],
    ]);
    const daySeats = await seatsOf(day.id);
    const nightSeats = await seatsOf(night.id);
    // The companion is one person on both sessions; the shared bed applies to the night only.
    expect(daySeats[1]!.personId).toBe(nightSeats[1]!.personId);
    expect([daySeats[1]!.capacityUnits, nightSeats[1]!.capacityUnits]).toEqual([1, 0]);
    expect([...daySeats, ...nightSeats].every((s) => s.status === "reserved" && s.orderLineId)).toBe(true);
    await paid(data.orderId);
    expect([...(await seatsOf(day.id)), ...(await seatsOf(night.id))].every((s) => s.status === "confirmed")).toBe(true);
  });

  it("releases every seat together when the payment does not complete", async () => {
    const a = await daySession();
    const b = await daySession(12_000, { startsAt: new Date(Date.now() + 4 * DAY) });
    const data = await checkout({ ...guest(), sessionId: a.id, moreSessionIds: [b.id] });
    const out = await inTx(h.db, { kind: "system", jobId: "" }, (tx, ctx) => releaseOrderBookings(tx, ctx, { orderId: data.orderId, reason: "payment_expired" }));
    expect(out.releasedBookingIds).toHaveLength(2);
    expect([...(await seatsOf(a.id)), ...(await seatsOf(b.id))].map((s) => [s.status, s.cancelReasonCode])).toEqual([
      ["cancelled", "payment_expired"],
      ["cancelled", "payment_expired"],
    ]);
  });

  it("refuses the whole booking when one session is full (nothing is held)", async () => {
    const a = await daySession();
    const full = await daySession(12_000, { capacitySeats: 0 });
    expect(await bookAsGuest({ ...guest(), sessionId: a.id, moreSessionIds: [full.id] })).toMatchObject({ ok: false, error: { message: "session_full" } });
    expect(await seatsOf(a.id)).toHaveLength(0);
  });

  it("pays each session with one credit of its own kind", async () => {
    const person = await makePerson(h.db);
    const dayGrant = await makeCreditGrant(h.db, { personId: person.id, creditKind: "day", units: 5, startsAt: new Date(Date.now() - DAY) });
    const nightGrant = await makeCreditGrant(h.db, { personId: person.id, creditKind: "night", units: 1, startsAt: new Date(Date.now() - DAY) });
    const day = await daySession();
    const night = await nightSession();
    const result = await inTx(h.db, customerActor(person.id), (tx, ctx) =>
      bookSeats(tx, ctx, { sessionId: day.id, moreSessionIds: [night.id], personId: person.id, payWith: "credit", emergencyContact, acceptTerms: true, clientKey: randomUUID(), source: "portal", by: "customer" }),
    );
    expect(result.kind).toBe("confirmed");
    const used = await h.db.select().from(creditEntries).where(inArray(creditEntries.refId, result.bookingIds));
    expect(used.map((e) => [e.grantId, e.quantity]).sort()).toEqual(
      [
        [dayGrant.id, -1],
        [nightGrant.id, -1],
      ].sort(),
    );
  });

  it("buys one package for every session of its kind; each seat takes one of its credits once paid", async () => {
    const pkg = await makeProduct(h.db, { kind: "package", creditKind: "day", creditUnits: 5, validityDays: 548, priceCents: 49_500 });
    const a = await daySession();
    const b = await daySession(12_000, { startsAt: new Date(Date.now() + 5 * DAY) });
    const data = await checkout({ ...guest(), sessionId: a.id, moreSessionIds: [b.id], pay: "package", packageProductId: pkg.id });
    const lines = await linesOf(data.orderId);
    expect(lines.map((l) => [l.productKind, l.lineTotalCents])).toEqual([["package", 49_500]]);
    const seats = [...(await seatsOf(a.id)), ...(await seatsOf(b.id))];
    expect(seats.map((s) => [s.status, s.paidWith, s.orderLineId])).toEqual([
      ["reserved", "credit", lines[0]!.id],
      ["reserved", "credit", lines[0]!.id],
    ]);
    await paid(data.orderId);
    const after = [...(await seatsOf(a.id)), ...(await seatsOf(b.id))];
    expect(after.map((s) => s.status)).toEqual(["confirmed", "confirmed"]);
    expect(await h.db.select().from(creditEntries).where(inArray(creditEntries.refId, after.map((s) => s.id)))).toHaveLength(2);
  });
});

describe("campaign links (UTM)", () => {
  const utm = { source: "google", medium: "business_profile", campaign: "book_button" };

  it("stores the visit's UTM on the order and on a new person's acquisition", async () => {
    const day = await daySession();
    const input = guest({ utm });
    const data = await checkout({ ...input, sessionId: day.id });
    const [order] = await h.db.select().from(orders).where(eq(orders.id, data.orderId));
    expect(order!.utm).toEqual(utm);
    const [person] = await h.db.select().from(persons).where(eq(persons.email, input.email));
    expect(person!.acquisition).toMatchObject({ source: "website", campaign: "book_button", utm });
  });

  it("never overwrites the acquisition of a person who already exists", async () => {
    const known = await makePerson(h.db, { email: email("known") });
    const before = known.acquisition;
    const data = await checkout({ ...guest({ email: known.email, utm }), sessionId: (await daySession()).id });
    const [order] = await h.db.select().from(orders).where(eq(orders.id, data.orderId));
    expect(order!.utm).toEqual(utm);
    const [after] = await h.db.select().from(persons).where(eq(persons.id, known.id));
    expect(after!.acquisition).toEqual(before);
  });
});
