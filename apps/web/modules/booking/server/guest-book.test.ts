/**
 * Owner's review 1 and 8: booking without an account and children's tickets, through `bookSeats`.
 * - Children are guest rows of a paying adult, only on the Saturday 13:00 day session and on
 *   nights, each sold as the child (free) or youth product and taking a seat.
 * - A site guest books as the public: a `site` order priced as the public's, no euro credit, the
 *   public pay page; credits need a package bought in the same order.
 * - A package bought in the booking flow: the seat waits `reserved` on the package line, takes one
 *   credit when the order is paid (`confirmOrderBookings`) and is released when it is not.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { bookings, creditEntries, orderLines, products } from "@beam/db/schema";
import { createTestDb, makePerson, makeProduct } from "@beam/db/testing";
import { makeCreditGrant } from "@beam/db/testing/credits-factories";
import { brusselsDate, isoWeekday, zonedTimeToUtc } from "@beam/core/booking";
import { asc, eq, type Actor } from "@/lib/ctx";
import { resetRuntime } from "@/lib/testing";
import { createOrder } from "@/modules/commerce/api";
import { getMembershipForPerson } from "@/modules/credits/api";
import { bookSeats, type BookSeatsInput } from "./book";
import { DAY, customerActor, fakeCreateOrder, inTx, openSession, sessionProduct, setBookingRules, type CreateOrderCall } from "./booking-p3a.fixtures";
import { confirmOrderBookings, releaseOrderBookings } from "./order-hooks";

vi.mock("@/modules/commerce/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), createOrder: vi.fn() }));
vi.mock("@/modules/commerce/actions", () => ({ redeemVoucher: vi.fn() }));
vi.mock("@/modules/credits/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), getMembershipForPerson: vi.fn() }));
vi.mock("@/modules/site/api", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getCurrentLegalVersion: vi.fn().mockResolvedValue(null),
  hasAcceptedCurrentTerms: vi.fn().mockResolvedValue(true),
  recordTermsAcceptance: vi.fn(),
}));

let h: DbHandle;
const orderCalls: CreateOrderCall[] = [];
const system: Actor = { kind: "system", jobId: "" };
const publicActor: Actor = { kind: "public" };
const noMembership = { isMember: false, membershipId: null, planProductId: null, discountPct: 0, status: null, periodEndAt: null, cancelAt: null };
let childProducts: { dayChild: string; dayYouth: string };

/** A Brussels date at least `minDays` ahead that is the ISO weekday `weekday` (6 = Saturday). */
function nextWeekday(weekday: number, minDays = 2): string {
  for (let d = minDays; d < minDays + 8; d++) {
    const day = brusselsDate(new Date(Date.now() + d * DAY));
    if (isoWeekday(day) === weekday) return day;
  }
  throw new Error("no day found");
}

