import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makeUser } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { auditLog, roles } from "@beam/db/schema";

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

const actions = await import("./attendance");
const { createAuthSession, SESSION_COOKIE } = await import("@/lib/auth");
const { eq, setAppDb, sql } = await import("@/lib/ctx");
const { resetRuntime } = await import("@/lib/testing");
const { HOUR, openSession, setBookingRules } = await import("../server/booking-p3a.fixtures");
const { bookingById, rawBooking } = await import("../server/booking-p3b.fixtures");

let h: DbHandle;

async function asStaff(permissions: string[]) {
  const user = await makeUser(h.db, { roleKey: "reception" });
  await h.db.update(roles).set({ permissions }).where(eq(roles.key, "reception"));
  const { token } = await createAuthSession(h.db, { userId: user.id, audience: "staff", roleKey: "reception", now: new Date(), mfaAt: new Date() });
  jar.set(SESSION_COOKIE, token);
  return user;
}

async function asCustomer() {
  const user = await makeUser(h.db, { audience: "customer" });
  const { token } = await createAuthSession(h.db, { userId: user.id, audience: "customer", roleKey: null, now: new Date() });
  jar.set(SESSION_COOKIE, token);
  return user;
}

beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
  await setBookingRules(h.db);
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(() => jar.clear());

const forbidden = { ok: false, error: { code: "forbidden" } };
const unauthorized = { ok: false, error: { code: "unauthorized" } };

/** A confirmed row of a session that started 30 minutes ago, and an ended session's attended and no-show rows. */
async function rows() {
  const running = await openSession(h.db, { startsAt: new Date(Date.now() - 30 * 60_000) });
  const ended = await openSession(h.db, { startsAt: new Date(Date.now() - 3 * HOUR) });
  return {
    confirmed: await rawBooking(h.db, { sessionId: running.id }),
    attended: await rawBooking(h.db, { sessionId: running.id, status: "attended", attendedAt: new Date() }),
    noShow: await rawBooking(h.db, { sessionId: ended.id, status: "no_show", noShowMarkedAt: new Date() }),
    late: await rawBooking(h.db, { sessionId: (await openSession(h.db, { startsAt: new Date(Date.now() - 6 * HOUR) })).id }),
  };
}

type Call = [name: string, run: (r: Awaited<ReturnType<typeof rows>>) => Promise<unknown>];
const calls: Call[] = [
  ["checkIn", (r) => actions.checkIn({ bookingId: r.confirmed.id })],
  ["undoCheckIn", (r) => actions.undoCheckIn({ bookingId: r.attended.id })],
  ["markNoShow", (r) => actions.markNoShow({ bookingId: r.confirmed.id })],
  ["revertNoShow", (r) => actions.revertNoShow({ bookingId: r.noShow.id })],
  ["updateBookingNotes", (r) => actions.updateBookingNotes({ bookingId: r.confirmed.id, notes: "x" })],
];

describe("booking actions, area attendance: permissions (booking spec 4.2, 7)", () => {
  it.each(calls)("%s needs a signed-in staff user with bookings.write", async (_name, run) => {
    const r = await rows();
    expect(await run(r)).toMatchObject(unauthorized);
    await asCustomer();
    expect(await run(r)).toMatchObject(unauthorized);
    await asStaff(["bookings.read"]);
    expect(await run(r)).toMatchObject(forbidden);
    expect(await bookingById(h.db, r.confirmed.id)).toMatchObject({ status: "confirmed", notes: null });
    await asStaff(["bookings.read", "bookings.write"]);
    expect(await run(r)).toMatchObject({ ok: true });
  });

  it("checking in outside the window needs bookings.override as well as override: true", async () => {
    const r = await rows();
    await asStaff(["bookings.read", "bookings.write"]);
    expect(await actions.checkIn({ bookingId: r.late.id, override: true })).toMatchObject({ ok: false, error: { code: "conflict", message: "outside_window" } });
    await asStaff(["bookings.read", "bookings.write", "bookings.override"]);
    expect(await actions.checkIn({ bookingId: r.late.id, override: true })).toMatchObject({ ok: true, data: { status: "attended" } });
  });

  it("audits check-in, undo, no-show, revert and notes with the booking as entity", async () => {
    const r = await rows();
    const user = await asStaff(["bookings.read", "bookings.write"]);
    await actions.checkIn({ bookingId: r.confirmed.id });
    await actions.undoCheckIn({ bookingId: r.confirmed.id });
    await actions.markNoShow({ bookingId: r.confirmed.id });
    await actions.revertNoShow({ bookingId: r.noShow.id });
    await actions.updateBookingNotes({ bookingId: r.attended.id, notes: "Late arrival" });
    const audited = await h.db
      .select({ action: auditLog.action, entityType: auditLog.entityType, entityId: auditLog.entityId })
      .from(auditLog)
      .where(sql`${auditLog.actor}->>'id' = ${user.id}`);
    expect(audited).toEqual(
      expect.arrayContaining([
        { action: "booking.check_in", entityType: "booking", entityId: r.confirmed.id },
        { action: "booking.undo_check_in", entityType: "booking", entityId: r.confirmed.id },
        { action: "booking.mark_no_show", entityType: "booking", entityId: r.confirmed.id },
        { action: "booking.revert_no_show", entityType: "booking", entityId: r.noShow.id },
        { action: "booking.update_notes", entityType: "booking", entityId: r.attended.id },
      ]),
    );
    expect(audited).toHaveLength(5);
  });
});
