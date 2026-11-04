/**
 * booking's GDPR registration (booking spec section 9, architecture section 11, ops rule 62).
 * Facade read by `pnpm gen:indexes`; ops runs export, erase and the retention sweeps.
 * booking-P6 implements `export`, `erase`, `sweep` and `retention`.
 *
 * - `export`: `booking/bookings.json` (every row where the person attends, booked it, or owns
 *   the booking a guest row hangs off; other people appear by first name only) and
 *   `booking/waitlist.json`. Staff free text (`notes`, `cancel_reason`), check-in codes and the
 *   staff user who booked are not exported.
 * - `erase` (after credits and commerce, before crm anonymises `persons`): waitlist entries are
 *   deleted; future live rows where the person attends are cancelled with code `erased` (no
 *   refund, no credit release, no email) and `waitlist.offer_next` is enqueued per affected
 *   session (R34); then every row of the person loses its free text, gets a fresh check-in code
 *   and loses its QR file; `booked_by_person_id` is cleared on other people's guest rows, which
 *   otherwise stay as they are. Rows linked to an order line are `retained_legal` (accounting).
 * - `sweep`: `booking.waitlist_entries` deletes, `booking.bookings_free_text` clears `notes` and
 *   `cancel_reason`, both for sessions that started before the cutoff, one batch per call.
 */
import type { Tx } from "@beam/db";
import { bookings, files, sessions, waitlistEntries } from "@beam/db/schema";
import { newCheckinCode } from "@beam/core/booking";
import type { EraseReportRow, PrivacyRegistration, RetentionPolicySeed } from "@beam/core/privacy";
import { BOOKING_RETENTION_POLICIES } from "@beam/db/seed/booking";
import { and, asc, createCtx, eq, gt, inArray, sql } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { LIVE_STATUSES, lockSession } from "./server/book";
import { enqueueOfferNext } from "./server/cancel";

/** One sweep batch; equals `retention_policies.batch_size`'s default, so ops calls again while full. */
export const SWEEP_BATCH = 1000;

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const allowRewrite = (tx: Tx) => tx.execute(sql`set local beam.allow_rewrite = 'on'`);

/** The module's retention rows (the same list the booking defaults seed inserts). */
export const retention: readonly RetentionPolicySeed[] = BOOKING_RETENTION_POLICIES.map((p) => ({ ...p }));

/** Retention handlers, anchored on the session's `starts_at` (section 9, cross-module D37). */
export const sweep: Record<string, (tx: Tx, cutoff: Date) => Promise<number>> = {
  "booking.waitlist_entries": async (tx, cutoff) =>
    rowsOf(
      await tx.execute(sql`delete from waitlist_entries where id in (
          select w.id from waitlist_entries w join sessions s on s.id = w.session_id
          where s.starts_at < ${cutoff} order by w.id limit ${SWEEP_BATCH})
        returning id`),
    ).length,
  "booking.bookings_free_text": async (tx, cutoff) =>
    rowsOf(
      await tx.execute(sql`update bookings set notes = null, cancel_reason = null, updated_at = now() where id in (
          select b.id from bookings b join sessions s on s.id = b.session_id
          where s.starts_at < ${cutoff} and (b.notes is not null or b.cancel_reason is not null)
          order by b.id limit ${SWEEP_BATCH})
        returning id`),
    ).length,
};

type ExportRow = {
  id: string;
  personId: string;
  bookedByPersonId: string | null;
  guestOfBookingId: string | null;
  ownerPersonId: string | null;
  ownerFirstName: string | null;
  attendeeFirstName: string | null;
  status: string;
  paidWith: string;
  source: string;
  createdAt: Date;
  cancelledAt: Date | null;
  cancelReasonCode: string | null;
  attendedAt: Date | null;
  noShowMarkedAt: Date | null;
  rescheduledFromBookingId: string | null;
  title: unknown;
  kind: string;
  startsAt: Date;
  endsAt: Date;
  location: string | null;
};

