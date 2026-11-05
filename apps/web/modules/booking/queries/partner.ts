/**
 * booking queries, area `partner` (booking spec 4.3, 5.1 and 7, R3; booking-P9).
 *
 * `listMyPartnerHolds` feeds `/admin/sessions/holds` in its seat-assignment part. The page resolves
 * the scope first with platform's `requirePartnerOrPermission(ctx, 'bookings.write')`:
 * `{ companyId }` for an `external_partner` (only the holds of their own company, without the
 * staff-only note), `{ companyId: null }` for staff (every hold). Each hold carries its counts and
 * the seats assigned inside it with the names on them, never any other attendee of the session
 * and never an email or phone. Other modules never import this file (they use `../api.ts`).
 */
import type { DbOrTx } from "@beam/db";
import { bookings, capacityHolds, companies, persons, sessions } from "@beam/db/schema";
import type { LocalizedText } from "@beam/core/i18n";
import { and, asc, eq, gt, inArray, isNotNull, or } from "@/lib/ctx";

/** Live statuses that occupy a hold seat (R9, R11; a `reserved` row only while it is not expired). */
const HOLD_SEAT_STATUSES = ["confirmed", "attended", "no_show"] as const;

export type PartnerHoldSeat = {
  bookingId: string;
  firstName: string | null;
  lastName: string | null;
  status: "reserved" | "confirmed" | "attended" | "no_show";
};

export type PartnerHoldRow = {
  id: string;
  sessionId: string;
  sessionTitle: LocalizedText;
  startsAt: Date;
  /** Assigning and unassigning stop once the session has started. */
  isStarted: boolean;
  isCancelled: boolean;
  kind: "staff" | "partner" | "host" | "speaker" | "blocked";
  quantity: number;
  used: number;
  companyId: string | null;
  companyName: string | null;
  /** Staff only (it may name a speaker): always null in a partner scope. */
  note: string | null;
  seats: PartnerHoldSeat[];
};

export type PartnerHoldScope = { companyId: string | null };

/**
 * R3: the holds of sessions that have not ended, with their assigned seats. A scoped call
 * (`companyId` set) returns only that company's holds and hides the note.
 */
export async function listMyPartnerHolds(db: DbOrTx, scope: PartnerHoldScope, input: { now?: Date } = {}): Promise<PartnerHoldRow[]> {
  const now = input.now ?? new Date();
  const holds = await db
    .select({
      id: capacityHolds.id,
      sessionId: capacityHolds.sessionId,
      sessionTitle: sessions.title,
      startsAt: sessions.startsAt,
      sessionStatus: sessions.status,
      kind: capacityHolds.kind,
      quantity: capacityHolds.quantity,
      companyId: capacityHolds.companyId,
      companyName: companies.name,
      note: capacityHolds.note,
    })
    .from(capacityHolds)
    .innerJoin(sessions, eq(sessions.id, capacityHolds.sessionId))
    .leftJoin(companies, eq(companies.id, capacityHolds.companyId))
    .where(and(gt(sessions.endsAt, now), scope.companyId ? eq(capacityHolds.companyId, scope.companyId) : undefined))
    .orderBy(asc(sessions.startsAt), asc(capacityHolds.createdAt));
  if (holds.length === 0) return [];

  const seatRows = await db
    .select({
      holdId: bookings.capacityHoldId,
      bookingId: bookings.id,
      status: bookings.status,
      firstName: persons.firstName,
      lastName: persons.lastName,
    })
    .from(bookings)
    .innerJoin(persons, eq(persons.id, bookings.personId))
    .where(
      and(
        isNotNull(bookings.capacityHoldId),
        inArray(
          bookings.capacityHoldId,
          holds.map((h) => h.id),
        ),
        or(inArray(bookings.status, [...HOLD_SEAT_STATUSES]), and(eq(bookings.status, "reserved"), gt(bookings.reservedUntil, now))),
      ),
    )
    .orderBy(asc(bookings.createdAt), asc(bookings.id));

  const seatsByHold = new Map<string, PartnerHoldSeat[]>();
  for (const s of seatRows) {
    const list = seatsByHold.get(s.holdId!) ?? [];
    list.push({ bookingId: s.bookingId, firstName: s.firstName, lastName: s.lastName, status: s.status as PartnerHoldSeat["status"] });
    seatsByHold.set(s.holdId!, list);
  }
  const scoped = scope.companyId !== null;
  return holds.map((h) => {
    const seats = seatsByHold.get(h.id) ?? [];
    return {
      id: h.id,
      sessionId: h.sessionId,
      sessionTitle: h.sessionTitle,
      startsAt: h.startsAt,
      isStarted: h.startsAt.getTime() <= now.getTime(),
      isCancelled: h.sessionStatus === "cancelled",
      kind: h.kind,
      quantity: h.quantity,
      used: seats.length,
      companyId: h.companyId,
      companyName: h.companyName,
      note: scoped ? null : h.note,
      seats,
    };
  });
}
