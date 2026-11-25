/**
 * Owner's review 8, end to end through the real actions and commerce: a visitor without an account
 * books from the site (`booking.book_as_guest`), the person is found or created by email with name
 * and phone, the seat is held on a `site` order the browser keeps in its viewer cookie, the guest
 * pays it (`commerce.pay_order`, payments fake standing in for Stripe Checkout) and the paid order
 * confirms the seats. Children ride along as their own products; a package bought in the flow pays
 * the seat with one of its credits.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, makeProduct } from "@beam/db/testing";
import { ensureTermsVersion } from "@beam/db/testing/commerce-factories";
import type { DbHandle } from "@beam/db";
import { bookings, creditEntries, creditGrants, orderLines, orders, persons } from "@beam/db/schema";
import { brusselsDate, isoWeekday, zonedTimeToUtc } from "@beam/core/booking";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.44" })),
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

const { bookAsGuest } = await import("./bookings");
const { payOrder } = await import("@/modules/commerce/actions");
const { finalizePaidOrder } = await import("@/modules/commerce/server/paid");
const { createCtx, eq } = await import("@/lib/ctx");
const { makeCtx, resetRuntime, createFakeIntegrations } = await import("@/lib/testing");
const { openSession, setBookingRules, DAY } = await import("../server/booking-p3a.fixtures");

let h: DbHandle;

/** The next Saturday at least two days ahead, as a Brussels date. */
function nextSaturday(): string {
  for (let d = 2; d < 10; d++) {
    const day = brusselsDate(new Date(Date.now() + d * DAY));
    if (isoWeekday(day) === 6) return day;
  }
  throw new Error("no Saturday");
}

