/**
 * Test fixtures of booking-P2 (BS-23): templates, raw bookings in booking's own tables, staff
 * sessions for the action tests and table cleanup. Imported by booking-P2 test files only;
 * never by production code.
 */
import type { Db, DbOrTx } from "@beam/db";
import { bookings, capacityHolds, jobs, roles, sessionExceptions, sessionTemplates, sessions, waitlistEntries } from "@beam/db/schema";
import { makePerson, makeUser } from "@beam/db/testing";
import { newCheckinCode } from "@beam/core/booking";
import { createAuthSession, SESSION_COOKIE } from "@/lib/auth";
import { eq, sql } from "@/lib/ctx";

export const FULL_NAME = { "nl-BE": "Dagsessie", "fr-BE": "Session de jour", en: "Day session" };

export type TemplateRow = typeof sessionTemplates.$inferSelect;
export type BookingRow = typeof bookings.$inferSelect;

/** A day template Tue-Sun 09:00, 120 minutes, 12 seats, one day credit, valid from 2027-01-01. */
export async function makeTemplate(db: DbOrTx, over: Partial<typeof sessionTemplates.$inferInsert> = {}): Promise<TemplateRow> {
  const [row] = await db
    .insert(sessionTemplates)
    .values({
      kind: "day",
      name: FULL_NAME,
      weekdays: [2, 3, 4, 5, 6, 7],
      startTime: "09:00",
      durationMinutes: 120,
      capacitySeats: 12,
      creditKind: "day",
      creditCost: 1,
      activeFromOn: "2027-01-01",
      ...over,
    })
    .returning();
  return row!;
}

/** A booking row of a new person (default `confirmed`, free, by staff). */
export async function addBooking(db: DbOrTx, sessionId: string, over: Partial<typeof bookings.$inferInsert> = {}): Promise<BookingRow> {
  const status = over.status ?? "confirmed";
  const [row] = await db
    .insert(bookings)
    .values({
      sessionId,
      personId: over.personId ?? (await makePerson(db)).id,
      status,
      paidWith: "free",
      source: "admin",
      checkinCode: newCheckinCode(),
      ...(status === "reserved" ? { reservedUntil: new Date(Date.now() + 30 * 60_000) } : {}),
      ...(status === "cancelled" || status === "late_cancelled" ? { cancelledAt: new Date(), cancelReasonCode: "customer" as const } : {}),
      ...(status === "attended" ? { attendedAt: new Date() } : {}),
      ...over,
    })
    .returning();
  return row!;
}

/** Empties booking's schedule tables and the job queue between tests. */
export async function clearSchedule(db: DbOrTx): Promise<void> {
  await db.delete(waitlistEntries);
  await db.delete(bookings);
  await db.delete(capacityHolds);
  // Order lines are insert-only facts: sessions they point at stay (moved out of the way).
  await db.delete(sessions).where(sql`not exists (select 1 from order_lines ol where ol.session_id = "sessions"."id")`);
  await db
    .update(sessions)
    .set({ templateId: null, startsAt: sql`${sessions.startsAt} - interval '20 years'`, endsAt: sql`${sessions.endsAt} - interval '20 years'` })
    .where(sql`${sessions.startsAt} > now() - interval '10 years'`);
  await db.delete(sessionTemplates);
  await db.delete(sessionExceptions);
  await db.delete(jobs);
}

/** Signs in a staff user whose role has exactly `permissions`; returns the user and cookie value. */
export async function staffSession(db: Db, jar: Map<string, string>, permissions: string[]) {
  const user = await makeUser(db, { roleKey: "reception" });
  await db.update(roles).set({ permissions }).where(eq(roles.key, "reception"));
  const { token } = await createAuthSession(db, { userId: user.id, audience: "staff", roleKey: "reception", now: new Date(), mfaAt: new Date() });
  jar.set(SESSION_COOKIE, token);
  return user;
}

/** The queued jobs of one kind, oldest first. */
export function queued(db: DbOrTx, kind: string) {
  return db.select().from(jobs).where(eq(jobs.kind, kind)).orderBy(jobs.createdAt);
}
