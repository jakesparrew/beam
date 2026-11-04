import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { activityEvents, bookings, creditEntries, emailMessages, persons, waitlistEntries } from "@beam/db/schema";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import { makeCreditGrant } from "@beam/db/testing/credits-factories";
import { and, asc, eq, type Actor } from "@/lib/ctx";
import { resetRuntime, staffActor } from "@/lib/testing";
import { createOrder } from "@/modules/commerce/api";
import { InsufficientCreditsError, SharingNotAllowedError, getMembershipForPerson } from "@/modules/credits/api";
import * as credits from "@/modules/credits/api";
import { hasValidSubmission } from "@/modules/forms/api";
import { getCurrentLegalVersion, hasAcceptedCurrentTerms, recordTermsAcceptance } from "@/modules/site/api";
import { bookSeats, type BookSeatsInput } from "./book";
import { DAY, customerActor, fakeCreateOrder, inTx, openSession, sessionProduct, setBookingRules, type CreateOrderCall } from "./booking-p3a.fixtures";

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
const orderCalls: CreateOrderCall[] = [];
const TERMS_VERSION = randomUUID();

beforeAll(async () => {
  h = await createTestDb();
  staffUserId = (await makeUser(h.db)).id;
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  orderCalls.length = 0;
  vi.mocked(createOrder).mockReset().mockImplementation(fakeCreateOrder(orderCalls));
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
  vi.mocked(hasAcceptedCurrentTerms).mockReset().mockResolvedValue(false);
  vi.mocked(recordTermsAcceptance).mockReset().mockResolvedValue({ acceptanceId: randomUUID(), created: true });
  await setBookingRules(h.db);
});

const staff = (permissions: string[] = ["bookings.write"]): Actor => staffActor({ userId: staffUserId, permissions });
const grantFor = (personId: string, units: number, over: Parameters<typeof makeCreditGrant>[1] = {}) =>
  makeCreditGrant(h.db, { personId, units, startsAt: new Date(Date.now() - 30 * DAY), expiresAt: new Date(Date.now() + 60 * DAY), ...over });

function book(actor: Actor, input: Partial<BookSeatsInput> & Pick<BookSeatsInput, "sessionId" | "personId" | "payWith">) {
  const by = actor.kind === "staff" ? "staff" : "customer";
  return inTx(h.db, actor, (tx, ctx) => bookSeats(tx, ctx, { clientKey: randomUUID(), source: by === "staff" ? "admin" : "portal", by, ...input }));
}
const rowsOf = (sessionId: string) => h.db.select().from(bookings).where(eq(bookings.sessionId, sessionId)).orderBy(asc(bookings.createdAt));
const eventsOf = (personId: string) =>
  h.db.select({ kind: activityEvents.kind, data: activityEvents.data, dedupeKey: activityEvents.dedupeKey }).from(activityEvents).where(eq(activityEvents.personId, personId)).orderBy(asc(activityEvents.id));