async function exportPerson(tx: Tx, personId: string): Promise<Record<string, unknown>> {
  const owner = sql`owner_b`;
  const rows = rowsOf<Record<string, unknown>>(
    await tx.execute(sql`
      select b.id, b.person_id, b.booked_by_person_id, b.guest_of_booking_id, ${owner}.person_id as owner_person_id,
        op.first_name as owner_first_name, ap.first_name as attendee_first_name,
        b.status, b.paid_with, b.source, b.created_at, b.cancelled_at, b.cancel_reason_code, b.attended_at,
        b.no_show_marked_at, b.rescheduled_from_booking_id,
        s.title, s.kind, s.starts_at, s.ends_at, s.location
      from bookings b
      join sessions s on s.id = b.session_id
      join persons ap on ap.id = b.person_id
      left join bookings ${owner} on ${owner}.id = b.guest_of_booking_id
      left join persons op on op.id = ${owner}.person_id
      where b.person_id = ${personId} or b.booked_by_person_id = ${personId} or ${owner}.person_id = ${personId}
      order by s.starts_at, b.created_at, b.id`),
  );
  const date = (v: unknown) => (v == null ? null : v instanceof Date ? v : new Date(String(v)));
  const bookingsJson = rows.map((raw) => {
    const r: ExportRow = {
      id: String(raw.id),
      personId: String(raw.person_id),
      bookedByPersonId: (raw.booked_by_person_id as string | null) ?? null,
      guestOfBookingId: (raw.guest_of_booking_id as string | null) ?? null,
      ownerPersonId: (raw.owner_person_id as string | null) ?? null,
      ownerFirstName: (raw.owner_first_name as string | null) ?? null,
      attendeeFirstName: (raw.attendee_first_name as string | null) ?? null,
      status: String(raw.status),
      paidWith: String(raw.paid_with),
      source: String(raw.source),
      createdAt: date(raw.created_at)!,
      cancelledAt: date(raw.cancelled_at),
      cancelReasonCode: (raw.cancel_reason_code as string | null) ?? null,
      attendedAt: date(raw.attended_at),
      noShowMarkedAt: date(raw.no_show_marked_at),
      rescheduledFromBookingId: (raw.rescheduled_from_booking_id as string | null) ?? null,
      title: typeof raw.title === "string" ? (JSON.parse(raw.title) as unknown) : raw.title,
      kind: String(raw.kind),
      startsAt: date(raw.starts_at)!,
      endsAt: date(raw.ends_at)!,
      location: (raw.location as string | null) ?? null,
    };
    const attends = r.personId === personId;
    return {
      booking_id: r.id,
      role: attends ? (r.guestOfBookingId ? "guest" : "attendee") : "booker",
      session_title: r.title,
      session_kind: r.kind,
      starts_at: iso(r.startsAt),
      ends_at: iso(r.endsAt),
      location: r.location,
      status: r.status,
      paid_with: r.paidWith,
      source: r.source,
      booked_at: iso(r.createdAt),
      // Other people by first name only.
      guest_of: attends && r.guestOfBookingId && r.ownerPersonId !== personId ? r.ownerFirstName : null,
      guest_first_name: attends ? null : r.attendeeFirstName,
      rescheduled: r.rescheduledFromBookingId !== null,
      cancelled_at: iso(r.cancelledAt),
      cancel_reason_code: r.cancelReasonCode,
      attended_at: iso(r.attendedAt),
      no_show_marked_at: iso(r.noShowMarkedAt),
    };
  });

  const entries = await tx
    .select({ w: waitlistEntries, title: sessions.title, kind: sessions.kind, startsAt: sessions.startsAt })
    .from(waitlistEntries)
    .innerJoin(sessions, eq(sessions.id, waitlistEntries.sessionId))
    .where(eq(waitlistEntries.personId, personId))
    .orderBy(asc(waitlistEntries.joinedAt), asc(waitlistEntries.id));
  const waitlistJson = entries.map(({ w, title, kind, startsAt }) => ({
    session_title: title,
    session_kind: kind,
    starts_at: iso(startsAt),
    queue: w.queue,
    state: w.state,
    joined_at: iso(w.joinedAt),
    offered_at: iso(w.offeredAt),
    offer_expires_at: iso(w.offerExpiresAt),
    ended_reason: w.endedReason,
  }));

  return { "booking/bookings.json": bookingsJson, "booking/waitlist.json": waitlistJson };
}

