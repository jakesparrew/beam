import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { auditLog, bookings, persons, roles, sessions, waitlistEntries } from "@beam/db/schema";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import { deriveIpSalt, hashIp, normaliseEmail } from "@beam/core/booking";

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
vi.mock("@/modules/credits/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), getMembershipForPerson: vi.fn() }));
vi.mock("@/modules/crm/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), getPersonStatus: vi.fn() }));
vi.mock("@/modules/site/api", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getCurrentLegalVersion: vi.fn().mockResolvedValue(null),
  hasAcceptedCurrentTerms: vi.fn().mockResolvedValue(true),
  recordTermsAcceptance: vi.fn(),
}));

const actions = await import("./waitlist");
const { createAuthSession, SESSION_COOKIE } = await import("@/lib/auth");
const { createCtx, eq, setAppDb } = await import("@/lib/ctx");
const { resetRuntime } = await import("@/lib/testing");
const { getMembershipForPerson } = await import("@/modules/credits/api");
const { getPersonStatus } = await import("@/modules/crm/api");
const { openSession, setBookingRules } = await import("../server/booking-p3a.fixtures");
const { rawBooking } = await import("../server/booking-p3b.fixtures");
const { DAY, HOUR, emailByKey, entry, entryById, entryFacts, fullSession, offerNextJobs, offeredEntry } = await import("../server/booking-p5.fixtures");
const { joinWaitlistRow } = await import("../server/claim");

let h: DbHandle;

async function asStaff(permissions: string[]) {
  const user = await makeUser(h.db, { roleKey: "customer_service" });
  await h.db.update(roles).set({ permissions }).where(eq(roles.key, "customer_service"));
  const { token } = await createAuthSession(h.db, { userId: user.id, audience: "staff", roleKey: "customer_service", now: new Date(), mfaAt: new Date() });
  jar.set(SESSION_COOKIE, token);
  return user;
}

async function asCustomer(personOverrides: Partial<typeof persons.$inferInsert> = {}) {
  const user = await makeUser(h.db, { audience: "customer" });
  if (Object.keys(personOverrides).length) await h.db.update(persons).set(personOverrides).where(eq(persons.id, user.personId!));
  const { token } = await createAuthSession(h.db, { userId: user.id, audience: "customer", roleKey: null, now: new Date() });
  jar.set(SESSION_COOKIE, token);
  return { userId: user.id, personId: user.personId! };
}

const member = (isMember: boolean) => ({ isMember, membershipId: null, planProductId: null, discountPct: 0, status: isMember ? ("active" as const) : null, periodEndAt: null, cancelAt: null });
const conflict = (reason: string) => ({ ok: false, error: { code: "conflict", message: reason } });

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
  await setBookingRules(h.db);
  vi.mocked(getMembershipForPerson).mockReset().mockResolvedValue(member(false));
  vi.mocked(getPersonStatus).mockReset().mockResolvedValue({ status: "customer", derivedStatus: "customer", override: null, hasActiveMembership: false } as never);
});

