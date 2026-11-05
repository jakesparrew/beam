import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { sessions } from "@beam/db/schema";
import { createTestDb, makeSession } from "@beam/db/testing";

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
// `flag()` reads through the app database, which PGlite cannot serve while the action's
// transaction holds its only connection: the flag is mocked (on by default).
vi.mock("@/lib/flags", () => ({ flag: vi.fn(), clearFlagCache: vi.fn() }));

const { configureLeadMagnet } = await import("./lead");
const { eq, setAppDb } = await import("@/lib/ctx");
const { flag } = await import("@/lib/flags");
const { resetRuntime } = await import("@/lib/testing");
const { clearSchedule, staffSession } = await import("./booking-p2.fixtures");

const DAY = 86_400_000;
let h: DbHandle;

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
  await clearSchedule(h.db);
  vi.mocked(flag).mockReset().mockResolvedValue(true);
  await staffSession(h.db, jar, ["bookings.read", "bookings.write", "bookings.override"]);
});

/** An event far enough ahead for every window below (capacity 30). */
const event = (over: Parameters<typeof makeSession>[1] = {}) =>
  makeSession(h.db, { kind: "event", eventCategory: "lecture", creditKind: null, creditCost: 0, capacitySeats: 30, startsAt: new Date("2027-04-10T17:00:00Z"), ...over });
const read = async (id: string) => (await h.db.select().from(sessions).where(eq(sessions.id, id)))[0]!;
const base = { isLeadMagnet: true, leadWindowStartLocal: "2027-03-20T10:00", leadWindowEndLocal: "2027-04-01T10:00", releaseRule: "customers_then_public" as const, claimWindowMinutes: 120, isWaitlistPositionVisible: false };

describe("configureLeadMagnet: percentage rounding (booking spec 4.2)", () => {
  it("rounds a percentage of the capacity down", async () => {
    const s = await event();
    expect(await configureLeadMagnet({ sessionId: s.id, ...base, leadReservedPct: 15 })).toMatchObject({ ok: true }); // 4.5 -> 4
    expect((await read(s.id)).leadReservedSeats).toBe(4);
    await configureLeadMagnet({ sessionId: s.id, ...base, leadReservedPct: 33.4 }); // 10.02 -> 10
    expect((await read(s.id)).leadReservedSeats).toBe(10);
    await configureLeadMagnet({ sessionId: s.id, ...base, leadReservedPct: 10 }); // exactly 3, no float drift to 2
    expect((await read(s.id)).leadReservedSeats).toBe(3);
    await configureLeadMagnet({ sessionId: s.id, ...base, leadReservedPct: 100 });
    expect((await read(s.id)).leadReservedSeats).toBe(30);
  });

  it("takes a number of places as given and stores the rule, claim window and position flag", async () => {
    const s = await event();
    const res = await configureLeadMagnet({ sessionId: s.id, ...base, leadReservedSeats: 7, releaseRule: "keep_for_leads", claimWindowMinutes: 60, isWaitlistPositionVisible: true });
    expect(res).toEqual({ ok: true, data: { sessionId: s.id } });
    expect(await read(s.id)).toMatchObject({ isLeadMagnet: true, leadReservedSeats: 7, leadReleaseRule: "keep_for_leads", claimWindowMinutes: 60, isWaitlistPositionVisible: true, publicReleaseAt: null });
  });
});

describe("configureLeadMagnet: Brussels wall clock to UTC across DST", () => {
  it("converts a window that starts in winter time and ends in summer time", async () => {
    const s = await event();
    // 2027-03-28 is the spring change: 10:00 CET = 09:00Z on the 27th, 10:00 CEST = 08:00Z on the 29th.
    await configureLeadMagnet({ sessionId: s.id, ...base, leadReservedSeats: 5, leadWindowStartLocal: "2027-03-27T10:00", leadWindowEndLocal: "2027-03-29T10:00", publicReleaseLocal: "2027-03-29T12:30" });
    const row = await read(s.id);
    expect(row.leadWindowStartAt?.toISOString()).toBe("2027-03-27T09:00:00.000Z");
    expect(row.leadWindowEndAt?.toISOString()).toBe("2027-03-29T08:00:00.000Z");
    expect(row.publicReleaseAt?.toISOString()).toBe("2027-03-29T10:30:00.000Z");
  });

  it("converts autumn times back to UTC+1", async () => {
    const s = await event({ startsAt: new Date("2027-11-10T18:00:00Z") });
    // 2027-10-31 is the autumn change: 09:00 CEST = 07:00Z on the 30th, 09:00 CET = 08:00Z on 1 November.
    await configureLeadMagnet({ sessionId: s.id, ...base, leadReservedSeats: 5, leadWindowStartLocal: "2027-10-30T09:00", leadWindowEndLocal: "2027-11-01T09:00" });
    const row = await read(s.id);
    expect(row.leadWindowStartAt?.toISOString()).toBe("2027-10-30T07:00:00.000Z");
    expect(row.leadWindowEndAt?.toISOString()).toBe("2027-11-01T08:00:00.000Z");
  });
});

