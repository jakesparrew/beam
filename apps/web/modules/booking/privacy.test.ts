/**
 * booking-P6: the GDPR registration (booking spec section 9): export of bookings as attendee,
 * booker and guest-of plus waitlist entries; erase (deleted entries, cancelled future rows with
 * `waitlist.offer_next`, anonymised and retained rows, other people's guest rows kept); the two
 * retention sweeps and their agreement with the seeded `retention_policies` keys.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@beam/db";
import { bookings, files, jobs, waitlistEntries } from "@beam/db/schema";
import { createTestDb, makePerson, makeSession } from "@beam/db/testing";
import { makePaidOrder } from "@beam/db/testing/commerce-factories";
import { BOOKING_RETENTION_POLICIES } from "@beam/db/seed/booking";
import { isValidRetentionSeed } from "@beam/core/privacy";
import { and, eq, inArray, or, sql, type Tx } from "@/lib/ctx";
import { resetRuntime } from "@/lib/testing";
import { GDPR_REGISTRY, NO_PII_TABLES } from "@/registry/privacy.generated";
import { SWEEP_BATCH, bookingPrivacy, noPiiTables, privacy, retention, sweep } from "./privacy";

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

const DAY = 86_400_000;
const at = (days: number) => new Date(Date.now() + days * DAY);
const inTx = <T>(fn: (tx: Tx) => Promise<T>) => h.db.transaction((tx) => fn(tx));
const asRows = (v: unknown) => v as Record<string, unknown>[];
const TITLE = { "nl-BE": "Ochtendsauna", "fr-BE": "Sauna du matin", en: "Morning sauna" };

type BookingInsert = typeof bookings.$inferInsert;
async function booking(values: Partial<BookingInsert> & { sessionId: string; personId: string }) {
  const [b] = await h.db
    .insert(bookings)
    .values({ status: "confirmed", paidWith: "credit", source: "portal", ...values })
    .returning();
  return b!;
}
const session = (days: number, extra: Parameters<typeof makeSession>[1] = {}) =>
  makeSession(h.db, { title: TITLE, startsAt: at(days), publishedAt: new Date(), ...extra });

async function qrFile(personId: string) {
  const [f] = await h.db
    .insert(files)
    .values({ kind: "image", name: "checkin-qr.png", mime: "image/png", sizeBytes: 3, bytes: new Uint8Array([1, 2, 3]), sha256: "a".repeat(64), personId, isPublic: false })
    .returning({ id: files.id });
  return f!.id;
}

describe("registration", () => {
  it("lists bookings and waitlist_entries, is in the generated registry and declares the NO_PII tables", () => {
    expect([...privacy.tables].sort()).toEqual(["bookings", "waitlist_entries"]);
    expect(GDPR_REGISTRY.booking).toBe(privacy);
    expect(bookingPrivacy).toBe(privacy);
    for (const t of noPiiTables) {
      expect(NO_PII_TABLES).toContain(t);
      expect(privacy.tables).not.toContain(t);
    }
  });

  it("has one sweep handler per seeded retention key, and the same retention rows as the seed", () => {
    const keys = BOOKING_RETENTION_POLICIES.map((p) => p.key).sort();
    expect(keys).toEqual(["booking.bookings_free_text", "booking.waitlist_entries"]);
    expect(Object.keys(sweep).sort()).toEqual(keys);
    expect(Object.keys(privacy.sweep ?? {}).sort()).toEqual(keys);
    expect(retention.map((r) => r.key).sort()).toEqual(keys);
    for (const r of retention) expect(isValidRetentionSeed(r)).toBe(true);
  });
});

describe("export", () => {
  it("lists bookings as attendee, booker and guest-of, other people by first name only, and waitlist entries", async () => {
    const me = await makePerson(h.db, { firstName: "Mila", lastName: "Mertens" });
    const friend = await makePerson(h.db, { firstName: "Fien", lastName: "Fransen" });
    const host = await makePerson(h.db, { firstName: "Hugo", lastName: "Hermans" });
    const s1 = await session(3);
    const s2 = await session(4);
    const s3 = await session(5);
    const mine = await booking({ sessionId: s1.id, personId: me.id, bookedByPersonId: me.id, notes: "Prefers the left bench", cancelReason: null });
    await booking({ sessionId: s1.id, personId: friend.id, bookedByPersonId: me.id, guestOfBookingId: mine.id, paidWith: "guest" });
    const hosts = await booking({ sessionId: s2.id, personId: host.id, bookedByPersonId: host.id });
    await booking({ sessionId: s2.id, personId: me.id, bookedByPersonId: host.id, guestOfBookingId: hosts.id, paidWith: "guest" });
    await h.db.insert(waitlistEntries).values({ sessionId: s3.id, personId: me.id, queue: "public", state: "waiting", emailNormalised: "mila@example.com" });

    const out = await inTx((tx) => privacy.export(tx, me.id));
    const rows = asRows(out["booking/bookings.json"]);
    expect(rows).toHaveLength(3);
    const byRole = Object.fromEntries(rows.map((r) => [String(r.role), r])) as Record<string, Record<string, unknown>>;
    expect(byRole.attendee).toMatchObject({ session_title: TITLE, session_kind: "day", status: "confirmed", paid_with: "credit", guest_of: null });
    expect(byRole.booker).toMatchObject({ guest_first_name: "Fien", paid_with: "guest" });
    expect(byRole.guest).toMatchObject({ guest_of: "Hugo" });
    const text = JSON.stringify(out);
    for (const secret of ["Fransen", "Hermans", "Prefers the left bench", mine.checkinCode]) expect(text).not.toContain(secret);

    const wl = asRows(out["booking/waitlist.json"]);
    expect(wl).toEqual([expect.objectContaining({ session_title: TITLE, queue: "public", state: "waiting", offered_at: null })]);
    expect(text).not.toContain("mila@example.com");
  });

  it("returns empty lists for a person without bookings", async () => {
    const nobody = await makePerson(h.db);
    await expect(inTx((tx) => privacy.export(tx, nobody.id))).resolves.toEqual({ "booking/bookings.json": [], "booking/waitlist.json": [] });
  });
});

describe("erase", () => {
  it("deletes entries, cancels future rows with offer_next, anonymises the rest and keeps other people's guest rows", async () => {
    const me = await makePerson(h.db, { firstName: "Erik", lastName: "Erased" });
    const guest = await makePerson(h.db, { firstName: "Greta", lastName: "Guest" });
    const other = await makePerson(h.db);
    const future = await session(6);
    const past = await session(-10);
    const paidSession = await session(7, { productId: null });
    const full = await session(8);

    const fileId = await qrFile(me.id);
    const live = await booking({ sessionId: future.id, personId: me.id, bookedByPersonId: me.id, notes: "VIP", qrFileId: fileId });
    const guestRow = await booking({ sessionId: future.id, personId: guest.id, bookedByPersonId: me.id, guestOfBookingId: live.id, paidWith: "guest", notes: "Guest note" });
    const old = await booking({
      sessionId: past.id,
      personId: me.id,
      status: "cancelled",
      cancelledAt: at(-12),
      cancelReasonCode: "staff",
      cancelReason: "Called in sick",
    });
    const { lines } = await makePaidOrder(h.db, { personId: me.id, lines: [{ productKind: "session", sessionId: paidSession.id }] });
    const paid = await booking({ sessionId: paidSession.id, personId: me.id, paidWith: "order", orderLineId: lines[0]!.id });
    const others = await booking({ sessionId: future.id, personId: other.id, notes: "Untouched" });
    await h.db.insert(waitlistEntries).values([
      { sessionId: full.id, personId: me.id, state: "offered", offerExpiresAt: at(1), offeredAt: new Date(), offersCount: 1, emailNormalised: "erik@example.com" },
      { sessionId: past.id, personId: me.id, state: "expired", endedReason: "offer_timeout" },
    ]);

    const report = await inTx((tx) => privacy.erase(tx, me.id));
    expect(report).toEqual([
      { table: "waitlist_entries", rows: 2, action: "deleted" },
      { table: "bookings", rows: 2, action: "anonymised" },
      { table: "bookings", rows: 1, action: "retained_legal" },
      { table: "bookings", rows: 1, action: "unlinked" },
    ]);

    expect(await h.db.select().from(waitlistEntries).where(eq(waitlistEntries.personId, me.id))).toEqual([]);

    const [liveAfter] = await h.db.select().from(bookings).where(eq(bookings.id, live.id));
    expect(liveAfter).toMatchObject({ status: "cancelled", cancelReasonCode: "erased", notes: null, qrFileId: null, bookedByPersonId: null, version: live.version + 1 });
    expect(liveAfter!.checkinCode).not.toBe(live.checkinCode);
    expect(await h.db.select().from(files).where(eq(files.id, fileId))).toEqual([]);

    // Past rows keep their status; the paid future row is cancelled but kept for accounting.
    const [oldAfter] = await h.db.select().from(bookings).where(eq(bookings.id, old.id));
    expect(oldAfter).toMatchObject({ status: "cancelled", cancelReasonCode: "staff", cancelReason: null });
    const [paidAfter] = await h.db.select().from(bookings).where(eq(bookings.id, paid.id));
    expect(paidAfter).toMatchObject({ status: "cancelled", cancelReasonCode: "erased", orderLineId: lines[0]!.id });

    // The guest's own row stays as it was, only the booker link is gone.
    const [guestAfter] = await h.db.select().from(bookings).where(eq(bookings.id, guestRow.id));
    expect(guestAfter).toMatchObject({ status: "confirmed", personId: guest.id, notes: "Guest note", bookedByPersonId: null, guestOfBookingId: live.id });
    const [othersAfter] = await h.db.select().from(bookings).where(eq(bookings.id, others.id));
    expect(othersAfter).toMatchObject({ status: "confirmed", notes: "Untouched" });

    // No free text linked to the person is left.
    const leftovers = await h.db
      .select({ id: bookings.id })
      .from(bookings)
      .where(and(eq(bookings.personId, me.id), or(sql`${bookings.notes} is not null`, sql`${bookings.cancelReason} is not null`)));
    expect(leftovers).toEqual([]);

    // One offer_next per affected session: the cancelled rows and the freed offer.
    const queued = await h.db
      .select({ payload: jobs.payload })
      .from(jobs)
      .where(eq(jobs.kind, "waitlist.offer_next"));
    const sessionsQueued = queued.map((j) => (j.payload as { sessionId: string }).sessionId);
    for (const s of [future.id, paidSession.id, full.id]) expect(sessionsQueued.filter((x) => x === s)).toHaveLength(1);
    expect(sessionsQueued).not.toContain(past.id);
  });

  it("is idempotent: a second run changes no status and enqueues nothing new", async () => {
    const me = await makePerson(h.db);
    const s = await session(9);
    await booking({ sessionId: s.id, personId: me.id });
    await inTx((tx) => privacy.erase(tx, me.id));
    const before = await h.db.select({ id: jobs.id }).from(jobs).where(eq(jobs.kind, "waitlist.offer_next"));
    const report = await inTx((tx) => privacy.erase(tx, me.id));
    expect(report.find((r) => r.table === "waitlist_entries")?.rows).toBe(0);
    const after = await h.db.select({ id: jobs.id }).from(jobs).where(eq(jobs.kind, "waitlist.offer_next"));
    expect(after.length).toBe(before.length);
    const [row] = await h.db.select({ status: bookings.status }).from(bookings).where(eq(bookings.personId, me.id));
    expect(row!.status).toBe("cancelled");
  });
});

describe("sweep", () => {
  it("booking.waitlist_entries deletes entries of sessions that started before the cutoff, anchored on starts_at", async () => {
    const p = await makePerson(h.db);
    const q = await makePerson(h.db);
    const oldSession = await session(-400);
    const recent = await session(-30);
    // Created recently, but the session is old: the anchor is the session's start.
    const [oldEntry] = await h.db.insert(waitlistEntries).values({ sessionId: oldSession.id, personId: p.id, state: "expired" }).returning();
    const [keep] = await h.db.insert(waitlistEntries).values({ sessionId: recent.id, personId: q.id, state: "expired" }).returning();
    const cutoff = at(-365);
    const n = await inTx((tx) => sweep["booking.waitlist_entries"]!(tx, cutoff));
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(SWEEP_BATCH);
    const left = await h.db.select({ id: waitlistEntries.id }).from(waitlistEntries).where(inArray(waitlistEntries.id, [oldEntry!.id, keep!.id]));
    expect(left.map((r) => r.id)).toEqual([keep!.id]);
    await expect(inTx((tx) => sweep["booking.waitlist_entries"]!(tx, cutoff))).resolves.toBe(0);
  });

  it("booking.bookings_free_text clears notes and cancel_reason of old sessions, keeps the rows and returns the batch count", async () => {
    const p = await makePerson(h.db);
    const oldSession = await session(-1200);
    const recent = await session(-100);
    const old = await booking({ sessionId: oldSession.id, personId: p.id, status: "attended", attendedAt: at(-1200), notes: "Old note" });
    const oldCancelled = await booking({
      sessionId: oldSession.id,
      personId: (await makePerson(h.db)).id,
      status: "cancelled",
      cancelledAt: at(-1201),
      cancelReasonCode: "staff",
      cancelReason: "Old reason",
    });
    const fresh = await booking({ sessionId: recent.id, personId: p.id, status: "attended", attendedAt: at(-100), notes: "Recent note" });
    const cutoff = at(-1095);
    const n = await inTx((tx) => sweep["booking.bookings_free_text"]!(tx, cutoff));
    expect(n).toBe(2);
    const rows = await h.db.select().from(bookings).where(inArray(bookings.id, [old.id, oldCancelled.id, fresh.id]));
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(old.id)).toMatchObject({ notes: null, status: "attended" });
    expect(byId.get(oldCancelled.id)).toMatchObject({ cancelReason: null, cancelReasonCode: "staff" });
    expect(byId.get(fresh.id)).toMatchObject({ notes: "Recent note" });
    await expect(inTx((tx) => sweep["booking.bookings_free_text"]!(tx, cutoff))).resolves.toBe(0);
  });
});