beforeAll(async () => {
  h = await createTestDb();
  await setBookingRules(h.db);
  const dayChild = await makeProduct(h.db, { kind: "session", sku: "BEAM-DAY-CHILD", priceCents: 0 });
  const dayYouth = await makeProduct(h.db, { kind: "session", sku: "BEAM-DAY-YOUTH", priceCents: 6000 });
  childProducts = { dayChild: dayChild.id, dayYouth: dayYouth.id };
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(() => {
  orderCalls.length = 0;
  vi.mocked(createOrder).mockReset().mockImplementation(fakeCreateOrder(orderCalls));
  vi.mocked(getMembershipForPerson).mockReset().mockResolvedValue(noMembership);
});

const book = (actor: Actor, input: Omit<BookSeatsInput, "clientKey" | "source" | "by"> & Partial<Pick<BookSeatsInput, "source" | "by">>) =>
  inTx(h.db, actor, (tx, ctx) => bookSeats(tx, ctx, { clientKey: randomUUID(), source: "portal", by: "customer", ...input }));

async function saturdayAt(time: string, capacitySeats = 10) {
  const product = await sessionProduct(h.db, 12_000);
  return openSession(h.db, { kind: "day", startsAt: zonedTimeToUtc(nextWeekday(6), time), productId: product.id, capacitySeats });
}

const kids = [
  { firstName: "Mila", lastName: "Peeters", payWith: "order" as const, ageGroup: "child" as const },
  { firstName: "Lars", lastName: "Peeters", payWith: "order" as const, ageGroup: "youth" as const },
];

describe("children (owner's review 1.1, 1.2)", () => {
  it("books children as seated guests of the adult, each sold as its own product", async () => {
    const session = await saturdayAt("13:00");
    const adult = await makePerson(h.db);
    const result = await book(customerActor(adult.id), { sessionId: session.id, personId: adult.id, payWith: "order", guests: kids });
    expect(result.kind).toBe("checkout");
    const rows = await h.db.select().from(bookings).where(eq(bookings.sessionId, session.id)).orderBy(asc(bookings.createdAt));
    expect(rows).toHaveLength(3);
    const [owner, ...children] = rows;
    expect(owner).toMatchObject({ ageGroup: null, guestOfBookingId: null, status: "reserved" });
    expect(children.map((c) => [c.ageGroup, c.guestOfBookingId, c.capacityUnits, c.paidWith])).toEqual([
      ["child", owner!.id, 1, "order"],
      ["youth", owner!.id, 1, "order"],
    ]);
    expect(orderCalls[0]!.items.map((i) => i.productId)).toEqual([session.productId, childProducts.dayChild, childProducts.dayYouth]);
  });

  it("refuses children on other day sessions, without a paying adult, or when the session has no room for them", async () => {
    const adult = await makePerson(h.db);
    const morning = await saturdayAt("10:00");
    await expect(book(customerActor(adult.id), { sessionId: morning.id, personId: adult.id, payWith: "order", guests: kids })).rejects.toMatchObject({ message: "children_not_allowed" });
    const friday = await openSession(h.db, { kind: "day", startsAt: zonedTimeToUtc(nextWeekday(5), "13:00"), productId: morning.productId });
    await expect(book(customerActor(adult.id), { sessionId: friday.id, personId: adult.id, payWith: "order", guests: kids })).rejects.toMatchObject({ message: "children_not_allowed" });

    const small = await saturdayAt("13:00", 2);
    await expect(book(customerActor(adult.id), { sessionId: small.id, personId: adult.id, payWith: "order", guests: kids })).rejects.toMatchObject({ code: "conflict", message: "session_full" });
    expect(await h.db.select().from(bookings).where(eq(bookings.sessionId, small.id))).toHaveLength(0);
  });

  it("refuses when the child products are not on sale", async () => {
    const session = await saturdayAt("13:00");
    const adult = await makePerson(h.db);
    await h.db.update(products).set({ isActive: false }).where(eq(products.id, childProducts.dayYouth));
    try {
      await expect(book(customerActor(adult.id), { sessionId: session.id, personId: adult.id, payWith: "order", guests: kids })).rejects.toMatchObject({ message: "children_not_available" });
    } finally {
      await h.db.update(products).set({ isActive: true }).where(eq(products.id, childProducts.dayYouth));
    }
  });
});

describe("site guest booking (owner's review 8)", () => {
  it("creates a site order priced as the public's, without euro credit, paid on the public pay page", async () => {
    const product = await sessionProduct(h.db);
    const session = await openSession(h.db, { productId: product.id });
    const person = await makePerson(h.db);
    const result = await book(publicActor, { sessionId: session.id, personId: person.id, payWith: "order", useEuroCredit: true, guest: true, source: "site", locale: "en" });
    if (result.kind !== "checkout") throw new Error("expected a checkout");
    expect(result.redirectTo).toBe(`/en/checkout/pay/${result.orderId}`);
    expect(orderCalls[0]).toMatchObject({ channel: "site", pricingPersonId: null, useEuroCredit: false, personId: person.id });
    const [row] = await h.db.select().from(bookings).where(eq(bookings.id, result.bookingIds[0]!));
    expect(row).toMatchObject({ status: "reserved", source: "site" });
  });

  it("books as the public: no member-only session, no own credits", async () => {
    const member = await makePerson(h.db);
    vi.mocked(getMembershipForPerson).mockResolvedValue({ ...noMembership, isMember: true });
    const product = await sessionProduct(h.db);
    const membersOnly = await openSession(h.db, { productId: product.id, isMemberOnly: true });
    await expect(book(publicActor, { sessionId: membersOnly.id, personId: member.id, payWith: "order", guest: true, source: "site" })).rejects.toMatchObject({ message: "member_only" });
    const session = await openSession(h.db, { productId: product.id });
    await makeCreditGrant(h.db, { personId: member.id, units: 3 });
    await expect(book(publicActor, { sessionId: session.id, personId: member.id, payWith: "credit", guest: true, source: "site" })).rejects.toMatchObject({ message: "pay_with_not_available" });
  });
});

describe("a package bought in the booking flow (owner's review 3)", () => {
  async function setup() {
    const single = await sessionProduct(h.db);
    const session = await openSession(h.db, { productId: single.id, creditKind: "day", creditCost: 1 });
    const pkg = await makeProduct(h.db, { kind: "package", creditKind: "day", creditUnits: 5, validityDays: 548, priceCents: 49_500 });
    const person = await makePerson(h.db);
    const result = await book(publicActor, { sessionId: session.id, personId: person.id, payWith: "credit", buyPackageProductId: pkg.id, guest: true, source: "site" });
    if (result.kind !== "checkout") throw new Error("expected a checkout");
    return { session, pkg, person, result };
  }

  it("holds the seat on the package line and takes one of its credits once the order is paid", async () => {
    const { pkg, person, result } = await setup();
    expect(orderCalls[0]!.items).toEqual([{ productId: pkg.id, quantity: 1 }]);
    const [held] = await h.db.select().from(bookings).where(eq(bookings.id, result.bookingIds[0]!));
    const [line] = await h.db.select().from(orderLines).where(eq(orderLines.orderId, result.orderId));
    expect(held).toMatchObject({ status: "reserved", paidWith: "credit", orderLineId: line!.id });
    expect(await h.db.select().from(creditEntries).where(eq(creditEntries.refId, held!.id))).toHaveLength(0);

    // The paid transaction grants the package's credits, then booking's hook confirms the seat.
    const grant = await makeCreditGrant(h.db, { personId: person.id, creditKind: "day", units: 5, startsAt: new Date(Date.now() - DAY) });
    const out = await inTx(h.db, system, (tx, ctx) => confirmOrderBookings(tx, ctx, result.orderId));
    expect(out.confirmedBookingIds).toEqual([held!.id]);
    const [after] = await h.db.select().from(bookings).where(eq(bookings.id, held!.id));
    expect(after).toMatchObject({ status: "confirmed", orderLineId: null, reservedUntil: null });
    const consumed = await h.db.select().from(creditEntries).where(eq(creditEntries.refId, held!.id));
    expect(consumed.map((e) => [e.grantId, e.quantity])).toEqual([[grant.id, -1]]);
    // A second run changes nothing.
    expect((await inTx(h.db, system, (tx, ctx) => confirmOrderBookings(tx, ctx, result.orderId))).confirmedBookingIds).toEqual([]);
  });

  it("releases the held seat when the order ends unpaid", async () => {
    const { result } = await setup();
    const out = await inTx(h.db, system, (tx, ctx) => releaseOrderBookings(tx, ctx, { orderId: result.orderId, reason: "payment_expired" }));
    expect(out.releasedBookingIds).toEqual([result.bookingIds[0]]);
    const [row] = await h.db.select().from(bookings).where(eq(bookings.id, result.bookingIds[0]!));
    expect(row).toMatchObject({ status: "cancelled", cancelReasonCode: "payment_expired" });
  });

  it("refuses a package of the other kind (day and night are never mixed)", async () => {
    const single = await sessionProduct(h.db);
    const session = await openSession(h.db, { productId: single.id, creditKind: "day", creditCost: 1 });
    const nights = await makeProduct(h.db, { kind: "package", creditKind: "night", creditUnits: 3, validityDays: 548, priceCents: 126_000 });
    const person = await makePerson(h.db);
    await expect(book(publicActor, { sessionId: session.id, personId: person.id, payWith: "credit", buyPackageProductId: nights.id, guest: true, source: "site" })).rejects.toMatchObject({
      message: "package_not_for_session",
    });
  });
});
