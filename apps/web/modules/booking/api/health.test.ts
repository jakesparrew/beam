import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "@beam/db";
import { bookings, emailMessages, sessionTemplates, sessions, waitlistEntries } from "@beam/db/schema";
import { addDays, brusselsDate } from "@beam/core/booking";
import { createTestDb, makePerson } from "@beam/db/testing";
import { eq } from "@/lib/ctx";
import { DAY, openSession } from "../server/booking-p3a.fixtures";
import { rawBooking, waitEntry } from "../server/booking-p3b.fixtures";
import { healthLevel } from "../server/health";
import { getBookingHealth } from "./bookings";

let h: DbHandle;

beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.db.delete(waitlistEntries);
  await h.db.delete(bookings);
  await h.db.delete(sessions);
  await h.db.delete(sessionTemplates);
});

const today = () => brusselsDate(new Date());
const MIN = 60_000;

/** An active day template with sessions every day from tomorrow to `today + throughDays`. */
async function templateThrough(throughDays: number, over: Partial<typeof sessionTemplates.$inferInsert> = {}) {
  const [t] = await h.db
    .insert(sessionTemplates)
    .values({
      kind: "day",
      name: { "nl-BE": "Dagblok", "fr-BE": "Bloc", en: "Day block" },
      weekdays: [1, 2, 3, 4, 5, 6, 7],
      startTime: "10:00",
      durationMinutes: 120,
      capacitySeats: 10,
      creditKind: "day",
      activeFromOn: addDays(today(), -10),
      ...over,
    })
    .returning();
  for (const d of [1, Math.floor(throughDays / 2), throughDays]) {
    await openSession(h.db, { templateId: t!.id, startsAt: new Date(Date.now() + d * DAY) });
  }
  return t!;
}