beforeAll(async () => {
  h = await createTestDb();
  makeCtx(h.db, { integrations: createFakeIntegrations() });
  await setBookingRules(h.db);
  terms.versionId = (await ensureTermsVersion(h.db)).id;
  await makeProduct(h.db, { kind: "session", sku: "BEAM-DAY-CHILD", priceCents: 0 });
  await makeProduct(h.db, { kind: "session", sku: "BEAM-DAY-YOUTH", priceCents: 6_000 });
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

const paid = (orderId: string) => h.db.transaction((tx) => finalizePaidOrder(tx, createCtx({ tx, actor: { kind: "webhook", provider: "stripe" }, durableMode: "immediate" }), orderId));

describe("booking without an account (owner's review 8)", () => {
  it("books an adult with two children, pays through the viewer cookie and confirms every seat once paid", async () => {
    jar.clear();
    const single = await makeProduct(h.db, { kind: "session", priceCents: 12_000 });
    const session = await openSession(h.db, { kind: "day", startsAt: zonedTimeToUtc(nextSaturday(), "13:00"), productId: single.id, capacitySeats: 14 });
    const email = `guest-${randomUUID().slice(0, 8)}@example.com`;
    const res = await bookAsGuest({
      sessionId: session.id,
      email,
      firstName: "Sofie",
      lastName: "Peeters",
      phone: "+32 470 11 22 33",
      pay: "order",
      children: [
        { firstName: "Mila", ageGroup: "child" },
        { firstName: "Lars", ageGroup: "youth" },
      ],
      acceptTerms: true,
      clientKey: randomUUID(),
    });
    if (!res.ok) throw new Error(JSON.stringify(res.error));
    if (res.data.kind !== "checkout") throw new Error("expected a checkout");
    const { orderId } = res.data;
    expect(res.data.redirectTo).toBe(`/nl/checkout/pay/${orderId}`);

    const [person] = await h.db.select().from(persons).where(eq(persons.email, email));
    expect(person).toMatchObject({ firstName: "Sofie", lastName: "Peeters", phone: "+32 470 11 22 33" });
    const [order] = await h.db.select().from(orders).where(eq(orders.id, orderId));
    expect(order).toMatchObject({ channel: "site", personId: person!.id, totalCents: 18_000, status: "pending_payment" });
    const seats = await h.db.select().from(bookings).where(eq(bookings.sessionId, session.id));
    expect(seats.map((s) => [s.status, s.ageGroup, s.source]).sort()).toEqual(
      [
        ["reserved", "child", "site"],
        ["reserved", null, "site"],
        ["reserved", "youth", "site"],
      ].sort(),
    );

    // Step 2: the browser that booked holds the order (viewer cookie) and pays without signing in.
    expect(jar.get("beam_checkout")).toContain(orderId);
    const pay = await payOrder({ orderId, clientKey: randomUUID(), useEuroCredit: false });
    if (!pay.ok) throw new Error(JSON.stringify(pay.error));
    expect(pay.data.redirectUrl).toMatch(/^https?:\/\//);
    // A browser without the cookie cannot.
    jar.clear();
    expect(await payOrder({ orderId, clientKey: randomUUID(), useEuroCredit: false })).toMatchObject({ ok: false, error: { code: "not_found" } });

    await paid(orderId);
    const after = await h.db.select().from(bookings).where(eq(bookings.sessionId, session.id));
    expect(after.every((b) => b.status === "confirmed")).toBe(true);
  });

  it("buys a package in the flow: the seat takes one of its credits when the order is paid", async () => {
    jar.clear();
    const single = await makeProduct(h.db, { kind: "session", priceCents: 12_000 });
    const session = await openSession(h.db, { kind: "day", productId: single.id, creditKind: "day", creditCost: 1 });
    const pkg = await makeProduct(h.db, { kind: "package", creditKind: "day", creditUnits: 10, validityDays: 548, priceCents: 89_000 });
    const email = `pkg-${randomUUID().slice(0, 8)}@example.com`;
    const res = await bookAsGuest({ sessionId: session.id, email, firstName: "Jan", lastName: "Claes", phone: "0470 99 88 77", pay: "package", packageProductId: pkg.id, acceptTerms: true, clientKey: randomUUID() });
    if (!res.ok) throw new Error(JSON.stringify(res.error));
    if (res.data.kind !== "checkout") throw new Error("expected a checkout");
    const lines = await h.db.select().from(orderLines).where(eq(orderLines.orderId, res.data.orderId));
    expect(lines.map((l) => [l.productKind, l.lineTotalCents])).toEqual([["package", 89_000]]);

    await paid(res.data.orderId);
    const [seat] = await h.db.select().from(bookings).where(eq(bookings.sessionId, session.id));
    expect(seat).toMatchObject({ status: "confirmed", paidWith: "credit", orderLineId: null });
    const [grant] = await h.db.select().from(creditGrants).where(eq(creditGrants.orderLineId, lines[0]!.id));
    expect(grant).toMatchObject({ creditKind: "day", unitsGranted: 10 });
    const used = await h.db.select().from(creditEntries).where(eq(creditEntries.refId, seat!.id));
    expect(used.map((e) => [e.grantId, e.quantity])).toEqual([[grant!.id, -1]]);
  });

  it("asks for email, full name and phone, and refuses children on a session that does not take them", async () => {
    jar.clear();
    const single = await makeProduct(h.db, { kind: "session", priceCents: 12_000 });
    const session = await openSession(h.db, { kind: "day", startsAt: zonedTimeToUtc(nextSaturday(), "10:00"), productId: single.id });
    const missing = await bookAsGuest({ sessionId: session.id, email: "x@example.com", firstName: "", lastName: "", phone: "", pay: "order", acceptTerms: true, clientKey: randomUUID() });
    expect(missing).toMatchObject({ ok: false, error: { code: "validation" } });
    if (missing.ok) return;
    expect(Object.keys(missing.error.fields ?? {})).toEqual(expect.arrayContaining(["firstName", "lastName", "phone"]));

    const kids = await bookAsGuest({
      sessionId: session.id,
      email: `kids-${randomUUID().slice(0, 8)}@example.com`,
      firstName: "An",
      lastName: "Smet",
      phone: "0470 00 00 01",
      pay: "order",
      children: [{ firstName: "Mila", ageGroup: "child" }],
      acceptTerms: true,
      clientKey: randomUUID(),
    });
    expect(kids).toMatchObject({ ok: false, error: { code: "conflict", message: "children_not_allowed" } });
    expect(await h.db.select().from(bookings).where(eq(bookings.sessionId, session.id))).toHaveLength(0);
  });
});
