import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { bookings, ticketTypes } from "@beam/db/schema";
import { createTestDb, makePerson, makeProduct } from "@beam/db/testing";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.10" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));
// `flag()` reads through the app database, which PGlite cannot serve inside the action's transaction.
vi.mock("@/lib/flags", () => ({ flag: vi.fn(), clearFlagCache: vi.fn() }));
vi.mock("@/modules/commerce/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), createOrder: vi.fn() }));
// commerce's api barrel reaches book.ts through its actions; stubbing them keeps createOrder mocked there.
vi.mock("@/modules/commerce/actions", () => ({ redeemVoucher: vi.fn() }));
vi.mock("@/modules/credits/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), getMembershipForPerson: vi.fn() }));
vi.mock("@/modules/forms/api", () => ({ hasValidSubmission: vi.fn() }));
vi.mock("@/modules/site/api", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getCurrentLegalVersion: vi.fn().mockResolvedValue(null),
  hasAcceptedCurrentTerms: vi.fn().mockResolvedValue(true),
  recordTermsAcceptance: vi.fn(),
}));

const { archiveTicketType, upsertTicketType } = await import("./tickets");
const { assertTicketTypesPublishable, bookSeats } = await import("../server/book");
const { eq, setAppDb } = await import("@/lib/ctx");
const { flag } = await import("@/lib/flags");
const { resetRuntime } = await import("@/lib/testing");
const { createOrder } = await import("@/modules/commerce/api");
const { getMembershipForPerson } = await import("@/modules/credits/api");
const { hasValidSubmission } = await import("@/modules/forms/api");
const { clearSchedule, staffSession } = await import("./booking-p2.fixtures");
const { DAY, customerActor, fakeCreateOrder, inTx, openSession, setBookingRules } = await import("../server/booking-p3a.fixtures");

const FULL = { "nl-BE": "Standaard", "fr-BE": "Standard", en: "Standard" };
const validation = { ok: false, error: { code: "validation" } };
let h: DbHandle;
let now: number;

beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  jar.clear();
  now = Date.now();
  await clearSchedule(h.db);
  await setBookingRules(h.db);
  vi.mocked(flag).mockReset().mockResolvedValue(true);
  vi.mocked(createOrder).mockReset().mockImplementation(fakeCreateOrder());
  vi.mocked(getMembershipForPerson).mockReset().mockResolvedValue({ isMember: false, membershipId: null, planProductId: null, discountPct: 0, status: null, periodEndAt: null, cancelAt: null });
  vi.mocked(hasValidSubmission).mockReset().mockResolvedValue({ valid: false, completedAt: null, expiresAt: null });
  await staffSession(h.db, jar, ["bookings.read", "bookings.write", "bookings.override"]);
});

/** A published lecture 20 days (and a quarter) ahead, 30 seats, no credits. */
const event = (over: Parameters<typeof openSession>[1] = {}) =>
  openSession(h.db, { kind: "event", eventCategory: "lecture", creditKind: null, creditCost: 0, capacitySeats: 30, startsAt: new Date(now + 20.25 * DAY), ...over });
const ticketProduct = () => makeProduct(h.db, { kind: "ticket", priceCents: 1500 });
async function ticket(sessionId: string, over: Partial<typeof ticketTypes.$inferInsert> = {}) {
  const [row] = await h.db
    .insert(ticketTypes)
    .values({ sessionId, productId: (await ticketProduct()).id, name: FULL, ...over })
    .returning();
  return row!;
}
/** A customer booking paid by order (the ticket's product), at `at`. */
async function buy(sessionId: string, ticketTypeId: string | undefined, opts: { at?: number; guests?: number; personId?: string } = {}) {
  const personId = opts.personId ?? (await makePerson(h.db)).id;
  const guests = Array.from({ length: opts.guests ?? 0 }, (_, i) => ({ firstName: `Gast${i}`, lastName: "Test", payWith: "order" as const }));
  return inTx(
    h.db,
    customerActor(personId),
    (tx, ctx) => bookSeats(tx, ctx, { sessionId, personId, payWith: "order", ticketTypeId, guests, clientKey: randomUUID(), source: "portal", by: "customer", acceptTerms: true }),
    new Date(opts.at ?? now),
  );
}