describe("credit bookings (R17)", () => {
  it("tonight path: books with a credit, one consume per grant split with validAt, confirmed, fact and email with the inline QR", async () => {
    const session = await openSession(h.db, { creditCost: 2 });
    const person = await makePerson(h.db);
    const older = await grantFor(person.id, 1, { expiresAt: new Date(Date.now() + 10 * DAY) });
    const newer = await grantFor(person.id, 3);
    const result = await book(customerActor(person.id), { sessionId: session.id, personId: person.id, payWith: "credit" });
    expect(result.kind).toBe("confirmed");
    const [row] = await rowsOf(session.id);
    expect(row).toMatchObject({ status: "confirmed", paidWith: "credit", source: "portal", capacityUnits: 1, bookedByPersonId: person.id });
    expect(row!.checkinCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);
    expect(row!.qrFileId).not.toBeNull();
    const entries = await h.db.select().from(creditEntries).where(and(eq(creditEntries.refId, row!.id), eq(creditEntries.kind, "consume")));
    expect(entries.map((e) => [e.grantId, e.quantity]).sort()).toEqual([[older.id, -1], [newer.id, -1]].sort());
    const facts = await eventsOf(person.id);
    expect(facts.filter((f) => f.kind === "booking.confirmed")).toHaveLength(1);
    expect(facts.find((f) => f.kind === "booking.confirmed")).toMatchObject({
      dedupeKey: `booking:${row!.id}:confirmed:1`,
      data: { session_id: session.id, session_kind: "day", paid_with: "credit", is_guest: false, is_first_booking: true, is_first_visit: true },
    });
    const [mail] = await h.db.select().from(emailMessages).where(eq(emailMessages.idempotencyKey, `booking:${row!.id}:confirmed`));
    expect(mail!.attachments).toEqual([{ fileId: row!.qrFileId, filename: "checkin-qr.png", inline: true }]);
  });

  it("insufficient credits rolls the whole booking back", async () => {
    const session = await openSession(h.db, { creditCost: 2 });
    const person = await makePerson(h.db);
    await grantFor(person.id, 1);
    await expect(book(customerActor(person.id), { sessionId: session.id, personId: person.id, payWith: "credit" })).rejects.toMatchObject({
      code: "conflict",
      reason: "insufficient_credits",
    });
    expect(await rowsOf(session.id)).toHaveLength(0);
  });

  it("maps SharingNotAllowedError to sharing_not_allowed and plain InsufficientCreditsError to insufficient_credits", async () => {
    const session = await openSession(h.db);
    const owner = await makePerson(h.db);
    await grantFor(owner.id, 5);
    await expect(
      book(customerActor(owner.id), { sessionId: session.id, personId: owner.id, payWith: "credit", guests: [{ firstName: "Gast", lastName: "Een", payWith: "guest" }] }),
    ).rejects.toMatchObject({ reason: "sharing_not_allowed" });
    expect(await rowsOf(session.id)).toHaveLength(0);

    const spy = vi.spyOn(credits, "consumeCredits");
    spy.mockRejectedValueOnce(new SharingNotAllowedError("day", 1, 0, "share_limit"));
    await expect(book(customerActor(owner.id), { sessionId: session.id, personId: owner.id, payWith: "credit" })).rejects.toMatchObject({ reason: "sharing_not_allowed" });
    spy.mockRejectedValueOnce(new InsufficientCreditsError("day", 1, 0));
    await expect(book(customerActor(owner.id), { sessionId: session.id, personId: owner.id, payWith: "credit" })).rejects.toMatchObject({ reason: "insufficient_credits" });
    spy.mockRestore();
  });

  it("a shared package: the sharee books for themself with paid_with guest against the owner's grant (R55)", async () => {
    const session = await openSession(h.db);
    const owner = await makePerson(h.db);
    const sharee = await makePerson(h.db);
    const g = await grantFor(owner.id, 5, { sharing: { mode: "guests", max_guest_uses_per_month: 4, allowed_person_ids: [] } });
    await book(customerActor(sharee.id), { sessionId: session.id, personId: sharee.id, payWith: "guest", grantOwnerPersonId: owner.id });
    const [row] = await rowsOf(session.id);
    expect(row).toMatchObject({ personId: sharee.id, paidWith: "guest", status: "confirmed" });
    const [entry] = await h.db.select().from(creditEntries).where(and(eq(creditEntries.refId, row!.id), eq(creditEntries.kind, "consume")));
    expect(entry).toMatchObject({ grantId: g.id, beneficiaryPersonId: sharee.id });
  });
});