describe("getBookingHealth (booking spec 4.8)", () => {
  it("an empty system is ok and materialised through the 90-day horizon", async () => {
    expect(await getBookingHealth(h.db)).toEqual({
      level: "ok",
      materialisedThroughOn: addDays(today(), 90),
      overdueOffers: 0,
      overdueReservations: 0,
      unsentConfirmations24h: 0,
    });
  });

  it("materialisation: alert below today + 60 for any active template, ok from there", async () => {
    await templateThrough(89);
    expect(await getBookingHealth(h.db)).toMatchObject({ level: "ok", materialisedThroughOn: brusselsDate(new Date(Date.now() + 89 * DAY)) });
    const behind = await templateThrough(30);
    const health = await getBookingHealth(h.db);
    expect(health).toMatchObject({ level: "alert", materialisedThroughOn: brusselsDate(new Date(Date.now() + 30 * DAY)) });
    // An inactive template, or one that ends before the horizon, is not checked.
    await h.db.update(sessionTemplates).set({ isActive: false }).where(eq(sessionTemplates.id, behind.id));
    expect((await getBookingHealth(h.db)).level).toBe("ok");
    await templateThrough(10, { activeToOn: addDays(today(), 12) });
    expect((await getBookingHealth(h.db)).level).toBe("ok");
    // An active template without any session counts as not materialised.
    await h.db.insert(sessionTemplates).values({ kind: "day", name: { "nl-BE": "x", "fr-BE": "x", en: "x" }, weekdays: [2], startTime: "09:00", durationMinutes: 60, capacitySeats: 5, creditKind: "day", activeFromOn: today() });
    expect(await getBookingHealth(h.db)).toMatchObject({ level: "alert", materialisedThroughOn: addDays(today(), -1) });
  });

  it("overdue offers: warn from 1, alert above 10; within the 2-minute grace or with a claim booking they do not count", async () => {
    const session = await openSession(h.db);
    await waitEntry(h.db, { sessionId: session.id, state: "offered", offerExpiresAt: new Date(Date.now() - MIN) });
    expect(await getBookingHealth(h.db)).toMatchObject({ level: "ok", overdueOffers: 0 });
    await waitEntry(h.db, { sessionId: session.id, state: "offered", offerExpiresAt: new Date(Date.now() - 5 * MIN) });
    expect(await getBookingHealth(h.db)).toMatchObject({ level: "warn", overdueOffers: 1 });
    for (let i = 0; i < 10; i++) await waitEntry(h.db, { sessionId: session.id, state: "offered", offerExpiresAt: new Date(Date.now() - 5 * MIN) });
    expect(await getBookingHealth(h.db)).toMatchObject({ level: "alert", overdueOffers: 11 });
  });

  it("overdue reservations: warn from 1, alert above 10", async () => {
    const session = await openSession(h.db, { capacitySeats: 30 });
    const reserved = { status: "reserved" as const, paidWith: "free" as const };
    await rawBooking(h.db, { sessionId: session.id, ...reserved, reservedUntil: new Date(Date.now() - MIN) });
    await rawBooking(h.db, { sessionId: session.id, ...reserved, reservedUntil: new Date(Date.now() + 10 * MIN) });
    expect(await getBookingHealth(h.db)).toMatchObject({ level: "ok", overdueReservations: 0 });
    await rawBooking(h.db, { sessionId: session.id, ...reserved, reservedUntil: new Date(Date.now() - 10 * MIN) });
    expect(await getBookingHealth(h.db)).toMatchObject({ level: "warn", overdueReservations: 1 });
    for (let i = 0; i < 10; i++) await rawBooking(h.db, { sessionId: session.id, ...reserved, reservedUntil: new Date(Date.now() - 10 * MIN) });
    expect(await getBookingHealth(h.db)).toMatchObject({ level: "alert", overdueReservations: 11 });
  });

  it("unsent confirmations of the last 24 h: warn from 1, alert above 5; sent, imported, older and email-less rows do not count", async () => {
    const session = await openSession(h.db, { capacitySeats: 30 });
    const sent = await rawBooking(h.db, { sessionId: session.id });
    const person = await makePerson(h.db);
    await h.db.insert(emailMessages).values({
      personId: sent.personId,
      toEmail: "sent@example.com",
      kind: "transactional",
      fromDomain: "mail.beam.be",
      locale: "nl-BE",
      props: {},
      idempotencyKey: `booking:${sent.id}:confirmed`,
      status: "queued",
    });
    await rawBooking(h.db, { sessionId: session.id, source: "import", externalRef: `simplybook:${person.id}` });
    await rawBooking(h.db, { sessionId: session.id, createdAt: new Date(Date.now() - 2 * DAY) });
    const noEmail = await makePerson(h.db, { email: null });
    await rawBooking(h.db, { sessionId: session.id, personId: noEmail.id });
    expect(await getBookingHealth(h.db)).toMatchObject({ level: "ok", unsentConfirmations24h: 0 });
    await rawBooking(h.db, { sessionId: session.id });
    expect(await getBookingHealth(h.db)).toMatchObject({ level: "warn", unsentConfirmations24h: 1 });
    for (let i = 0; i < 5; i++) await rawBooking(h.db, { sessionId: session.id });
    expect(await getBookingHealth(h.db)).toMatchObject({ level: "alert", unsentConfirmations24h: 6 });
  });

  it("healthLevel applies the thresholds exactly", () => {
    const on = today();
    const base = { materialisedThroughOn: addDays(on, 60), overdueOffers: 0, overdueReservations: 0, unsentConfirmations24h: 0 };
    expect(healthLevel(base, on)).toBe("ok");
    expect(healthLevel({ ...base, materialisedThroughOn: addDays(on, 59) }, on)).toBe("alert");
    expect(healthLevel({ ...base, overdueOffers: 10 }, on)).toBe("warn");
    expect(healthLevel({ ...base, overdueOffers: 11 }, on)).toBe("alert");
    expect(healthLevel({ ...base, overdueReservations: 10 }, on)).toBe("warn");
    expect(healthLevel({ ...base, overdueReservations: 11 }, on)).toBe("alert");
    expect(healthLevel({ ...base, unsentConfirmations24h: 5 }, on)).toBe("warn");
    expect(healthLevel({ ...base, unsentConfirmations24h: 6 }, on)).toBe("alert");
  });
});
