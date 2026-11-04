import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { capacityHolds, sessions } from "@beam/db/schema";
import { createTestDb, makeSession } from "@beam/db/testing";
import { brusselsDate, brusselsTime } from "@beam/core/booking";

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

const actions = await import("./sessions");
const { eq, setAppDb } = await import("@/lib/ctx");
const { resetRuntime } = await import("@/lib/testing");
const { FULL_NAME, addBooking, clearSchedule, queued, staffSession } = await import("./booking-p2.fixtures");

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
  await staffSession(h.db, jar, ["bookings.read", "bookings.write", "bookings.override"]);
});

const DAY = 86_400_000;
const future = (over: Parameters<typeof makeSession>[1] = {}) => makeSession(h.db, { startsAt: new Date(Date.now() + 3 * DAY), publishedAt: new Date(), ...over });
const reload = async (id: string) => (await h.db.select().from(sessions).where(eq(sessions.id, id)))[0]!;
const offerKeys = async () => (await queued(h.db, "waitlist.offer_next")).map((j) => j.idempotencyKey);
const conflict = (reason: string) => ({ ok: false, error: { code: "conflict", message: reason } });

describe("updateSession (R6)", () => {
  it("refuses capacity below held + booked + live offers; raising it enqueues waitlist.offer_next", async () => {
    const s = await future({ capacitySeats: 4 });
    await addBooking(h.db, s.id);
    await addBooking(h.db, s.id);
    await addBooking(h.db, s.id, { status: "cancelled" });
    await h.db.insert(capacityHolds).values({ sessionId: s.id, kind: "staff", quantity: 1 });
    const stamp = () => reload(s.id).then((r) => r.updatedAt.toISOString());

    expect(await actions.updateSession({ id: s.id, expectedUpdatedAt: await stamp(), capacitySeats: 2 })).toMatchObject(conflict("capacity_below_bookings"));
    expect(await actions.updateSession({ id: s.id, expectedUpdatedAt: await stamp(), capacitySeats: 3 })).toMatchObject({ ok: true });
    expect(await reload(s.id)).toMatchObject({ capacitySeats: 3, hasManualChanges: true });
    expect(await offerKeys()).toEqual([]);

    const old = await stamp();
    expect(await actions.updateSession({ id: s.id, expectedUpdatedAt: old, capacitySeats: 6, location: "Zaal 1" })).toMatchObject({ ok: true });
    expect((await offerKeys()).some((k) => k.startsWith(`waitlist:${s.id}:offer_next:capacity:6:`))).toBe(true);
    // The stamp read before the last edit is stale now.
    expect(await actions.updateSession({ id: s.id, expectedUpdatedAt: old, capacitySeats: 7 })).toMatchObject(conflict("stale_version"));
  });

  it("moves a session in Brussels wall-clock time and warns about a room overlap", async () => {
    const other = await future({ location: "Zaal 1", startsAt: new Date("2027-03-10T09:00:00Z"), endsAt: new Date("2027-03-10T11:00:00Z") });
    const s = await future();
    const res = await actions.updateSession({ id: s.id, expectedUpdatedAt: s.updatedAt.toISOString(), startsAt: "2027-03-10T10:30", durationMinutes: 60, location: "zaal 1" });
    expect(res).toMatchObject({ ok: true, data: { warnings: [{ code: "location_overlap", sessionId: other.id }] } });
    const row = await reload(s.id);
    expect([brusselsDate(row.startsAt), brusselsTime(row.startsAt), row.endsAt.getTime() - row.startsAt.getTime()]).toEqual(["2027-03-10", "10:30", 3_600_000]);
  });
});