describe("order bookings (R18)", () => {
  it("reserves owner and guests first, one quantity-1 item per seat with bookingIds, links lines and returns the checkout URL", async () => {
    const product = await sessionProduct(h.db);
    const session = await openSession(h.db, { productId: product.id, creditKind: null, creditCost: 0 });
    const owner = await makePerson(h.db, { locale: "fr-BE" });
    const result = await book(customerActor(owner.id), {
      sessionId: session.id,
      personId: owner.id,
      payWith: "order",
      locale: "fr-BE",
      guests: [
        { firstName: "Ann", lastName: "Gast", email: `guest-${randomUUID()}@example.com`, payWith: "order" },
        { firstName: "Bob", lastName: "Zonder", payWith: "order" },
      ],
    });
    expect(result.kind).toBe("checkout");
    if (result.kind !== "checkout") return;
    expect(result.redirectTo).toBe(`/fr/account/checkout/${result.orderId}`);
    const rows = await rowsOf(session.id);
    expect(rows).toHaveLength(3);
    expect(orderCalls).toHaveLength(1);
    expect(orderCalls[0]).toMatchObject({ personId: owner.id, channel: "portal", locale: "fr-BE" });
    expect(orderCalls[0]!.items).toEqual(result.bookingIds.map((id) => ({ productId: product.id, quantity: 1, sessionId: session.id, bookingIds: [id] })));
    const owners = rows.filter((r) => r.guestOfBookingId === null);
    expect(owners).toHaveLength(1);
    for (const r of rows) {
      expect(r.status).toBe("reserved");
      expect(r.orderLineId).not.toBeNull();
      expect(r.reservedUntil).not.toBeNull();
      if (r.guestOfBookingId) expect(r.guestOfBookingId).toBe(owners[0]!.id);
    }
    expect(new Set(rows.map((r) => r.orderLineId)).size).toBe(3);
    expect(await h.db.select().from(emailMessages).where(eq(emailMessages.personId, owner.id))).toHaveLength(0);
  });

  it("a double submit with the same clientKey returns the existing checkout", async () => {
    const product = await sessionProduct(h.db);
    const session = await openSession(h.db, { productId: product.id, creditKind: null, creditCost: 0 });
    const owner = await makePerson(h.db);
    const clientKey = randomUUID();
    const first = await book(customerActor(owner.id), { sessionId: session.id, personId: owner.id, payWith: "order", clientKey });
    const second = await book(customerActor(owner.id), { sessionId: session.id, personId: owner.id, payWith: "order", clientKey });
    expect(second).toEqual(first);
    expect(await rowsOf(session.id)).toHaveLength(1);
  });

  it("createOrder failing rolls back the reserved rows (edge case 36)", async () => {
    const product = await sessionProduct(h.db);
    const session = await openSession(h.db, { productId: product.id, creditKind: null, creditCost: 0 });
    const owner = await makePerson(h.db);
    vi.mocked(createOrder).mockRejectedValueOnce(new Error("boom"));
    await expect(book(customerActor(owner.id), { sessionId: session.id, personId: owner.id, payWith: "order" })).rejects.toThrow("boom");
    expect(await rowsOf(session.id)).toHaveLength(0);
  });

  it("staff pay at desk: admin order expiring at ends_at, is_pay_at_desk, confirmation with payAtDesk", async () => {
    const product = await sessionProduct(h.db);
    const session = await openSession(h.db, { productId: product.id });
    const person = await makePerson(h.db);
    const result = await book(staff(), { sessionId: session.id, personId: person.id, payWith: "order", payAtDesk: true });
    expect(result.kind).toBe("checkout");
    if (result.kind === "checkout") expect(result.redirectTo).toBe(`/admin/pos?order=${result.orderId}`);
    expect(orderCalls[0]).toMatchObject({ channel: "admin", expiresAt: session.endsAt });
    const [row] = await rowsOf(session.id);
    expect(row).toMatchObject({ status: "reserved", isPayAtDesk: true, bookedByUserId: staffUserId, source: "admin" });
    expect(row!.reservedUntil!.getTime()).toBe(session.endsAt.getTime());
    const [mail] = await h.db.select().from(emailMessages).where(eq(emailMessages.idempotencyKey, `booking:${row!.id}:confirmed`));
    expect(mail!.props).toMatchObject({ payAtDesk: true });
  });
});