describe("joinWaitlist (R40, R62)", () => {
  it("joins only a full, open session; the join is a fact and a waitlist_joined email", async () => {
    const notFull = await openSession(h.db, { capacitySeats: 3 });
    const me = await asCustomer();
    expect(await actions.joinWaitlist({ sessionId: notFull.id })).toMatchObject(conflict("invalid_transition"));

    const { session } = await fullSession(h.db);
    const res = await actions.joinWaitlist({ sessionId: session.id });
    expect(res).toMatchObject({ ok: true, data: { queue: "public" } });
    const entryId = res.ok ? res.data.entryId : "";
    expect(await entryById(h.db, entryId)).toMatchObject({ personId: me.personId, state: "waiting", rejoinCount: 0, isFlaggedDuplicate: false });
    expect((await entryFacts(h.db, entryId)).map((f) => f.kind)).toEqual(["waitlist.joined"]);
    expect(await emailByKey(h.db, `waitlist:${entryId}:joined:0`)).toBeDefined();

    const closed = (await fullSession(h.db)).session;
    await h.db.update(sessions).set({ status: "closed" }).where(eq(sessions.id, closed.id));
    expect(await actions.joinWaitlist({ sessionId: closed.id })).toMatchObject(conflict("session_closed"));
  });

  it("refuses a member-only session for a non-member (membership, not crm status)", async () => {
    const { session } = await fullSession(h.db, { overrides: { isMemberOnly: true } });
    await asCustomer();
    expect(await actions.joinWaitlist({ sessionId: session.id })).toMatchObject(conflict("member_only"));
    vi.mocked(getMembershipForPerson).mockResolvedValue(member(true));
    expect(await actions.joinWaitlist({ sessionId: session.id })).toMatchObject({ ok: true });
  });

  it("the same person cannot join twice, nor hold a seat and an entry", async () => {
    const { session } = await fullSession(h.db);
    const me = await asCustomer();
    expect(await actions.joinWaitlist({ sessionId: session.id })).toMatchObject({ ok: true });
    expect(await actions.joinWaitlist({ sessionId: session.id })).toMatchObject(conflict("already_waiting"));

    const other = (await fullSession(h.db, { seats: 2 })).session;
    await rawBooking(h.db, { sessionId: other.id, personId: me.personId });
    expect(await actions.joinWaitlist({ sessionId: other.id })).toMatchObject(conflict("already_booked"));
  });

  it("allows one rejoin after withdrawing, then answers already_waiting", async () => {
    const { session } = await fullSession(h.db);
    await asCustomer();
    const first = await actions.joinWaitlist({ sessionId: session.id });
    const entryId = first.ok ? first.data.entryId : "";
    expect(await actions.withdrawFromWaitlist({ entryId })).toMatchObject({ ok: true, data: { state: "withdrawn" } });
    expect(await actions.joinWaitlist({ sessionId: session.id })).toMatchObject({ ok: true, data: { entryId } });
    expect(await entryById(h.db, entryId)).toMatchObject({ state: "waiting", rejoinCount: 1, endedReason: null });
    expect(await emailByKey(h.db, `waitlist:${entryId}:joined:1`)).toBeDefined();
    await actions.withdrawFromWaitlist({ entryId });
    expect(await actions.joinWaitlist({ sessionId: session.id })).toMatchObject(conflict("already_waiting"));
  });
});

describe("duplicate protection (R48, edge cases 15 and 16)", () => {
  it("flags a secondary address (gmail variant) and a shared phone; the flagged entry waits without offers", async () => {
    const { session, bookingIds } = await fullSession(h.db);
    const first = await makePerson(h.db, { email: "j.doe+beam@gmail.com", phone: "0470 12 34 56" });
    const firstEntry = await entry(h.db, session.id, { personId: first.id, emailNormalised: normaliseEmail(first.email!) });
    await asCustomer({ email: "jdoe@googlemail.com", phone: "+32470123456" });
    const res = await actions.joinWaitlist({ sessionId: session.id });
    const entryId = res.ok ? res.data.entryId : "";
    const flagged = await entryById(h.db, entryId);
    expect(flagged.isFlaggedDuplicate).toBe(true);
    expect(flagged.flagReason).toContain(`same_normalised_email:${firstEntry.id}`);
    expect(flagged.flagReason).toContain(`same_phone:${firstEntry.id}`);
    expect((await entryFacts(h.db, entryId)).map((f) => f.kind)).toEqual(["waitlist.joined", "waitlist.flagged"]);
    expect(bookingIds).toHaveLength(1);
  });

  it("uses the IP signal in the lead queue only when ctx.ip is set", async () => {
    vi.mocked(getPersonStatus).mockResolvedValue({ status: "lead", derivedStatus: "lead", override: null, hasActiveMembership: false } as never);
    const { session } = await fullSession(h.db, {
      overrides: { kind: "event", eventCategory: "lecture", creditKind: null, creditCost: 0, isLeadMagnet: true, leadWindowStartAt: new Date(Date.now() - HOUR), leadWindowEndAt: new Date(Date.now() + DAY) },
    });
    const ipHash = hashIp("192.0.2.10", deriveIpSalt(process.env.AUTH_SECRET!));
    const earlier = await entry(h.db, session.id, { queue: "lead", joinIpHash: ipHash });
    const join = (ip: string | null) =>
      h.db.transaction(async (tx) => {
        const person = await makePerson(tx);
        const ctx = createCtx({ tx, actor: { kind: "customer", userId: person.id, personId: person.id }, ip, durableMode: "immediate" });
        return joinWaitlistRow(tx, ctx, { sessionId: session.id, personId: person.id, by: "customer" });
      });
    const withoutIp = await join(null);
    expect(withoutIp).toMatchObject({ queue: "lead", isFlagged: false });
    expect((await entryById(h.db, withoutIp.entryId)).joinIpHash).toBeNull();
    const withIp = await join("192.0.2.10");
    expect(withIp.isFlagged).toBe(true);
    expect((await entryById(h.db, withIp.entryId)).flagReason).toContain(`same_ip:${earlier.id}`);
  });
});

