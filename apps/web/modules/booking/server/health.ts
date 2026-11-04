/**
 * Booking health (booking spec 4.8, 02-data-model DM-16; SLA: booking not working is Critical).
 * Read-only: platform's `/api/health` shows it under `checks.booking`, `platform.check_alerts`
 * raises `alert`, ops' daily digest prints `warn`.
 */
import type { DbOrTx } from "@beam/db";
import { bookings, emailMessages, persons, sessionTemplates, sessions, waitlistEntries } from "@beam/db/schema";
import { addDays, brusselsDate, type BookingHealth } from "@beam/core/booking";
import { and, eq, inArray, isNotNull, isNull, sql } from "@/lib/ctx";

/** Thresholds of 4.8. */
export const HEALTH_THRESHOLDS = {
  /** Every active template must have sessions at least this many days ahead. */
  materialisedDays: 60,
  /** Offers and reservations count as overdue this long after their expiry. */
  graceMinutes: 2,
  overdueOffersAlert: 10,
  overdueReservationsAlert: 10,
  unsentConfirmationsAlert: 5,
} as const;

/** How far ahead materialisation writes sessions (R1); the value when no template needs checking. */
const HORIZON_DAYS = 90;

/** The `level` of a health reading (4.8). */
export function healthLevel(h: Omit<BookingHealth, "level">, today: string): BookingHealth["level"] {
  const t = HEALTH_THRESHOLDS;
  if (
    h.materialisedThroughOn < addDays(today, t.materialisedDays) ||
    h.overdueOffers > t.overdueOffersAlert ||
    h.overdueReservations > t.overdueReservationsAlert ||
    h.unsentConfirmations24h > t.unsentConfirmationsAlert
  ) {
    return "alert";
  }
  if (h.overdueOffers > 0 || h.overdueReservations > 0 || h.unsentConfirmations24h > 0) return "warn";
  return "ok";
}

/**
 * `materialisedThroughOn`: the earliest "last materialised Brussels date" over the active
 * templates that must reach `today + 60` (valid by then and not ending before it); a template
 * without any session counts as yesterday. No such template: `today + 90`.
 */
async function materialisedThrough(db: DbOrTx, today: string): Promise<string> {
  const target = addDays(today, HEALTH_THRESHOLDS.materialisedDays);
  const rows = await db
    .select({
      templateId: sessionTemplates.id,
      lastOn: sql<string | null>`max((${sessions.startsAt} at time zone 'Europe/Brussels')::date)::text`,
    })
    .from(sessionTemplates)
    .leftJoin(sessions, eq(sessions.templateId, sessionTemplates.id))
    .where(
      and(
        eq(sessionTemplates.isActive, true),
        sql`${sessionTemplates.activeFromOn} <= ${today}::date`,
        sql`(${sessionTemplates.activeToOn} is null or ${sessionTemplates.activeToOn} >= ${target}::date)`,
      ),
    )
    .groupBy(sessionTemplates.id);
  if (!rows.length) return addDays(today, HORIZON_DAYS);
  const yesterday = addDays(today, -1);
  return rows.map((r) => r.lastOn ?? yesterday).sort()[0]!;
}

/** The four health values and their level at `now` (default the clock). */
export async function computeBookingHealth(db: DbOrTx, now: Date = new Date()): Promise<BookingHealth> {
  const today = brusselsDate(now);
  const grace = new Date(now.getTime() - HEALTH_THRESHOLDS.graceMinutes * 60_000);
  const since = new Date(now.getTime() - 24 * 3_600_000);

  const [offers] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(waitlistEntries)
    .where(and(eq(waitlistEntries.state, "offered"), isNull(waitlistEntries.bookingId), sql`${waitlistEntries.offerExpiresAt} < ${grace.toISOString()}::timestamptz`));
  const [reservations] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(bookings)
    .where(and(eq(bookings.status, "reserved"), sql`${bookings.reservedUntil} < ${grace.toISOString()}::timestamptz`));
  // Confirmed rows of the last 24 h whose attendee has an email and no `booking:<id>:confirmed` message
  // (imports send nothing by design, R65).
  const [unsent] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(bookings)
    .innerJoin(persons, eq(persons.id, bookings.personId))
    .where(
      and(
        inArray(bookings.status, ["confirmed", "attended", "no_show"]),
        sql`${bookings.source} <> 'import'`,
        sql`${bookings.createdAt} >= ${since.toISOString()}::timestamptz`,
        isNotNull(persons.email),
        sql`not exists (select 1 from ${emailMessages} m where m.idempotency_key = 'booking:' || ${bookings.id}::text || ':confirmed')`,
      ),
    );

  const reading = {
    materialisedThroughOn: await materialisedThrough(db, today),
    overdueOffers: Number(offers?.n ?? 0),
    overdueReservations: Number(reservations?.n ?? 0),
    unsentConfirmations24h: Number(unsent?.n ?? 0),
  };
  return { level: healthLevel(reading, today), ...reading };
}