describe("eligibility", () => {
  it("free is refused for customers on a paid session and allowed for staff with override and a reason", async () => {
    const session = await openSession(h.db);
    const person = await makePerson(h.db);
    await expect(book(customerActor(person.id), { sessionId: session.id, personId: person.id, payWith: "free" })).rejects.toMatchObject({ code: "validation" });
    await expect(book(staff(), { sessionId: session.id, personId: person.id, payWith: "free", reason: "gift" })).rejects.toMatchObject({ code: "validation" });
    await expect(book(staff(["bookings.write", "bookings.override"]), { sessionId: session.id, personId: person.id, payWith: "free" })).rejects.toMatchObject({
      code: "validation",
    });
    await book(staff(["bookings.write", "bookings.override"]), { sessionId: session.id, personId: person.id, payWith: "free", reason: "gift" });
    expect((await rowsOf(session.id))[0]).toMatchObject({ paidWith: "free", status: "confirmed", notes: "gift" });
  });

  it("a free session (no credit cost, no product) is bookable free by a customer", async () => {
    const session = await openSession(h.db, { creditKind: null, creditCost: 0 });
    const person = await makePerson(h.db);
    await expect(book(customerActor(person.id), { sessionId: session.id, personId: person.id, payWith: "free" })).resolves.toMatchObject({ kind: "confirmed" });
  });

  it("member-only uses getMembershipForPerson().isMember; a staff status override without membership is refused", async () => {
    const session = await openSession(h.db, { isMemberOnly: true });
    const person = await makePerson(h.db, { statusOverride: "member", statusOverrideReason: "test", statusOverrideAt: new Date() } as never);
    await grantFor(person.id, 2);
    await expect(book(customerActor(person.id), { sessionId: session.id, personId: person.id, payWith: "credit" })).rejects.toMatchObject({ reason: "member_only" });
    expect(getMembershipForPerson).toHaveBeenCalledWith(expect.anything(), person.id);
    vi.mocked(getMembershipForPerson).mockResolvedValue({
      isMember: true,
      membershipId: randomUUID(),
      planProductId: null,
      discountPct: 10,
      status: "active",
      periodEndAt: null,
      cancelAt: null,
    });
    await expect(book(customerActor(person.id), { sessionId: session.id, personId: person.id, payWith: "credit" })).resolves.toMatchObject({ kind: "confirmed" });
  });

  it("closed, cancelled and webinar sessions are refused", async () => {
    const person = await makePerson(h.db);
    await grantFor(person.id, 5);
    const closed = await openSession(h.db, { status: "closed" });
    await expect(book(customerActor(person.id), { sessionId: closed.id, personId: person.id, payWith: "credit" })).rejects.toMatchObject({ reason: "session_closed" });
    const cancelled = await openSession(h.db, { status: "cancelled", cancelReason: "test", cancelledAt: new Date() } as never);
    await expect(book(customerActor(person.id), { sessionId: cancelled.id, personId: person.id, payWith: "credit" })).rejects.toMatchObject({ reason: "session_closed" });
    const webinar = await openSession(h.db, { kind: "event", eventCategory: "webinar", webinarId: randomUUID(), capacitySeats: 0, creditKind: null, creditCost: 0 });
    await expect(book(customerActor(person.id), { sessionId: webinar.id, personId: person.id, payWith: "free" })).rejects.toMatchObject({ reason: "webinar_session" });
  });

  it("a person already booked, or listed twice, is refused with already_booked", async () => {
    const session = await openSession(h.db);
    const person = await makePerson(h.db);
    await grantFor(person.id, 5);
    await book(customerActor(person.id), { sessionId: session.id, personId: person.id, payWith: "credit" });
    await expect(book(customerActor(person.id), { sessionId: session.id, personId: person.id, payWith: "credit" })).rejects.toMatchObject({ reason: "already_booked" });
    const other = await openSession(h.db);
    const email = `dup-${randomUUID()}@example.com`;
    await expect(
      book(staff(["bookings.write", "bookings.override"]), {
        sessionId: other.id,
        personId: person.id,
        payWith: "credit",
        reason: "family",
        guests: [
          { firstName: "A", lastName: "B", email, payWith: "free" },
          { firstName: "A", lastName: "B", email, payWith: "free" },
        ],
      }),
    ).rejects.toMatchObject({ reason: "already_booked" });
  });

  it("two parallel bookings for the last seat: exactly one session_full", async () => {
    const session = await openSession(h.db, { capacitySeats: 1 });
    const a = await makePerson(h.db);
    const b = await makePerson(h.db);
    await grantFor(a.id, 1);
    await grantFor(b.id, 1);
    const results = await Promise.allSettled([
      book(customerActor(a.id), { sessionId: session.id, personId: a.id, payWith: "credit" }),
      book(customerActor(b.id), { sessionId: session.id, personId: b.id, payWith: "credit" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ reason: "session_full" });
    expect(await rowsOf(session.id)).toHaveLength(1);
  });

  it("over capacity only with bookings.override; the row is flagged", async () => {
    const session = await openSession(h.db, { capacitySeats: 1 });
    const a = await makePerson(h.db);
    const b = await makePerson(h.db);
    await grantFor(a.id, 1);
    await grantFor(b.id, 1);
    await book(customerActor(a.id), { sessionId: session.id, personId: a.id, payWith: "credit" });
    await expect(book(customerActor(b.id), { sessionId: session.id, personId: b.id, payWith: "credit" })).rejects.toMatchObject({ reason: "session_full" });
    await expect(book(staff(), { sessionId: session.id, personId: b.id, payWith: "credit", overCapacity: true })).rejects.toMatchObject({ reason: "session_full" });
    await book(staff(["bookings.write", "bookings.override"]), { sessionId: session.id, personId: b.id, payWith: "credit", overCapacity: true, reason: "regular" });
    const rows = await rowsOf(session.id);
    expect(rows.map((r) => r.isOverCapacity)).toEqual([false, true]);
  });
});

describe("guests and shared beds (R13, R54)", () => {
  it("a night guest sharing the bed uses 0 units; a second shared-bed guest is refused; guests are created in crm", async () => {
    const night = await openSession(h.db, { kind: "night", capacityBeds: 2, creditKind: "night" });
    const owner = await makePerson(h.db);
    await grantFor(owner.id, 5, { creditKind: "night", sharing: { mode: "guests", max_guest_uses_per_month: 4, allowed_person_ids: [] } });
    await expect(
      book(customerActor(owner.id), {
        sessionId: night.id,
        personId: owner.id,
        payWith: "credit",
        emergencyContact: { name: "Mama", phone: "+32470000000" },
        guests: [
          { firstName: "A", lastName: "Een", sharesBed: true, payWith: "guest" },
          { firstName: "B", lastName: "Twee", sharesBed: true, payWith: "guest" },
        ],
      }),
    ).rejects.toMatchObject({ reason: "shared_bed_limit" });
    const email = `night-guest-${randomUUID()}@example.com`;
    await book(customerActor(owner.id), {
      sessionId: night.id,
      personId: owner.id,
      payWith: "credit",
      emergencyContact: { name: "Mama", phone: "+32470000000" },
      guests: [{ firstName: "A", lastName: "Een", email, sharesBed: true, payWith: "guest" }],
    });
    const rows = await rowsOf(night.id);
    expect(rows.map((r) => r.capacityUnits).sort()).toEqual([0, 1]);
    const guest = rows.find((r) => r.guestOfBookingId)!;
    expect(guest).toMatchObject({ paidWith: "guest", bookedByPersonId: owner.id, status: "confirmed" });
    const [gp] = await h.db.select().from(persons).where(eq(persons.id, guest.personId));
    expect(gp!.email).toBe(email);
    const [invite] = await h.db.select().from(emailMessages).where(eq(emailMessages.idempotencyKey, `booking:${guest.id}:confirmed`));
    expect(invite!.props).toMatchObject({ ownerFirstName: "Test" });
    const ownerFacts = await eventsOf(owner.id);
    expect(ownerFacts.filter((f) => f.kind === "booking.guest_added")).toHaveLength(1);
  });

  it("shared beds are refused on day sessions", async () => {
    const session = await openSession(h.db);
    const owner = await makePerson(h.db);
    await expect(
      book(customerActor(owner.id), { sessionId: session.id, personId: owner.id, payWith: "credit", guests: [{ firstName: "A", lastName: "B", sharesBed: true, payWith: "guest" }] }),
    ).rejects.toMatchObject({ reason: "shared_bed_limit" });
  });
});

describe("facts, terms, waitlist", () => {
  it("first booking and terms acceptance are recorded once", async () => {
    vi.mocked(getCurrentLegalVersion).mockResolvedValue({ versionId: TERMS_VERSION } as never);
    const person = await makePerson(h.db);
    await grantFor(person.id, 5);
    const s1 = await openSession(h.db);
    const s2 = await openSession(h.db, { startsAt: new Date(Date.now() + 3 * DAY) });
    await expect(book(customerActor(person.id), { sessionId: s1.id, personId: person.id, payWith: "credit" })).rejects.toMatchObject({ reason: "terms_required" });
    await book(customerActor(person.id), { sessionId: s1.id, personId: person.id, payWith: "credit", acceptTerms: true });
    expect(recordTermsAcceptance).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordTermsAcceptance).mock.calls[0]![2]).toMatchObject({ personId: person.id, versionId: TERMS_VERSION, context: "booking", refType: "booking" });
    vi.mocked(hasAcceptedCurrentTerms).mockResolvedValue(true);
    await book(customerActor(person.id), { sessionId: s2.id, personId: person.id, payWith: "credit" });
    expect(recordTermsAcceptance).toHaveBeenCalledTimes(1);
    const confirmed = (await eventsOf(person.id)).filter((e) => e.kind === "booking.confirmed");
    expect(confirmed.map((e) => (e.data as { is_first_booking: boolean }).is_first_booking)).toEqual([true, false]);
  });

  it("staff bookings record no terms acceptance", async () => {
    vi.mocked(getCurrentLegalVersion).mockResolvedValue({ versionId: TERMS_VERSION } as never);
    const person = await makePerson(h.db);
    await grantFor(person.id, 1);
    const session = await openSession(h.db);
    await book(staff(), { sessionId: session.id, personId: person.id, payWith: "credit" });
    expect(recordTermsAcceptance).not.toHaveBeenCalled();
  });

  it("booking a session the person waits for releases the entry with booked_directly", async () => {
    const session = await openSession(h.db);
    const person = await makePerson(h.db);
    await grantFor(person.id, 1);
    const [entry] = await h.db.insert(waitlistEntries).values({ sessionId: session.id, personId: person.id }).returning();
    await book(customerActor(person.id), { sessionId: session.id, personId: person.id, payWith: "credit" });
    const [after] = await h.db.select().from(waitlistEntries).where(eq(waitlistEntries.id, entry!.id));
    expect(after).toMatchObject({ state: "released", endedReason: "booked_directly" });
  });
});

