import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { bookings, ticketTypes } from "@beam/db/schema";
import { createTestDb, makePerson, makeProduct } from "@beam/db/testing";
import type { SharedPackage } from "@/modules/credits/api";
import { resetRuntime } from "@/lib/testing";
import { DAY, openSession, setBookingRules } from "../server/booking-p3a.fixtures";

vi.mock("@/lib/auth", () => ({ requirePermission: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/modules/credits/api", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  checkCredits: vi.fn(),
  getGuestUsesLeft: vi.fn(),
  listGrantsSharedWith: vi.fn(),
  getMembershipForPerson: vi.fn(),
}));

const { getBookableSession, listBookings } = await import("./bookings");
const { listManualBookingSessions } = await import("./attendance");
const { checkCredits, getGuestUsesLeft, getMembershipForPerson, listGrantsSharedWith } = await import("@/modules/credits/api");

const FULL = { "nl-BE": "Standaard", "fr-BE": "Standard", en: "Standard" };
let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
  await setBookingRules(h.db);
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(() => {
  vi.mocked(checkCredits).mockReset().mockResolvedValue({ ok: true, parts: [] });
  vi.mocked(getGuestUsesLeft).mockReset().mockResolvedValue(2);
  vi.mocked(listGrantsSharedWith).mockReset().mockResolvedValue([]);
  vi.mocked(getMembershipForPerson).mockReset().mockResolvedValue({ isMember: false, membershipId: null, planProductId: null, discountPct: 0, status: null, periodEndAt: null, cancelAt: null });
});

const at = (days: number) => new Date(Date.now() + days * DAY);

function shared(over: Partial<SharedPackage> = {}): SharedPackage {
  return {
    grantId: randomUUID(),
    kind: "day",
    source: "purchase",
    status: "active",
    productName: null,
    label: null,
    remainingUnits: 5,
    baseUnits: 10,
    startsAt: at(-10),
    expiresAt: at(60),
    statusChangedAt: at(-10),
    shareId: randomUUID(),
    ownerName: "Anna D.",
    maxUnits: null,
    usedByMe: 0,
    unitsForMe: 5,
    ...over,
  };
}

