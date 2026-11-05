import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { auditLog } from "@beam/db/schema";
import { createTestDb, makeSession, makeUser } from "@beam/db/testing";

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

const actions = await import("./lead");
const { createAuthSession, SESSION_COOKIE } = await import("@/lib/auth");
const { eq, setAppDb } = await import("@/lib/ctx");
const { flag } = await import("@/lib/flags");
const { resetRuntime } = await import("@/lib/testing");
const { clearSchedule, staffSession } = await import("./booking-p2.fixtures");

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
});

const unauthorized = { ok: false, error: { code: "unauthorized" } };
const forbidden = (p: string) => ({ ok: false, error: { code: "forbidden", message: `forbidden: ${p}` } });

/** Every action of the area with a valid input (booking spec 4.2: `configureLeadMagnet` needs `bookings.override`). */
async function call() {
  const s = await makeSession(h.db, { kind: "event", eventCategory: "lecture", creditKind: null, creditCost: 0, capacitySeats: 20, startsAt: new Date("2027-05-10T17:00:00Z") });
  return actions.configureLeadMagnet({
    sessionId: s.id,
    isLeadMagnet: true,
    leadReservedSeats: 5,
    leadWindowStartLocal: "2027-04-20T10:00",
    leadWindowEndLocal: "2027-05-01T10:00",
    releaseRule: "customers_then_public",
    claimWindowMinutes: 120,
    isWaitlistPositionVisible: false,
  });
}

describe("booking actions, area lead: permissions (booking spec 4.2, 7)", () => {
  it("needs a staff session (anonymous and customer sessions are unauthorized)", async () => {
    expect(await call()).toMatchObject(unauthorized);
    const user = await makeUser(h.db, { audience: "customer" });
    const { token } = await createAuthSession(h.db, { userId: user.id, audience: "customer", roleKey: null, now: new Date() });
    jar.set(SESSION_COOKIE, token);
    expect(await call()).toMatchObject(unauthorized);
  });

  it("needs bookings.override (bookings.read and bookings.write are not enough)", async () => {
    await staffSession(h.db, jar, ["bookings.read", "bookings.write", "waitlist.manage", "settings.write"]);
    expect(await call()).toMatchObject(forbidden("bookings.override"));
  });

  it("with bookings.override it succeeds and is audited as booking.configure_lead_magnet", async () => {
    await staffSession(h.db, jar, ["bookings.read", "bookings.override"]);
    expect(await call()).toMatchObject({ ok: true });
    const rows = await h.db.select().from(auditLog).where(eq(auditLog.action, "booking.configure_lead_magnet"));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.entityType).toBe("session");
  });

  it("is forbidden while the flag is off, even with bookings.override", async () => {
    vi.mocked(flag).mockResolvedValue(false);
    await staffSession(h.db, jar, ["bookings.read", "bookings.override"]);
    expect(await call()).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });

  it("asks the flag for the acting staff user (so `testers` turns it on per user)", async () => {
    const user = await staffSession(h.db, jar, ["bookings.read", "bookings.override"]);
    expect(await call()).toMatchObject({ ok: true });
    expect(vi.mocked(flag)).toHaveBeenCalledWith("ff_booking_lead_priority", expect.objectContaining({ kind: "staff", userId: user.id }));
  });
});