describe("createSession and publishSession (R5, R50)", () => {
  const event = { kind: "event", title: FULL_NAME, startsAt: "2027-04-02T19:30", durationMinutes: 120, capacitySeats: 40, creditCost: 0, publish: false };

  it("an event needs an event_category; a partner event needs its company; a member event defaults to members only", async () => {
    expect(await actions.createSession(event)).toMatchObject({ ok: false, error: { code: "validation", fields: { eventCategory: "required" } } });
    expect(await actions.createSession({ ...event, eventCategory: "partner_event" })).toMatchObject({ ok: false, error: { code: "validation", fields: { partnerCompanyId: "required" } } });
    expect(await actions.createSession({ ...event, kind: "day", eventCategory: "lecture" })).toMatchObject({ ok: false, error: { code: "validation", fields: { eventCategory: "events_only" } } });
    const res = await actions.createSession({ ...event, eventCategory: "member_event" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(await reload(res.data.sessionId)).toMatchObject({ kind: "event", eventCategory: "member_event", isMemberOnly: true, publishedAt: null, templateId: null, hasManualChanges: true });
  });

  it("publishing requires a complete title (and description when given)", async () => {
    const partial = { "nl-BE": "Lezing", en: "Lecture" };
    expect(await actions.createSession({ ...event, eventCategory: "lecture", title: partial, publish: true })).toMatchObject({ ok: false, error: { code: "validation", fields: { "title.fr-BE": "missing" } } });
    const draft = await actions.createSession({ ...event, eventCategory: "lecture", title: partial });
    if (!draft.ok) throw new Error("draft failed");
    const id = draft.data.sessionId;
    expect(await actions.publishSession({ id })).toMatchObject({ ok: false, error: { code: "validation", fields: { "title.fr-BE": "missing" } } });
    const row = await reload(id);
    expect(await actions.updateSession({ id, expectedUpdatedAt: row.updatedAt.toISOString(), title: FULL_NAME, description: { en: "Only English" } })).toMatchObject({ ok: true });
    expect(await actions.publishSession({ id })).toMatchObject({ ok: false, error: { code: "validation", fields: { "description.nl-BE": "missing" } } });
    const row2 = await reload(id);
    expect(await actions.updateSession({ id, expectedUpdatedAt: row2.updatedAt.toISOString(), description: null })).toMatchObject({ ok: true });
    const pub = await actions.publishSession({ id });
    expect(pub).toMatchObject({ ok: true });
    expect((await reload(id)).publishedAt).not.toBeNull();
    // Publishing twice keeps the first time.
    expect(await actions.publishSession({ id })).toEqual(pub);
    const published = await actions.createSession({ ...event, eventCategory: "concert", publish: true });
    expect(published.ok && (await reload(published.data.sessionId)).publishedAt).toBeTruthy();
  });
});

describe("holds (R10, R11, R34)", () => {
  it("a hold cannot drop below its bookings; a smaller or deleted hold enqueues waitlist.offer_next", async () => {
    const s = await future({ capacitySeats: 10 });
    const created = await actions.upsertHold({ sessionId: s.id, kind: "speaker", quantity: 3, note: "Spreker" });
    if (!created.ok) throw new Error("hold failed");
    const holdId = created.data.id;
    await addBooking(h.db, s.id, { capacityHoldId: holdId });
    await addBooking(h.db, s.id, { capacityHoldId: holdId });
    await addBooking(h.db, s.id, { capacityHoldId: holdId, status: "cancelled" });

    expect(await actions.upsertHold({ id: holdId, sessionId: s.id, kind: "speaker", quantity: 1 })).toMatchObject(conflict("capacity_below_bookings"));
    expect(await actions.upsertHold({ id: holdId, sessionId: s.id, kind: "speaker", quantity: 2 })).toMatchObject({ ok: true });
    expect(await offerKeys()).toEqual([`waitlist:${s.id}:offer_next:${holdId}:2`]);
    expect(await actions.deleteHold({ id: holdId })).toMatchObject(conflict("capacity_below_bookings"));

    const other = await actions.upsertHold({ sessionId: s.id, kind: "blocked", quantity: 1 });
    if (!other.ok) throw new Error("hold failed");
    expect(await actions.deleteHold({ id: other.data.id })).toMatchObject({ ok: true });
    expect(await offerKeys()).toContain(`waitlist:${s.id}:offer_next:${other.data.id}`);
    expect(await h.db.select().from(capacityHolds).where(eq(capacityHolds.sessionId, s.id))).toHaveLength(1);
  });

  it("a partner hold needs a company; growing past free capacity needs bookings.override", async () => {
    const s = await future({ capacitySeats: 2 });
    expect(await actions.upsertHold({ sessionId: s.id, kind: "partner", quantity: 1 })).toMatchObject({ ok: false, error: { code: "validation", fields: { companyId: "required" } } });
    await addBooking(h.db, s.id);
    await staffSession(h.db, jar, ["bookings.read", "bookings.write"]);
    expect(await actions.upsertHold({ sessionId: s.id, kind: "staff", quantity: 2 })).toMatchObject(conflict("session_full"));
    expect(await actions.upsertHold({ sessionId: s.id, kind: "staff", quantity: 1 })).toMatchObject({ ok: true });
    await staffSession(h.db, jar, ["bookings.write", "bookings.override"]);
    expect(await actions.upsertHold({ sessionId: s.id, kind: "blocked", quantity: 1 })).toMatchObject({ ok: true });
  });
});

describe("session status transitions (sessionTransition, R34)", () => {
  it("open -> closed -> open; reopening enqueues waitlist.offer_next; same status is a no-op", async () => {
    const s = await future();
    expect(await actions.setSessionOpen({ id: s.id, open: false })).toEqual({ ok: true, data: { status: "closed" } });
    expect(await actions.setSessionOpen({ id: s.id, open: false })).toEqual({ ok: true, data: { status: "closed" } });
    expect(await offerKeys()).toEqual([]);
    expect(await actions.setSessionOpen({ id: s.id, open: true })).toEqual({ ok: true, data: { status: "open" } });
    expect((await offerKeys()).some((k) => k.startsWith(`waitlist:${s.id}:offer_next:reopen:`))).toBe(true);
    expect(await actions.setSessionOpen({ id: s.id, open: true })).toEqual({ ok: true, data: { status: "open" } });
  });

  it("cancelled is terminal: no reopening, closing, editing, publishing or holds", async () => {
    const s = await future({ status: "cancelled", cancelledAt: new Date(), cancelReason: "storm" });
    expect(await actions.setSessionOpen({ id: s.id, open: true })).toMatchObject(conflict("invalid_transition"));
    expect(await actions.setSessionOpen({ id: s.id, open: false })).toMatchObject(conflict("invalid_transition"));
    expect(await actions.updateSession({ id: s.id, expectedUpdatedAt: s.updatedAt.toISOString(), capacitySeats: 20 })).toMatchObject(conflict("invalid_transition"));
    expect(await actions.publishSession({ id: s.id })).toMatchObject(conflict("invalid_transition"));
    expect(await actions.upsertHold({ sessionId: s.id, kind: "staff", quantity: 1 })).toMatchObject(conflict("invalid_transition"));
    expect(await reload(s.id)).toMatchObject({ status: "cancelled" });
  });
});