describe("staff waitlist actions (R49, blueprint 56)", () => {
  it("are audited with their booking.waitlist_* names", async () => {
    const { session, bookingIds } = await fullSession(h.db, { seats: 2 });
    await h.db.update(bookings).set({ status: "cancelled", cancelledAt: new Date(), cancelReasonCode: "customer" }).where(eq(bookings.id, bookingIds[0]!));
    await asStaff(["waitlist.manage", "bookings.read"]);
    const person = await makePerson(h.db, { email: null });
    const added = await actions.addToWaitlist({ sessionId: session.id, personId: person.id });
    expect(added).toMatchObject({ ok: true });
    const entryId = added.ok ? added.data.entryId : "";
    expect(await actions.moveWaitlistEntry({ entryId, queue: "customer" })).toMatchObject({ ok: true });
    expect(await actions.offerSeatManually({ entryId })).toMatchObject({ ok: true });
    expect((await entryById(h.db, entryId)).state).toBe("offered");
    expect(await actions.releaseWaitlistEntry({ entryId, reason: "phoned, cannot come" })).toMatchObject({ ok: true, data: { state: "released" } });
    expect(await entryById(h.db, entryId)).toMatchObject({ endedReason: "staff" });

    const flagged = await entry(h.db, session.id, { isFlaggedDuplicate: true, flagReason: "same_phone:x" });
    expect(await actions.reviewWaitlistFlag({ entryId: flagged.id, decision: "clear", note: "different people" })).toMatchObject({ ok: true, data: { isFlagged: false } });
    const other = await entry(h.db, session.id, { isFlaggedDuplicate: true, flagReason: "same_phone:y" });
    expect(await actions.reviewWaitlistFlag({ entryId: other.id, decision: "withdraw", note: "same person" })).toMatchObject({ ok: true, data: { state: "withdrawn" } });
    expect(await entryById(h.db, other.id)).toMatchObject({ endedReason: "flag_withdrawn" });

    const audited = (await h.db.select({ action: auditLog.action, entityId: auditLog.entityId }).from(auditLog)).filter((a) => [entryId, flagged.id, other.id].includes(a.entityId ?? ""));
    expect(audited.map((a) => a.action).sort()).toEqual(
      ["booking.waitlist_add", "booking.waitlist_move", "booking.waitlist_offer", "booking.waitlist_release", "booking.waitlist_review_flag", "booking.waitlist_review_flag"].sort(),
    );
    expect((await offerNextJobs(h.db, session.id)).length).toBeGreaterThan(0);
  });

  it("refuses every change of a confirmed entry with protected_seat", async () => {
    const { session } = await fullSession(h.db, { seats: 2 });
    const person = await makePerson(h.db);
    const booking = await rawBooking(h.db, { sessionId: session.id, personId: person.id, source: "waitlist" });
    const { entry: seat } = await offeredEntry(h.db, session.id, { personId: person.id, bookingId: booking.id });
    await h.db.update(waitlistEntries).set({ state: "confirmed" }).where(eq(waitlistEntries.id, seat.id));
    await asStaff(["waitlist.manage", "bookings.override"]);
    expect(await actions.releaseWaitlistEntry({ entryId: seat.id, reason: "x" })).toMatchObject(conflict("protected_seat"));
    expect(await actions.moveWaitlistEntry({ entryId: seat.id, queue: "lead" })).toMatchObject(conflict("protected_seat"));
    expect(await actions.offerSeatManually({ entryId: seat.id })).toMatchObject(conflict("protected_seat"));
    expect(await actions.reviewWaitlistFlag({ entryId: seat.id, decision: "withdraw", note: "x" })).toMatchObject(conflict("protected_seat"));
    expect((await entryById(h.db, seat.id)).state).toBe("confirmed");
  });
});

describe("declineOffer (R46)", () => {
  it("releases the offer with declined (by token, no sign-in) and passes the seat on", async () => {
    const { session } = await fullSession(h.db);
    const { entry: offer, token } = await offeredEntry(h.db, session.id);
    expect(await actions.declineOffer({ token })).toMatchObject({ ok: true, data: { state: "released" } });
    expect(await entryById(h.db, offer.id)).toMatchObject({ state: "released", endedReason: "declined" });
    expect((await offerNextJobs(h.db, session.id)).map((j) => j.idempotencyKey)).toContain(`waitlist:${session.id}:offer_next:${offer.id}:1`);
  });
});
