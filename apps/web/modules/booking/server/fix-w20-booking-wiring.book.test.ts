import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { ticketTypes } from "@beam/db/schema";
import { createTestDb, makePerson, makeProduct } from "@beam/db/testing";

vi.mock("next/server", () => ({ after: () => undefined }));
vi.mock("@/lib/flags", () => ({ flag: vi.fn().mockResolvedValue(true), clearFlagCache: vi.fn() }));
// commerce's api barrel re-exports `redeemVoucher` from its actions, whose import graph reaches booking's
// book.ts: stubbing the actions file keeps that cycle closed, so booking sees the mocked createOrder.
vi.mock("@/modules/commerce/actions", () => ({ redeemVoucher: vi.fn() }));
vi.mock("@/modules/commerce/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), createOrder: vi.fn() }));
vi.mock("@/modules/credits/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), getMembershipForPerson: vi.fn(), checkCredits: vi.fn(), getGuestUsesLeft: vi.fn() }));
vi.mock("@/modules/forms/api", () => ({ hasValidSubmission: vi.fn().mockResolvedValue({ valid: false, completedAt: null, expiresAt: null }) }));
vi.mock("@/modules/site/api", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getCurrentLegalVersion: vi.fn().mockResolvedValue(null),
  hasAcceptedCurrentTerms: vi.fn().mockResolvedValue(true),
  recordTermsAcceptance: vi.fn(),
}));

const { bookSeats, guestUseState } = await import("./book");
const { resetRuntime } = await import("@/lib/testing");
const { createOrder } = await import("@/modules/commerce/api");
const { checkCredits, getGuestUsesLeft, getMembershipForPerson } = await import("@/modules/credits/api");
const { DAY, customerActor, fakeCreateOrder, inTx, openSession, setBookingRules } = await import("./booking-p3a.fixtures");
type Calls = Parameters<typeof fakeCreateOrder>[0];

const FULL = { "nl-BE": "Standaard", "fr-BE": "Standard", en: "Standard" };
let h: DbHandle;
let calls: NonNullable<Calls>;

beforeAll(async () => {
  h = await createTestDb();
  await setBookingRules(h.db);
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(() => {
  calls = [];
  vi.mocked(createOrder).mockReset().mockImplementation(fakeCreateOrder(calls));
  vi.mocked(getMembershipForPerson).mockReset().mockResolvedValue({ isMember: false, membershipId: null, planProductId: null, discountPct: 0, status: null, periodEndAt: null, cancelAt: null });
  vi.mocked(checkCredits).mockReset().mockResolvedValue({ ok: true, parts: [] });
  vi.mocked(getGuestUsesLeft).mockReset().mockResolvedValue(3);
});

describe("bookSeats with a ticket type (commerce-P8 request)", () => {
  it("every order item of a ticket booking carries the ticket type, at the ticket's product", async () => {
    const event = await openSession(h.db, { kind: "event", eventCategory: "lecture", creditKind: null, creditCost: 0, productId: null, startsAt: new Date(Date.now() + 20 * DAY) });
    const product = await makeProduct(h.db, { kind: "ticket", priceCents: 1500 });
    const [tt] = await h.db.insert(ticketTypes).values({ sessionId: event.id, productId: product.id, name: FULL }).returning();
    const person = await makePerson(h.db);
    const res = await inTx(h.db, customerActor(person.id), (tx, ctx) =>
      bookSeats(tx, ctx, {
        sessionId: event.id,
        personId: person.id,
        payWith: "order",
        ticketTypeId: tt!.id,
        guests: [{ firstName: "Gwen", lastName: "Gast", payWith: "order" }],
        clientKey: randomUUID(),
        source: "portal",
        by: "customer",
      }),
    );
    expect(res.kind).toBe("checkout");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.items).toEqual([
      expect.objectContaining({ productId: product.id, quantity: 1, sessionId: event.id, ticketTypeId: tt!.id }),
      expect.objectContaining({ productId: product.id, quantity: 1, sessionId: event.id, ticketTypeId: tt!.id }),
    ]);
  });

  it("a session product booking has no ticket type on its items", async () => {
    const product = await makeProduct(h.db, { kind: "session", priceCents: 2500 });
    const day = await openSession(h.db, { productId: product.id, creditKind: null, creditCost: 0 });
    const person = await makePerson(h.db);
    await inTx(h.db, customerActor(person.id), (tx, ctx) =>
      bookSeats(tx, ctx, { sessionId: day.id, personId: person.id, payWith: "order", clientKey: randomUUID(), source: "portal", by: "customer" }),
    );
    expect(calls[0]!.items[0]).not.toHaveProperty("ticketTypeId");
  });
});

describe("guestUseState (booking-P8 request, R55)", () => {
  it("reads the guest uses left this month from credits when a guest can be paid, and the refusal otherwise", async () => {
    const owner = await makePerson(h.db);
    const session = { creditKind: "day" as const, creditCost: 1, startsAt: new Date(Date.now() + 2 * DAY) };
    const now = new Date();
    expect(await guestUseState(h.db, owner.id, session, now)).toEqual({ allowed: true, usesLeft: 3, reason: null });
    expect(vi.mocked(getGuestUsesLeft)).toHaveBeenCalledWith(h.db, { personId: owner.id, kind: "day", at: now });
    vi.mocked(checkCredits).mockResolvedValue({ ok: false, reason: "not_shareable", available: 0 });
    expect(await guestUseState(h.db, owner.id, session, now)).toEqual({ allowed: false, usesLeft: 0, reason: "not_shareable" });
    expect(await guestUseState(h.db, owner.id, { ...session, creditKind: null }, now)).toBeNull();
  });
});