describe("health declaration and emergency contact (R62b)", () => {
  it("require_health_declaration = true refuses a customer day booking; false only notices; staff never blocked", async () => {
    const person = await makePerson(h.db);
    await grantFor(person.id, 5);
    await setBookingRules(h.db, { require_health_declaration: true });
    const s1 = await openSession(h.db);
    await expect(book(customerActor(person.id), { sessionId: s1.id, personId: person.id, payWith: "credit" })).rejects.toMatchObject({
      reason: "health_declaration_required",
    });
    await book(staff(), { sessionId: s1.id, personId: person.id, payWith: "credit" });
    vi.mocked(hasValidSubmission).mockResolvedValue({ valid: true, completedAt: new Date(), expiresAt: null });
    const s2 = await openSession(h.db);
    await expect(book(customerActor(person.id), { sessionId: s2.id, personId: person.id, payWith: "credit" })).resolves.toMatchObject({ kind: "confirmed" });
    await setBookingRules(h.db, { require_health_declaration: false });
    vi.mocked(hasValidSubmission).mockClear().mockResolvedValue({ valid: false, completedAt: null, expiresAt: null });
    const s3 = await openSession(h.db);
    await expect(book(customerActor(person.id), { sessionId: s3.id, personId: person.id, payWith: "credit" })).resolves.toMatchObject({ kind: "confirmed" });
    expect(hasValidSubmission).not.toHaveBeenCalled();
  });

  it("a night booking without emergency contact is refused; with one it is written through updatePersonFields onlyEmpty", async () => {
    const person = await makePerson(h.db);
    await grantFor(person.id, 5, { creditKind: "night" });
    const night = await openSession(h.db, { kind: "night", creditKind: "night" });
    await expect(book(customerActor(person.id), { sessionId: night.id, personId: person.id, payWith: "credit" })).rejects.toMatchObject({
      reason: "emergency_contact_required",
    });
    expect(await rowsOf(night.id)).toHaveLength(0);
    await book(customerActor(person.id), { sessionId: night.id, personId: person.id, payWith: "credit", emergencyContact: { name: "Mama", phone: "+32470000001", relation: "mother" } });
    const [p] = await h.db.select({ c: persons.emergencyContact }).from(persons).where(eq(persons.id, person.id));
    expect(p!.c).toMatchObject({ name: "Mama", phone: "+32470000001" });
    // onlyEmpty: a later contact never overwrites the stored one.
    const night2 = await openSession(h.db, { kind: "night", creditKind: "night", startsAt: new Date(Date.now() + 4 * DAY) });
    await book(customerActor(person.id), { sessionId: night2.id, personId: person.id, payWith: "credit", emergencyContact: { name: "Papa", phone: "+32470000002" } });
    const [p2] = await h.db.select({ c: persons.emergencyContact }).from(persons).where(eq(persons.id, person.id));
    expect(p2!.c).toMatchObject({ name: "Mama" });
  });

  it("staff night bookings without a contact are not blocked", async () => {
    const person = await makePerson(h.db);
    await grantFor(person.id, 1, { creditKind: "night" });
    const night = await openSession(h.db, { kind: "night", creditKind: "night" });
    await expect(book(staff(), { sessionId: night.id, personId: person.id, payWith: "credit" })).resolves.toMatchObject({ kind: "confirmed" });
  });
});
