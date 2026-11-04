import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { bookings, roles, waitlistEntries } from "@beam/db/schema";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.20" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));
vi.mock("@/modules/credits/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), getMembershipForPerson: vi.fn() }));
vi.mock("@/modules/site/api", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getCurrentLegalVersion: vi.fn().mockResolvedValue(null),
  hasAcceptedCurrentTerms: vi.fn().mockResolvedValue(true),
  recordTermsAcceptance: vi.fn(),
}));

const actions = await import("./waitlist");
const { createAuthSession, SESSION_COOKIE } = await import("@/lib/auth");
const { eq, setAppDb } = await import("@/lib/ctx");
const { resetRuntime } = await import("@/lib/testing");
const { getMembershipForPerson } = await import("@/modules/credits/api");
const { setBookingRules } = await import("../server/booking-p3a.fixtures");
const { entry, entryById, fullSession, offeredEntry } = await import("../server/booking-p5.fixtures");

let h: DbHandle;

async function asStaff(permissions: string[]) {
  const user = await makeUser(h.db, { roleKey: "reception" });
  await h.db.update(roles).set({ permissions }).where(eq(roles.key, "reception"));
  const { token } = await createAuthSession(h.db, { userId: user.id, audience: "staff", roleKey: "reception", now: new Date(), mfaAt: new Date() });
  jar.set(SESSION_COOKIE, token);
}

async function asCustomer() {
  const user = await makeUser(h.db, { audience: "customer" });
  const { token } = await createAuthSession(h.db, { userId: user.id, audience: "customer", roleKey: null, now: new Date() });
  jar.set(SESSION_COOKIE, token);
  return { personId: user.personId! };
}

const forbidden = { ok: false, error: { code: "forbidden" } };
const unauthorized = { ok: false, error: { code: "unauthorized" } };

beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
  await setBookingRules(h.db);
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(() => {
  jar.clear();
  vi.mocked(getMembershipForPerson)
    .mockReset()
    .mockResolvedValue({ isMember: false, membershipId: null, planProductId: null, discountPct: 0, status: null, periodEndAt: null, cancelAt: null });
});

describe("booking actions, area waitlist: permissions (booking spec 4.2, 7)", () => {
  it("joinWaitlist and withdrawFromWaitlist are for customers only", async () => {
    const { session } = await fullSession(h.db);
    expect(await actions.joinWaitlist({ sessionId: session.id })).toMatchObject(unauthorized);
    await asStaff(["*"]);
    expect(await actions.joinWaitlist({ sessionId: session.id })).toMatchObject(unauthorized);
    await asCustomer();
    const joined = await actions.joinWaitlist({ sessionId: session.id });
    expect(joined).toMatchObject({ ok: true });
    const entryId = joined.ok ? joined.data.entryId : "";
    jar.clear();
    expect(await actions.withdrawFromWaitlist({ entryId })).toMatchObject(unauthorized);
  });

  it("a customer can only withdraw or decline their own entry", async () => {
    const { session } = await fullSession(h.db);
    const someoneElse = await entry(h.db, session.id);
    await asCustomer();
    expect(await actions.withdrawFromWaitlist({ entryId: someoneElse.id })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await actions.declineOffer({ entryId: someoneElse.id })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect((await entryById(h.db, someoneElse.id)).state).toBe("waiting");
  });

  it("claimSeat and declineOffer by token are public: the token proves the person", async () => {
    const { session } = await fullSession(h.db, { overrides: { creditKind: null, creditCost: 0, productId: null } });
    await h.db.update(bookings).set({ status: "cancelled", cancelledAt: new Date(), cancelReasonCode: "customer" }).where(eq(bookings.sessionId, session.id));
    const person = await makePerson(h.db);
    const { entry: offer, token } = await offeredEntry(h.db, session.id, { personId: person.id });
    const res = await actions.claimSeat({ token });
    expect(res).toMatchObject({ ok: true, data: { kind: "confirmed" } });
    const [row] = await h.db.select().from(bookings).where(eq(bookings.personId, person.id));
    expect(row).toMatchObject({ source: "waitlist", status: "confirmed" });
    expect((await entryById(h.db, offer.id)).state).toBe("confirmed");
    expect(await actions.claimSeat({ token: "x".repeat(43) })).toMatchObject({ ok: false, error: { code: "conflict", message: "outside_window" } });

    const { entry: other, token: otherToken } = await offeredEntry(h.db, session.id);
    expect(await actions.declineOffer({ token: otherToken })).toMatchObject({ ok: true, data: { state: "released" } });
    expect((await entryById(h.db, other.id)).endedReason).toBe("declined");
  });

  const staffCases = [
    ["addToWaitlist", "booking.waitlist_add"],
    ["offerSeatManually", "booking.waitlist_offer"],
    ["moveWaitlistEntry", "booking.waitlist_move"],
    ["releaseWaitlistEntry", "booking.waitlist_release"],
    ["reviewWaitlistFlag", "booking.waitlist_review_flag"],
  ] as const;

  it.each(staffCases)("%s needs a staff session with waitlist.manage", async (name) => {
    const { session } = await fullSession(h.db);
    const person = await makePerson(h.db);
    const e = await entry(h.db, session.id, { isFlaggedDuplicate: true, flagReason: "same_phone:x" });
    const input = {
      addToWaitlist: { sessionId: session.id, personId: person.id },
      offerSeatManually: { entryId: e.id },
      moveWaitlistEntry: { entryId: e.id, queue: "customer" },
      releaseWaitlistEntry: { entryId: e.id, reason: "staff decision" },
      reviewWaitlistFlag: { entryId: e.id, decision: "clear", note: "checked" },
    }[name];
    const call = actions[name] as (raw: unknown) => Promise<{ ok: boolean }>;
    expect(await call(input)).toMatchObject(unauthorized);
    await asCustomer();
    expect(await call(input)).toMatchObject(unauthorized);
    await asStaff(["bookings.read", "bookings.write"]);
    expect(await call(input)).toMatchObject(forbidden);
    await asStaff(["waitlist.manage", "bookings.override"]);
    expect(await call(input)).toMatchObject({ ok: true });
  });

  it("offerSeatManually needs a free place unless the actor holds bookings.override", async () => {
    const { session } = await fullSession(h.db);
    const e = await entry(h.db, session.id);
    await asStaff(["waitlist.manage"]);
    expect(await actions.offerSeatManually({ entryId: e.id })).toMatchObject({ ok: false, error: { code: "conflict", message: "session_full" } });
    await asStaff(["waitlist.manage", "bookings.override"]);
    expect(await actions.offerSeatManually({ entryId: e.id })).toMatchObject({ ok: true });
  });

  it("adding a non-member to a member-only session needs bookings.override", async () => {
    const { session } = await fullSession(h.db, { overrides: { isMemberOnly: true } });
    const person = await makePerson(h.db);
    await asStaff(["waitlist.manage"]);
    expect(await actions.addToWaitlist({ sessionId: session.id, personId: person.id })).toMatchObject({ ok: false, error: { code: "conflict", message: "member_only" } });
    await asStaff(["waitlist.manage", "bookings.override"]);
    expect(await actions.addToWaitlist({ sessionId: session.id, personId: person.id })).toMatchObject({ ok: true });
    const [row] = await h.db.select().from(waitlistEntries).where(eq(waitlistEntries.personId, person.id));
    expect(row).toMatchObject({ state: "waiting", joinIpHash: null });
  });
});