describe("getBookableSession (booking-P8 and booking-P6 requests)", () => {
  it("offers an event's active ticket types with their state, and order payment through them", async () => {
    const person = await makePerson(h.db);
    const event = await openSession(h.db, { kind: "event", eventCategory: "lecture", creditKind: null, creditCost: 0, productId: null, startsAt: at(20) });
    const product = await makeProduct(h.db, { kind: "ticket", priceCents: 1500 });
    const add = async (over: Partial<typeof ticketTypes.$inferInsert>) =>
      (await h.db.insert(ticketTypes).values({ sessionId: event.id, productId: product.id, name: FULL, ...over }).returning())[0]!;
    const open = await add({ sortOrder: 0, capacity: 3 });
    const later = await add({ sortOrder: 1, salesStartAt: at(5) });
    const members = await add({ sortOrder: 2, isMemberOnly: true });
    const soldOut = await add({ sortOrder: 3, capacity: 1 });
    await add({ sortOrder: 4, isActive: false });
    await h.db.insert(bookings).values({ sessionId: event.id, personId: (await makePerson(h.db)).id, status: "confirmed", paidWith: "free", source: "admin", ticketTypeId: soldOut.id });

    const view = await getBookableSession(h.db, person.id, event.id);
    expect(view.ticketTypes.map((t) => [t.id, t.state, t.left])).toEqual([
      [open.id, "on_sale", 3],
      [later.id, "not_yet", null],
      [members.id, "members_only", null],
      [soldOut.id, "sold_out", 0],
    ]);
    expect(view.payOptions).toEqual(["order"]);

    vi.mocked(getMembershipForPerson).mockResolvedValue({ isMember: true, membershipId: randomUUID(), planProductId: null, discountPct: 0, status: "active", periodEndAt: at(30), cancelAt: null });
    expect((await getBookableSession(h.db, person.id, event.id)).ticketTypes.find((t) => t.id === members.id)!.state).toBe("on_sale");
  });

  it("a session without ticket types keeps its own payment options and an empty list", async () => {
    const person = await makePerson(h.db);
    const day = await openSession(h.db, { startsAt: at(3) });
    const view = await getBookableSession(h.db, person.id, day.id);
    expect(view.ticketTypes).toEqual([]);
    expect(view.payOptions).toEqual(["credit"]);
  });

  it("reports the guest uses left this month from credits and the packages shared with the person that cover the session", async () => {
    const person = await makePerson(h.db);
    const day = await openSession(h.db, { startsAt: at(3), creditCost: 2 });
    const covering = shared({ unitsForMe: 2 });
    vi.mocked(listGrantsSharedWith).mockResolvedValue([
      covering,
      shared({ unitsForMe: 1 }),
      shared({ kind: "night" }),
      shared({ expiresAt: at(1) }),
      shared({ startsAt: at(5) }),
    ]);
    const view = await getBookableSession(h.db, person.id, day.id);
    expect(view.guestUses).toEqual({ allowed: true, usesLeft: 2, reason: null });
    expect(view.sharedPackages).toEqual([{ grantId: covering.grantId, ownerName: "Anna D.", unitsForMe: 2, productName: null, expiresAt: covering.expiresAt }]);
    expect(vi.mocked(listGrantsSharedWith)).toHaveBeenCalledWith(h.db, person.id);

    vi.mocked(checkCredits).mockResolvedValue({ ok: false, reason: "guest_limit", available: 0 });
    expect((await getBookableSession(h.db, person.id, day.id)).guestUses).toEqual({ allowed: false, usesLeft: 0, reason: "guest_limit" });
  });
});

describe("listBookings filters (booking-P4 request)", () => {
  it("filters on paidWith and source", async () => {
    const s = await openSession(h.db, { startsAt: at(4) });
    const add = async (paidWith: "credit" | "free", source: "portal" | "admin" | "import") =>
      (await h.db.insert(bookings).values({ sessionId: s.id, personId: (await makePerson(h.db)).id, status: "confirmed", paidWith, source }).returning())[0]!;
    const a = await add("credit", "portal");
    const b = await add("free", "admin");
    const c = await add("free", "import");
    const ids = async (input: Parameters<typeof listBookings>[1]) => (await listBookings(h.db, { sessionId: s.id, ...input })).rows.map((r) => r.id).sort();
    expect(await ids({ paidWith: "free" })).toEqual([b.id, c.id].sort());
    expect(await ids({ source: "portal" })).toEqual([a.id]);
    expect(await ids({ paidWith: "free", source: "import" })).toEqual([c.id]);
    expect(await ids({})).toEqual([a.id, b.id, c.id].sort());
  });
});

describe("listManualBookingSessions ticket types (booking-P8 request)", () => {
  it("lists an event's ticket types for staff (members-only types are on sale for staff)", async () => {
    const event = await openSession(h.db, { kind: "event", eventCategory: "concert", creditKind: null, creditCost: 0, productId: null, startsAt: at(30) });
    const product = await makeProduct(h.db, { kind: "ticket", priceCents: 2000 });
    const [tt] = await h.db.insert(ticketTypes).values({ sessionId: event.id, productId: product.id, name: FULL, isMemberOnly: true }).returning();
    const rows = await listManualBookingSessions(h.db, { from: at(29), to: at(31) });
    const row = rows.find((r) => r.id === event.id)!;
    expect(row.ticketTypes.map((t) => [t.id, t.state])).toEqual([[tt!.id, "on_sale"]]);
    expect(rows.filter((r) => r.kind !== "event").every((r) => r.ticketTypes.length === 0)).toBe(true);
  });
});