describe("configureLeadMagnet: validation (edge case 26)", () => {
  const validation = { ok: false, error: { code: "validation" } };

  it("refuses a window that ends before it starts, in the past or after the event starts", async () => {
    const s = await event();
    expect(await configureLeadMagnet({ sessionId: s.id, ...base, leadReservedSeats: 5, leadWindowStartLocal: "2027-04-02T10:00", leadWindowEndLocal: "2027-04-01T10:00" })).toMatchObject(validation);
    const past = new Date(Date.now() - DAY).toISOString().slice(0, 16);
    expect(await configureLeadMagnet({ sessionId: s.id, ...base, leadReservedSeats: 5, leadWindowStartLocal: "2020-01-01T10:00", leadWindowEndLocal: past })).toMatchObject(validation);
    expect(await configureLeadMagnet({ sessionId: s.id, ...base, leadReservedSeats: 5, leadWindowEndLocal: "2027-04-12T10:00" })).toMatchObject(validation);
    expect((await read(s.id)).isLeadMagnet).toBe(false);
  });

  it("refuses missing or double seat inputs, seats above capacity and a window without times", async () => {
    const s = await event();
    expect(await configureLeadMagnet({ sessionId: s.id, ...base })).toMatchObject(validation);
    expect(await configureLeadMagnet({ sessionId: s.id, ...base, leadReservedSeats: 2, leadReservedPct: 10 })).toMatchObject(validation);
    expect(await configureLeadMagnet({ sessionId: s.id, ...base, leadReservedSeats: 31 })).toMatchObject(validation);
    expect(await configureLeadMagnet({ sessionId: s.id, ...base, leadReservedPct: 120 })).toMatchObject(validation);
    const { leadWindowStartLocal: _s, ...noStart } = base;
    expect(await configureLeadMagnet({ sessionId: s.id, ...noStart, leadReservedSeats: 2 })).toMatchObject(validation);
    expect(await configureLeadMagnet({ sessionId: s.id, ...base, leadReservedSeats: 2, leadWindowEndLocal: "2027-04-01 10:00" })).toMatchObject(validation);
  });

  it("refuses a public opening before the window end, and day sessions as Lead Magnets", async () => {
    const s = await event();
    expect(await configureLeadMagnet({ sessionId: s.id, ...base, leadReservedSeats: 2, publicReleaseLocal: "2027-03-31T10:00" })).toMatchObject(validation);
    const day = await makeSession(h.db, { startsAt: new Date("2027-04-10T08:00:00Z") });
    expect(await configureLeadMagnet({ sessionId: day.id, ...base, leadReservedSeats: 2 })).toMatchObject(validation);
  });

  it("switches a Lead Magnet off without window inputs and clears its reserved seats", async () => {
    const s = await event();
    await configureLeadMagnet({ sessionId: s.id, ...base, leadReservedSeats: 6 });
    const res = await configureLeadMagnet({ sessionId: s.id, isLeadMagnet: false, releaseRule: "public", claimWindowMinutes: 120, isWaitlistPositionVisible: false });
    expect(res).toMatchObject({ ok: true });
    expect(await read(s.id)).toMatchObject({ isLeadMagnet: false, leadReservedSeats: 0 });
  });

  it("is refused while ff_booking_lead_priority is off", async () => {
    vi.mocked(flag).mockResolvedValue(false);
    const s = await event();
    expect(await configureLeadMagnet({ sessionId: s.id, ...base, leadReservedSeats: 2 })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect((await read(s.id)).isLeadMagnet).toBe(false);
  });
});
