import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { auditLog, bookings, roles } from "@beam/db/schema";

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
vi.mock("@/modules/site/api", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getCurrentLegalVersion: vi.fn().mockResolvedValue(null),
  hasAcceptedCurrentTerms: vi.fn().mockResolvedValue(true),
  recordTermsAcceptance: vi.fn(),
}));

const actions = await import("./bookings");
const { createAuthSession, SESSION_COOKIE } = await import("@/lib/auth");
const { eq, setAppDb } = await import("@/lib/ctx");
const { resetRuntime } = await import("@/lib/testing");
const { openSession, setBookingRules } = await import("../server/booking-p3a.fixtures");

let handle: DbHandle;

async function asStaff(permissions: string[]) {
  const user = await makeUser(handle.db, { roleKey: "reception" });
  await handle.db.update(roles).set({ permissions }).where(eq(roles.key, "reception"));
  const { token } = await createAuthSession(handle.db, { userId: user.id, audience: "staff", roleKey: "reception", now: new Date(), mfaAt: new Date() });
  jar.set(SESSION_COOKIE, token);
  return user;
}

async function asCustomer() {
  const user = await makeUser(handle.db, { audience: "customer" });
  const { token } = await createAuthSession(handle.db, { userId: user.id, audience: "customer", roleKey: null, now: new Date() });
  jar.set(SESSION_COOKIE, token);
  return user;
}

/** A free session (no credit, no product): bookable `free` by anyone. */
const freeSession = (over: Parameters<typeof openSession>[1] = {}) => openSession(handle.db, { creditKind: null, creditCost: 0, ...over });

beforeAll(async () => {
  handle = await createTestDb();
  setAppDb(handle.db);
  await setBookingRules(handle.db);
});
afterAll(async () => {
  resetRuntime();
  await handle.close();
});
beforeEach(() => jar.clear());

const forbidden = { ok: false, error: { code: "forbidden" } };
const unauthorized = { ok: false, error: { code: "unauthorized" } };

describe("booking actions, area bookings: permissions (booking spec 4.2, 7)", () => {
  it("bookSession is for customers only", async () => {
    const session = await freeSession();
    const input = { sessionId: session.id, payWith: "free", clientKey: randomUUID() };
    expect(await actions.bookSession(input)).toMatchObject(unauthorized);
    // A staff session is not a customer session (`action()` resolves no actor for the audience).
    await asStaff(["*"]);
    expect(await actions.bookSession(input)).toMatchObject(unauthorized);
    const customer = await asCustomer();
    const ok = await actions.bookSession(input);
    expect(ok).toMatchObject({ ok: true, data: { kind: "confirmed" } });
    const rows = await handle.db.select().from(bookings).where(eq(bookings.sessionId, session.id));
    expect(rows).toMatchObject([{ personId: customer.personId, source: "portal" }]);
  });

  it("createManualBooking needs bookings.write; over capacity needs bookings.override; the write is audited", async () => {
    const session = await freeSession({ capacitySeats: 1 });
    const person = await makePerson(handle.db);
    const input = { sessionId: session.id, personId: person.id, payWith: "free", clientKey: randomUUID() };
    expect(await actions.createManualBooking(input)).toMatchObject(unauthorized);
    await asCustomer();
    expect(await actions.createManualBooking(input)).toMatchObject(unauthorized);
    await asStaff(["bookings.read"]);
    expect(await actions.createManualBooking(input)).toMatchObject(forbidden);
    await asStaff(["bookings.write"]);
    const ok = await actions.createManualBooking(input);
    expect(ok.ok).toBe(true);
    const bookingId = ok.ok ? ok.data.bookingIds[0]! : "";
    const [audit] = await handle.db.select().from(auditLog).where(eq(auditLog.entityId, bookingId));
    expect(audit).toMatchObject({ action: "booking.create_manual", entityType: "booking" });

    const other = await makePerson(handle.db);
    const over = { sessionId: session.id, personId: other.id, payWith: "free", overCapacity: true, reason: "regular guest", clientKey: randomUUID() };
    expect(await actions.createManualBooking(over)).toMatchObject(forbidden);
    await asStaff(["bookings.write", "bookings.override"]);
    expect(await actions.createManualBooking(over)).toMatchObject({ ok: true });
  });

  it("a free booking of a paid session by staff needs bookings.override", async () => {
    const session = await openSession(handle.db);
    const person = await makePerson(handle.db);
    const input = { sessionId: session.id, personId: person.id, payWith: "free", reason: "gift", clientKey: randomUUID() };
    await asStaff(["bookings.write"]);
    expect(await actions.createManualBooking(input)).toMatchObject({ ok: false, error: { code: "validation" } });
    await asStaff(["bookings.write", "bookings.override"]);
    expect(await actions.createManualBooking(input)).toMatchObject({ ok: true });
  });
});