describe("upsertTicketType (R50-R52)", () => {
  it("creates and updates a ticket type with a Brussels sales window", async () => {
    const s = await event();
    const productId = (await ticketProduct()).id;
    const res = await upsertTicketType({ sessionId: s.id, productId, name: FULL, capacity: 10, isMemberOnly: true, salesStartAt: "2026-01-10T10:00", maxPerBooking: 2, requiresGuestDetails: true, sortOrder: 1 });
    expect(res).toMatchObject({ ok: true, data: { id: expect.any(String) } });
    const id = res.ok ? res.data.id : "";
    const [row] = await h.db.select().from(ticketTypes).where(eq(ticketTypes.id, id));
    expect(row).toMatchObject({ sessionId: s.id, capacity: 10, isMemberOnly: true, maxPerBooking: 2, sortOrder: 1, isActive: true });
    expect(row!.salesStartAt?.toISOString()).toBe("2026-01-10T09:00:00.000Z"); // CET
    expect(await upsertTicketType({ id, sessionId: s.id, productId, name: FULL, capacity: null, isMemberOnly: false, maxPerBooking: 4, requiresGuestDetails: false, sortOrder: 0 })).toMatchObject({ ok: true, data: { id } });
    expect((await h.db.select().from(ticketTypes).where(eq(ticketTypes.id, id)))[0]).toMatchObject({ capacity: null, isMemberOnly: false, salesStartAt: null });
  });

  it("publish blocked by incomplete names: refused on a published event, flagged by the publish check on a draft", async () => {
    const productId = (await ticketProduct()).id;
    const published = await event();
    const partial = { "nl-BE": "Vroegboeker", en: "Early bird" };
    expect(await upsertTicketType({ sessionId: published.id, productId, name: partial, maxPerBooking: 4, sortOrder: 0 })).toMatchObject({
      ok: false,
      error: { code: "validation", fields: { "name.fr-BE": "missing" } },
    });

    const draft = await event({ publishedAt: null });
    const res = await upsertTicketType({ sessionId: draft.id, productId, name: partial, maxPerBooking: 4, sortOrder: 0 });
    expect(res.ok).toBe(true);
    const id = res.ok ? res.data.id : "";
    await expect(assertTicketTypesPublishable(h.db, draft.id)).rejects.toMatchObject({ code: "validation", fields: { [`ticketTypes.${id}.name.fr-BE`]: "missing" } });
    await upsertTicketType({ id, sessionId: draft.id, productId, name: { ...partial, "fr-BE": "Lève-tôt" }, maxPerBooking: 4, sortOrder: 0 });
    await expect(assertTicketTypesPublishable(h.db, draft.id)).resolves.toBeUndefined();
    // An archived type no longer blocks.
    await upsertTicketType({ id, sessionId: draft.id, productId, name: partial, maxPerBooking: 4, sortOrder: 0 });
    await archiveTicketType({ id });
    await expect(assertTicketTypesPublishable(h.db, draft.id)).resolves.toBeUndefined();
  });

  it("refuses non-events, non-ticket products, reversed windows and a capacity below the rows sold", async () => {
    const productId = (await ticketProduct()).id;
    const day = await openSession(h.db, { startsAt: new Date(now + 3.25 * DAY) });
    expect(await upsertTicketType({ sessionId: day.id, productId, name: FULL, maxPerBooking: 4, sortOrder: 0 })).toMatchObject(validation);
    const s = await event();
    const pkg = await makeProduct(h.db, { kind: "session", priceCents: 1000 });
    expect(await upsertTicketType({ sessionId: s.id, productId: pkg.id, name: FULL, maxPerBooking: 4, sortOrder: 0 })).toMatchObject(validation);
    expect(await upsertTicketType({ sessionId: s.id, productId, name: FULL, salesStartAt: "2026-03-02T10:00", salesEndAt: "2026-03-01T10:00", maxPerBooking: 4, sortOrder: 0 })).toMatchObject(validation);
    expect(await upsertTicketType({ sessionId: s.id, productId, name: FULL, capacity: 31, maxPerBooking: 4, sortOrder: 0 })).toMatchObject(validation);

    const t = await ticket(s.id, { productId, capacity: 5 });
    await buy(s.id, t.id, { guests: 2 });
    expect(await upsertTicketType({ id: t.id, sessionId: s.id, productId, name: FULL, capacity: 2, maxPerBooking: 4, sortOrder: 0 })).toMatchObject({
      ok: false,
      error: { code: "conflict", message: "capacity_below_bookings" },
    });
  });

  it("is behind ff_booking_ticket_types", async () => {
    vi.mocked(flag).mockResolvedValue(false);
    const s = await event();
    expect(await upsertTicketType({ sessionId: s.id, productId: (await ticketProduct()).id, name: FULL, maxPerBooking: 4, sortOrder: 0 })).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });
});

