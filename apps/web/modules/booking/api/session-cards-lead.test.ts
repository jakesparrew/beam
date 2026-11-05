import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@beam/db";
import { createTestDb } from "@beam/db/testing";
import { resetRuntime } from "@/lib/testing";
import { DAY, HOUR, openSession, setBookingRules } from "../server/booking-p3a.fixtures";
import { rawBooking } from "../server/booking-p3b.fixtures";
import { getSessionCards } from "./bookings";

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
  await setBookingRules(h.db);
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

/** A Lead Magnet event (4 seats, 2 for leads) with `generalTaken` general seats booked. */
async function leadEvent(opts: { generalTaken?: number; windowEndAt?: Date; isLeadMagnet?: boolean } = {}) {
  const isLeadMagnet = opts.isLeadMagnet ?? true;
  const session = await openSession(h.db, {
    kind: "event",
    eventCategory: "lecture",
    creditKind: null,
    creditCost: 0,
    capacitySeats: 4,
    startsAt: new Date(Date.now() + 5 * DAY),
    isLeadMagnet,
    leadReservedSeats: isLeadMagnet ? 2 : 0,
    leadWindowStartAt: new Date(Date.now() - 2 * DAY),
    leadWindowEndAt: opts.windowEndAt ?? new Date(Date.now() + DAY),
  });
  for (let i = 0; i < (opts.generalTaken ?? 0); i++) await rawBooking(h.db, { sessionId: session.id });
  return session;
}

const card = async (sessionId: string) => (await getSessionCards(h.db, [sessionId], "en"))[0]!;

describe("getSessionCards: opensForCustomersAt (booking spec 4.9, booking-P7)", () => {
  it("is lead_window_end_at in phase lead with no general seat left", async () => {
    const s = await leadEvent({ generalTaken: 2 });
    const c = await card(s.id);
    expect(c.opensForCustomersAt?.toISOString()).toBe(s.leadWindowEndAt!.toISOString());
    // The public band follows the general seats, so the card reads "full" for customers.
    expect(c).toMatchObject({ isLeadMagnet: true, availabilityBand: "full" });
  });

  it("is null while a general seat is free", async () => {
    const s = await leadEvent({ generalTaken: 1 });
    expect((await card(s.id)).opensForCustomersAt).toBeNull();
  });

  it("is null after lead_window_end_at", async () => {
    const s = await leadEvent({ generalTaken: 2, windowEndAt: new Date(Date.now() - HOUR) });
    expect((await card(s.id)).opensForCustomersAt).toBeNull();
  });

  it("is null for a session that is not a Lead Magnet", async () => {
    const s = await leadEvent({ generalTaken: 4, isLeadMagnet: false });
    expect((await card(s.id)).opensForCustomersAt).toBeNull();
  });

  it("holds no person data", async () => {
    const s = await leadEvent({ generalTaken: 2 });
    const c = await card(s.id);
    expect(Object.keys(c).sort()).toEqual(
      ["availabilityBand", "bookUrl", "endsAt", "isLeadMagnet", "isMemberOnly", "kind", "location", "opensForCustomersAt", "productId", "sessionId", "startsAt", "title"].sort(),
    );
    expect(JSON.stringify(c)).not.toMatch(/@|person/i);
    expect(c.bookUrl).toBe(`/en/account/book/${s.id}`);
  });
});
