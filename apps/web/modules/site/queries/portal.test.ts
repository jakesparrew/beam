import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makeGrant, makePerson, makeSession } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { bookings, persons } from "@beam/db/schema";
import type * as CreditsApi from "@/modules/credits/api";

vi.mock("next/cache", () => ({ unstable_cache: (fn: (...a: unknown[]) => unknown) => fn, revalidateTag: () => undefined }));

// The credits api runs for real; a test can make one of its functions throw.
const creditSummary = vi.fn<typeof CreditsApi.getPersonCreditSummary>();
vi.mock("@/modules/credits/api", async (importOriginal) => {
  const actual = await importOriginal<typeof CreditsApi>();
  creditSummary.mockImplementation(actual.getPersonCreditSummary);
  return { ...actual, getPersonCreditSummary: (...args: Parameters<typeof actual.getPersonCreditSummary>) => creditSummary(...args) };
});

const { eq, setAppDb } = await import("@/lib/ctx");
const { resetRuntime } = await import("@/lib/testing");
const { getAccountHome, HOME_BOOKINGS_LIMIT } = await import("./portal");

let handle: DbHandle;

beforeAll(async () => {
  handle = await createTestDb();
  setAppDb(handle.db);
});
afterAll(async () => {
  resetRuntime();
  await handle.close();
});
beforeEach(async () => {
  creditSummary.mockClear();
  const actual = await vi.importActual<typeof CreditsApi>("@/modules/credits/api");
  creditSummary.mockImplementation(actual.getPersonCreditSummary);
});

const DAY = 24 * 60 * 60 * 1000;
let offset = 0;
/** A future day session, each one later than the previous. */
async function futureSession(daysAhead?: number) {
  offset += 1;
  return makeSession(handle.db, { startsAt: new Date(Date.now() + (daysAhead ?? offset) * DAY + offset * 60_000) });
}

async function book(personId: string, sessionId: string, extra: Partial<typeof bookings.$inferInsert> = {}) {
  const [row] = await handle.db.insert(bookings).values({ sessionId, personId, status: "confirmed", paidWith: "free", source: "admin", ...extra }).returning();
  return row!;
}

describe("getAccountHome", () => {
  it("shows only the actor's data, the ids merged into it and the guest bookings the person made", async () => {
    const actor = await makePerson(handle.db, { firstName: "Lotte" });
    const mergedAway = await makePerson(handle.db);
    await handle.db.update(persons).set({ mergedIntoPersonId: actor.id }).where(eq(persons.id, mergedAway.id));
    const guest = await makePerson(handle.db, { firstName: "Gust" });
    const stranger = await makePerson(handle.db);

    const s1 = await futureSession();
    const s2 = await futureSession();
    const s3 = await futureSession();
    const own = await book(actor.id, s1.id);
    const fromMerged = await book(mergedAway.id, s2.id);
    const guestBooking = await book(guest.id, s1.id, { bookedByPersonId: actor.id, guestOfBookingId: own.id });
    const foreign = await book(stranger.id, s3.id);

    await makeGrant(handle.db, { personId: actor.id, creditKind: "day", units: 4 });
    await makeGrant(handle.db, { personId: mergedAway.id, creditKind: "day", units: 1 });
    await makeGrant(handle.db, { personId: stranger.id, creditKind: "night", units: 3 });

    const home = await getAccountHome(actor.id, "nl-BE");
    expect(home.firstName).toBe("Lotte");
    expect(home.bookings.ok).toBe(true);
    if (!home.bookings.ok) return;
    const ids = home.bookings.data.map((b) => b.bookingId);
    expect(ids).toEqual(expect.arrayContaining([own.id, fromMerged.id, guestBooking.id]));
    expect(ids).not.toContain(foreign.id);
    expect(home.bookings.data.find((b) => b.bookingId === guestBooking.id)).toMatchObject({ isGuest: true, guestFirstName: "Gust" });
    // Earliest first.
    const starts = home.bookings.data.map((b) => b.startsAt.getTime());
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);

    expect(home.balances).toEqual({ ok: true, data: [expect.objectContaining({ kind: "day", remainingUnits: 5 })] });
    expect(home.membership).toEqual({ ok: true, data: null });
    expect(home.offers).toEqual({ ok: true, data: [] });
  });

  it("shows at most five upcoming bookings, the earliest", async () => {
    const actor = await makePerson(handle.db);
    const made: { id: string; startsAt: Date }[] = [];
    for (let i = 0; i < HOME_BOOKINGS_LIMIT + 2; i++) {
      const s = await futureSession();
      made.push({ id: (await book(actor.id, s.id)).id, startsAt: s.startsAt });
    }
    const home = await getAccountHome(actor.id, "en");
    expect(home.bookings.ok).toBe(true);
    if (!home.bookings.ok) return;
    expect(home.bookings.data).toHaveLength(5);
    const expected = [...made].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime()).slice(0, 5).map((m) => m.id);
    expect(home.bookings.data.map((b) => b.bookingId)).toEqual(expected);
  });

  it("leaves past and cancelled bookings out", async () => {
    const actor = await makePerson(handle.db);
    const past = await makeSession(handle.db, { startsAt: new Date(Date.now() - 2 * DAY) });
    await book(actor.id, past.id);
    const s = await futureSession();
    await book(actor.id, s.id, { status: "cancelled", cancelledAt: new Date(), cancelReasonCode: "customer" });
    const home = await getAccountHome(actor.id, "fr-BE");
    expect(home.bookings).toEqual({ ok: true, data: [] });
  });

  it("a throwing credits api fails the balance card only", async () => {
    const actor = await makePerson(handle.db, { firstName: "Jo" });
    const s = await futureSession();
    const own = await book(actor.id, s.id);
    creditSummary.mockRejectedValue(new Error("credits down"));
    const home = await getAccountHome(actor.id, "nl-BE");
    expect(creditSummary).toHaveBeenCalled();
    expect(home.balances).toEqual({ ok: false });
    expect(home.bookings).toEqual({ ok: true, data: [expect.objectContaining({ bookingId: own.id })] });
    expect(home.membership.ok).toBe(true);
    expect(home.offers.ok).toBe(true);
    expect(home.firstName).toBe("Jo");
  });
});