async function erasePerson(tx: Tx, personId: string): Promise<EraseReportRow[]> {
  await allowRewrite(tx);
  const ctx = createCtx({ tx, actor: { kind: "system", jobId: "" }, requestId: "privacy:erase:booking" });
  const now = ctx.now;

  // Waitlist entries: deleted. A live offer of the person frees its seat, so the session offers on.
  const deletedEntries = await tx
    .delete(waitlistEntries)
    .where(eq(waitlistEntries.personId, personId))
    .returning({ id: waitlistEntries.id, sessionId: waitlistEntries.sessionId, state: waitlistEntries.state, bookingId: waitlistEntries.bookingId });
  const freedSessions = new Map<string, string>();
  for (const e of deletedEntries) if (e.state === "offered" && !e.bookingId) freedSessions.set(e.sessionId, `erase:${e.id}`);

  // Future live rows the person attends: cancelled (`erased`), no refund, no release, no email.
  const future = await tx
    .select({ id: bookings.id, sessionId: bookings.sessionId })
    .from(bookings)
    .innerJoin(sessions, eq(sessions.id, bookings.sessionId))
    .where(and(eq(bookings.personId, personId), inArray(bookings.status, [...LIVE_STATUSES]), gt(sessions.startsAt, now)))
    .orderBy(asc(bookings.sessionId), asc(bookings.id));
  for (const sessionId of [...new Set(future.map((f) => f.sessionId))].sort()) await lockSession(tx, sessionId);
  if (future.length) {
    await tx
      .update(bookings)
      .set({ status: "cancelled", cancelledAt: now, cancelReasonCode: "erased", reservedUntil: null, version: sql`${bookings.version} + 1`, updatedAt: now })
      .where(inArray(bookings.id, future.map((f) => f.id)));
  }
  for (const f of future) if (!freedSessions.has(f.sessionId)) freedSessions.set(f.sessionId, f.id);
  for (const [sessionId, trigger] of [...freedSessions].sort(([a], [b]) => a.localeCompare(b))) {
    const [s] = await tx.select({ status: sessions.status }).from(sessions).where(eq(sessions.id, sessionId));
    if (s && s.status !== "cancelled") await enqueueOfferNext(ctx, sessionId, trigger);
  }

  // Every row the person attends: no free text, a fresh check-in code, no QR file.
  const own = await tx
    .select({ id: bookings.id, qrFileId: bookings.qrFileId, orderLineId: bookings.orderLineId })
    .from(bookings)
    .where(eq(bookings.personId, personId))
    .orderBy(asc(bookings.id));
  for (const b of own) {
    await tx
      .update(bookings)
      .set({ notes: null, cancelReason: null, checkinCode: newCheckinCode(), qrFileId: null, updatedAt: now })
      .where(eq(bookings.id, b.id));
  }
  const qrIds = own.flatMap((b) => (b.qrFileId ? [b.qrFileId] : []));
  if (qrIds.length) await tx.delete(files).where(inArray(files.id, qrIds));

  // Other people's guest rows the person booked stay; only the booker link goes.
  const unlinked = await tx
    .update(bookings)
    .set({ bookedByPersonId: null, updatedAt: now })
    .where(eq(bookings.bookedByPersonId, personId))
    .returning({ id: bookings.id, personId: bookings.personId });

  const legal = own.filter((b) => b.orderLineId !== null).length;
  return [
    { table: "waitlist_entries", rows: deletedEntries.length, action: "deleted" },
    { table: "bookings", rows: own.length - legal, action: "anonymised" },
    { table: "bookings", rows: legal, action: "retained_legal" },
    { table: "bookings", rows: unlinked.filter((u) => u.personId !== personId).length, action: "unlinked" },
  ];
}

export const privacy: PrivacyRegistration<Tx> = {
  tables: ["bookings", "waitlist_entries"],
  export: exportPerson,
  erase: erasePerson,
  sweep,
  retention,
};

/** The section 9 name of the registration (the generated registry imports `privacy`). */
export const bookingPrivacy = privacy;

/** Booking tables without a person reference (section 9). */
export const noPiiTables = ["sessions", "session_templates", "session_exceptions", "capacity_holds", "ticket_types"] as const;
