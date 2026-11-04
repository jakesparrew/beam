import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { emailMessages } from "@beam/db/schema";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import { makeCreditGrant } from "@beam/db/testing/credits-factories";
import { eq, type Actor } from "@/lib/ctx";
import { resetRuntime, staffActor } from "@/lib/testing";
import { createOrder } from "@/modules/commerce/api";
import { getMembershipForPerson } from "@/modules/credits/api";
import { hasValidSubmission } from "@/modules/forms/api";
import { getCurrentLegalVersion, hasAcceptedCurrentTerms } from "@/modules/site/api";
import { confirmBookingsForOrder } from "../api/bookings";
import { bookSeats } from "./book";
import { DAY, customerActor, fakeCreateOrder, fakeSettledCreateOrder, inTx, openSession, sessionProduct, setBookingRules } from "./booking-p3a.fixtures";
import { bookingById, consumesOf, emailByKey, factsOf } from "./booking-p3b.fixtures";
import { addGuestRow, type AddGuestInput } from "./guests";

vi.mock("@/modules/commerce/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), createOrder: vi.fn() }));
vi.mock("@/modules/credits/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), getMembershipForPerson: vi.fn() }));
vi.mock("@/modules/forms/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), hasValidSubmission: vi.fn() }));
vi.mock("@/modules/site/api", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getCurrentLegalVersion: vi.fn(),
  hasAcceptedCurrentTerms: vi.fn(),
  recordTermsAcceptance: vi.fn(),
}));

let h: DbHandle;
let staffUserId: string;

beforeAll(async () => {
  h = await createTestDb();
  staffUserId = (await makeUser(h.db)).id;
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  vi.mocked(createOrder).mockReset().mockImplementation(fakeCreateOrder());
  vi.mocked(getMembershipForPerson).mockReset().mockResolvedValue({
    isMember: false,
    membershipId: null,
    planProductId: null,
    discountPct: 0,
    status: null,
    periodEndAt: null,
    cancelAt: null,
  });
  vi.mocked(hasValidSubmission).mockReset().mockResolvedValue({ valid: false, completedAt: null, expiresAt: null });
  vi.mocked(getCurrentLegalVersion).mockReset().mockResolvedValue(null);
  vi.mocked(hasAcceptedCurrentTerms).mockReset().mockResolvedValue(true);
  await setBookingRules(h.db, { require_emergency_contact_for_nights: false });
});

const FREE = { creditKind: null, creditCost: 0 } as const;
const email = () => `guest-${randomUUID().slice(0, 8)}@example.com`;

/** An owner with a confirmed booking on `session` (free unless `payWith` says otherwise). */
async function ownerOn(session: { id: string }, payWith: "free" | "credit" = "free") {
  const owner = await makePerson(h.db, { firstName: "Ann" });
  if (payWith === "credit") await makeCreditGrant(h.db, { personId: owner.id, units: 5, startsAt: new Date(Date.now() - DAY), expiresAt: new Date(Date.now() + 60 * DAY), sharing: { mode: "guests", max_guest_uses_per_month: 2, allowed_person_ids: [] } });
  const res = await inTx(h.db, customerActor(owner.id), (tx, ctx) => bookSeats(tx, ctx, { sessionId: session.id, personId: owner.id, payWith, clientKey: randomUUID(), source: "portal", by: "customer" }));
  return { owner, ownerBooking: await bookingById(h.db, res.bookingIds[0]!) };
}
const add = (actor: Actor, input: Omit<AddGuestInput, "by">) => inTx(h.db, actor, (tx, ctx) => addGuestRow(tx, ctx, { by: actor.kind === "staff" ? "staff" : "customer", ...input }));

describe("addGuestRow (R54-R56)", () => {
  it("adds a guest with an email: confirmed guest row, guest_added on the owner's timeline, guest_invited once", async () => {
    const session = await openSession(h.db, FREE);
    const { owner, ownerBooking } = await ownerOn(session);
    const guestEmail = email();
    const res = await add(customerActor(owner.id), { ownerBookingId: ownerBooking.id, guest: { firstName: "Bram", lastName: "Gast", email: guestEmail, payWith: "free" } });
    expect(res.kind).toBe("confirmed");
    const guest = await bookingById(h.db, res.bookingId);
    expect(guest).toMatchObject({ status: "confirmed", paidWith: "free", guestOfBookingId: ownerBooking.id, bookedByPersonId: owner.id, capacityUnits: 1 });
    const facts = await factsOf(h.db, guest.id);
    expect(facts.find((f) => f.kind === "booking.guest_added")).toMatchObject({ personId: owner.id, data: { is_guest: true, guest_of_person_id: owner.id } });
    expect(facts.find((f) => f.kind === "booking.confirmed")).toMatchObject({ personId: guest.personId });
    const mail = await emailByKey(h.db, `booking:${guest.id}:confirmed`);
    expect(mail).toMatchObject({ toEmail: guestEmail, props: { ownerFirstName: "Ann" } });
    expect(mail!.attachments).toEqual([{ fileId: (await bookingById(h.db, guest.id)).qrFileId, filename: "checkin-qr.png", inline: true }]);
    // The same guest again: already booked, still one invitation.
    await expect(add(customerActor(owner.id), { ownerBookingId: ownerBooking.id, guest: { firstName: "Bram", lastName: "Gast", email: guestEmail, payWith: "free" } })).rejects.toMatchObject({
      reason: "already_booked",
    });
    expect(await h.db.select().from(emailMessages).where(eq(emailMessages.toEmail, guestEmail))).toHaveLength(1);
  });

  it("an order-paid guest is reserved with a checkout; the invitation goes out once on payment, however often commerce confirms", async () => {
    const product = await sessionProduct(h.db);
    const session = await openSession(h.db, { ...FREE, productId: product.id });
    const owner = await makePerson(h.db, { firstName: "Ann" });
    const ownerRow = await inTx(h.db, staffActor({ userId: staffUserId, permissions: ["bookings.write", "bookings.override"] }), (tx, ctx) =>
      bookSeats(tx, ctx, { sessionId: session.id, personId: owner.id, payWith: "free", reason: "host", clientKey: randomUUID(), source: "admin", by: "staff" }),
    );
    const guestEmail = email();
    const res = await add(customerActor(owner.id), { ownerBookingId: ownerRow.bookingIds[0]!, guest: { firstName: "Cas", lastName: "Gast", email: guestEmail, payWith: "order" } });
    expect(res).toMatchObject({ kind: "checkout", redirectTo: expect.stringMatching(/^\/nl\/account\/checkout\//) });
    if (res.kind !== "checkout") throw new Error("checkout expected");
    const guest = await bookingById(h.db, res.bookingId);
    expect(guest).toMatchObject({ status: "reserved", paidWith: "order" });
    expect(guest.orderLineId).not.toBeNull();
    expect(await emailByKey(h.db, `booking:${guest.id}:confirmed`)).toBeUndefined();
    const system: Actor = { kind: "system", jobId: "test" };
    await inTx(h.db, system, (tx, ctx) => confirmBookingsForOrder(tx, ctx, { orderId: res.orderId }));
    await inTx(h.db, system, (tx, ctx) => confirmBookingsForOrder(tx, ctx, { orderId: res.orderId }));
    expect((await bookingById(h.db, guest.id)).status).toBe("confirmed");
    expect(await h.db.select().from(emailMessages).where(eq(emailMessages.toEmail, guestEmail))).toHaveLength(1);
  });

  it("an order-paid guest whose order commerce settles inside createOrder is confirmed at once, without a reserved fact", async () => {
    const product = await sessionProduct(h.db);
    const session = await openSession(h.db, { ...FREE, productId: product.id });
    const owner = await makePerson(h.db, { firstName: "Ann" });
    const ownerRow = await inTx(h.db, staffActor({ userId: staffUserId, permissions: ["bookings.write", "bookings.override"] }), (tx, ctx) =>
      bookSeats(tx, ctx, { sessionId: session.id, personId: owner.id, payWith: "free", reason: "host", clientKey: randomUUID(), source: "admin", by: "staff" }),
    );
    vi.mocked(createOrder).mockImplementationOnce(fakeSettledCreateOrder());
    const res = await add(customerActor(owner.id), { ownerBookingId: ownerRow.bookingIds[0]!, guest: { firstName: "Dirk", lastName: "Gast", email: email(), payWith: "order" } });
    expect(res.kind).toBe("confirmed");
    const guest = await bookingById(h.db, res.bookingId);
    expect(guest).toMatchObject({ status: "confirmed", paidWith: "order", reservedUntil: null });
    expect(guest.orderLineId).not.toBeNull();
    const kinds = (await factsOf(h.db, guest.id)).map((f) => f.kind);
    expect(kinds).not.toContain("booking.reserved");
    expect(kinds.filter((k) => k === "booking.confirmed")).toHaveLength(1);
    expect(kinds).toContain("booking.guest_added");
    expect(await emailByKey(h.db, `booking:${guest.id}:confirmed`)).toBeDefined();
  });

  it("a guest paid from the owner's shareable credits consumes the owner's grant for the guest", async () => {
    const session = await openSession(h.db);
    const { owner, ownerBooking } = await ownerOn(session, "credit");
    const res = await add(customerActor(owner.id), { ownerBookingId: ownerBooking.id, guest: { firstName: "Dirk", lastName: "Gast", payWith: "guest" } });
    const guest = await bookingById(h.db, res.bookingId);
    const [consume] = await consumesOf(h.db, guest.id);
    expect(consume).toMatchObject({ personId: owner.id, beneficiaryPersonId: guest.personId, quantity: -1 });
  });

  it("respects capacity, max_guests_per_booking and the shared-bed rules", async () => {
    const tiny = await openSession(h.db, { ...FREE, capacitySeats: 1 });
    const a = await ownerOn(tiny);
    await expect(add(customerActor(a.owner.id), { ownerBookingId: a.ownerBooking.id, guest: { firstName: "E", lastName: "Gast", payWith: "free" } })).rejects.toMatchObject({ reason: "session_full" });

    await setBookingRules(h.db, { max_guests_per_booking: 1, require_emergency_contact_for_nights: false });
    const roomy = await openSession(h.db, FREE);
    const b = await ownerOn(roomy);
    await add(customerActor(b.owner.id), { ownerBookingId: b.ownerBooking.id, guest: { firstName: "F", lastName: "Gast", payWith: "free" } });
    await expect(add(customerActor(b.owner.id), { ownerBookingId: b.ownerBooking.id, guest: { firstName: "G", lastName: "Gast", payWith: "free" } })).rejects.toMatchObject({
      code: "validation",
      fields: { guests: "too_many" },
    });

    await setBookingRules(h.db, { require_emergency_contact_for_nights: false });
    await expect(add(customerActor(b.owner.id), { ownerBookingId: b.ownerBooking.id, guest: { firstName: "H", lastName: "Gast", sharesBed: true, payWith: "free" } })).rejects.toMatchObject({
      reason: "shared_bed_limit",
    });
    const night = await openSession(h.db, { kind: "night", capacityBeds: 1, capacitySeats: null, ...FREE, startsAt: new Date(Date.now() + 5 * DAY) });
    const c = await ownerOn(night);
    const sharer = await add(customerActor(c.owner.id), { ownerBookingId: c.ownerBooking.id, guest: { firstName: "I", lastName: "Partner", sharesBed: true, payWith: "free" } });
    expect((await bookingById(h.db, sharer.bookingId)).capacityUnits).toBe(0);
    await expect(add(customerActor(c.owner.id), { ownerBookingId: c.ownerBooking.id, guest: { firstName: "J", lastName: "Partner", sharesBed: true, payWith: "free" } })).rejects.toMatchObject({
      reason: "shared_bed_limit",
    });
  });

  it("only the owner (or staff) adds guests; a free guest of a paid session needs bookings.override", async () => {
    const session = await openSession(h.db);
    const { owner, ownerBooking } = await ownerOn(session, "credit");
    const stranger = await makePerson(h.db);
    await expect(add(customerActor(stranger.id), { ownerBookingId: ownerBooking.id, guest: { firstName: "K", lastName: "Gast", payWith: "free" } })).rejects.toMatchObject({ code: "not_found" });
    await expect(add(customerActor(owner.id), { ownerBookingId: ownerBooking.id, guest: { firstName: "K", lastName: "Gast", payWith: "free" } })).rejects.toMatchObject({ code: "validation" });
    const write = staffActor({ userId: staffUserId, permissions: ["bookings.write"] });
    await expect(add(write, { ownerBookingId: ownerBooking.id, guest: { firstName: "K", lastName: "Gast", payWith: "free" }, reason: "friend" })).rejects.toMatchObject({ code: "validation" });
    const override = staffActor({ userId: staffUserId, permissions: ["bookings.write", "bookings.override"] });
    const res = await add(override, { ownerBookingId: ownerBooking.id, guest: { firstName: "K", lastName: "Gast", payWith: "free" }, reason: "friend" });
    expect(await bookingById(h.db, res.bookingId)).toMatchObject({ paidWith: "free", source: "admin", notes: "friend" });
  });
});