describe("booking with ticket types (R51, R52)", () => {
  it("requires a ticket type on an event with active types and sells the type's product", async () => {
    const s = await event();
    const t = await ticket(s.id);
    await expect(buy(s.id, undefined)).rejects.toMatchObject({ code: "validation", fields: { ticketTypeId: "required" } });
    const res = await buy(s.id, t.id);
    expect(res.kind).toBe("checkout");
    const [row] = await h.db.select().from(bookings).where(eq(bookings.id, res.bookingIds[0]!));
    expect(row).toMatchObject({ ticketTypeId: t.id, status: "reserved", paidWith: "order" });
    expect(vi.mocked(createOrder).mock.calls.at(-1)![2].items).toEqual([expect.objectContaining({ productId: t.productId, sessionId: s.id })]);
  });

  it("sales window: refused before sales_start_at and from sales_end_at, sold inside", async () => {
    const s = await event();
    const t = await ticket(s.id, { salesStartAt: new Date(now + 5 * DAY), salesEndAt: new Date(now + 10 * DAY) });
    await expect(buy(s.id, t.id)).rejects.toMatchObject({ code: "conflict", reason: "not_on_sale" });
    expect((await buy(s.id, t.id, { at: now + 6 * DAY })).kind).toBe("checkout");
    await expect(buy(s.id, t.id, { at: now + 10 * DAY })).rejects.toMatchObject({ reason: "not_on_sale" });
    // Without an end the type sells until the event starts.
    const open = await ticket(s.id, { salesStartAt: null });
    expect((await buy(s.id, open.id, { at: now + 19 * DAY })).kind).toBe("checkout");
    const archived = await ticket(s.id, { isActive: false });
    await expect(buy(s.id, archived.id)).rejects.toMatchObject({ reason: "not_on_sale" });
  });

  it("member-only type: refused for a non-member, sold to a member", async () => {
    const s = await event();
    const t = await ticket(s.id, { isMemberOnly: true });
    await expect(buy(s.id, t.id)).rejects.toMatchObject({ code: "conflict", reason: "member_only" });
    vi.mocked(getMembershipForPerson).mockResolvedValue({ isMember: true, membershipId: randomUUID(), planProductId: null, discountPct: 10, status: "active", periodEndAt: new Date(now + 300 * DAY), cancelAt: null });
    expect((await buy(s.id, t.id)).kind).toBe("checkout");
  });

  it("per-type capacity under the session lock; the session capacity stays the hard limit", async () => {
    const s = await event({ capacitySeats: 4 });
    const t = await ticket(s.id, { capacity: 2 });
    await buy(s.id, t.id);
    await expect(buy(s.id, t.id, { guests: 1 })).rejects.toMatchObject({ code: "conflict", reason: "session_full" });
    await buy(s.id, t.id);
    await expect(buy(s.id, t.id)).rejects.toMatchObject({ reason: "session_full" });
    // Another type shares the session pool: two seats are left of four.
    const other = await ticket(s.id, { capacity: 10 });
    await buy(s.id, other.id, { guests: 1 });
    await expect(buy(s.id, other.id)).rejects.toMatchObject({ reason: "session_full" });
    expect(await h.db.select().from(bookings).where(eq(bookings.sessionId, s.id))).toHaveLength(4);
  });

  it("max_per_booking limits owner plus guests", async () => {
    const s = await event();
    const t = await ticket(s.id, { maxPerBooking: 2 });
    await expect(buy(s.id, t.id, { guests: 2 })).rejects.toMatchObject({ code: "validation", fields: { guests: "max_per_booking:2" } });
    const ok = await buy(s.id, t.id, { guests: 1 });
    expect(ok.bookingIds).toHaveLength(2);
  });

  it("requires_guest_details: a guest without a name is refused", async () => {
    const s = await event();
    const t = await ticket(s.id);
    const personId = (await makePerson(h.db)).id;
    await expect(
      inTx(h.db, customerActor(personId), (tx, ctx) =>
        bookSeats(tx, ctx, { sessionId: s.id, personId, payWith: "order", ticketTypeId: t.id, guests: [{ firstName: " ", lastName: "Test", payWith: "order" }], clientKey: randomUUID(), source: "portal", by: "customer" }),
      ),
    ).rejects.toMatchObject({ code: "validation", fields: { "guests.0.firstName": "required" } });
  });
});
