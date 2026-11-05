/**
 * Attendance jobs (booking spec 4.5, R37, R39): `bookings.mark_no_shows`. Registered in
 * `../jobs.ts` (booking-P1) with this name, input and signature; booking-P8 added the
 * `booking.event_ended` step (R39, R2), which runs whether or not `no_show.auto_mark` is on. Also holds the attendance helpers the staff actions in
 * `../actions/attendance.ts` share with the job (a "use server" file may export actions only):
 * the check-in window of R35 and the `confirmed -> no_show` change of R37.
 */
import { z } from "zod";
import type { Tx } from "@beam/db";
import { activityEvents, bookings, sessions } from "@beam/db/schema";
import { bookingTransition, type BookingRules } from "@beam/core/booking";
import type { JobCtx } from "@/lib/job-runner";
import { and, asc, eq, inArray, sql, type Ctx } from "@/lib/ctx";
import { getSetting } from "@/lib/settings";
import { releaseCredits } from "@/modules/credits/api";
import type { BookingRow, SessionRow } from "../server/book";
import { transitionActor } from "../server/cancel";
import { isFirstBooking, isFirstVisit, lockPerson, recordBookingFact } from "../server/facts";

export const MarkNoShowsInput = z.object({});

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** Rows handled per run (the next run, 15 minutes later, takes the rest). */
const NO_SHOW_BATCH = 500;

type WindowSession = Pick<SessionRow, "startsAt" | "endsAt">;

/** R35: check-in is open from `starts_at - opens_minutes_before_start` to `ends_at + closes_minutes_after_end`. */
export function checkInWindow(session: WindowSession, rules: BookingRules): { opensAt: Date; closesAt: Date } {
  return {
    opensAt: new Date(session.startsAt.getTime() - rules.check_in.opens_minutes_before_start * MINUTE),
    closesAt: new Date(session.endsAt.getTime() + rules.check_in.closes_minutes_after_end * MINUTE),
  };
}

/** R35: true while `now` is inside the check-in window (undo check-in uses the same end, R36). */
export function isInCheckInWindow(session: WindowSession, rules: BookingRules, now: Date): boolean {
  const w = checkInWindow(session, rules);
  return now.getTime() >= w.opensAt.getTime() && now.getTime() <= w.closesAt.getTime();
}

/** R37: the last instant a `no_show` may be turned into `attended` (`ends_at + revert_no_show_days`). */
export function revertNoShowUntil(session: WindowSession, rules: BookingRules): Date {
  return new Date(session.endsAt.getTime() + rules.check_in.revert_no_show_days * DAY);
}

const usesCredit = (b: Pick<BookingRow, "paidWith">) => b.paidWith === "credit" || b.paidWith === "guest";

const factSession = (s: Pick<SessionRow, "kind" | "eventCategory" | "startsAt" | "partnerCompanyId">) => ({
  kind: s.kind,
  eventCategory: s.eventCategory,
  startsAt: s.startsAt,
  partnerCompanyId: s.partnerCompanyId,
});

/**
 * R37: one locked `confirmed` row becomes `no_show` (`no_show_marked_at = now`, version + 1) and
 * writes `booking.no_show`. Credits stay consumed unless `no_show.releases_credit` (reason
 * `no_show_released`). Returns the updated row.
 */
export async function markNoShowRow(
  ctx: Ctx,
  booking: BookingRow,
  session: Pick<SessionRow, "kind" | "eventCategory" | "startsAt" | "partnerCompanyId">,
  rules: BookingRules,
  by: "staff" | "system",
): Promise<{ booking: BookingRow; creditReleased: boolean }> {
  bookingTransition(booking.status, "no_show", transitionActor(ctx));
  const [row] = await ctx.tx
    .update(bookings)
    .set({ status: "no_show", noShowMarkedAt: ctx.now, version: sql`${bookings.version} + 1`, updatedAt: ctx.now })
    .where(eq(bookings.id, booking.id))
    .returning();
  const updated = row!;
  let creditReleased = false;
  if (rules.no_show.releases_credit && usesCredit(booking)) {
    const { releasedUnits } = await releaseCredits(ctx.tx, ctx, { ref: { type: "booking", id: booking.id }, reason: "no_show_released" });
    creditReleased = releasedUnits > 0;
  }
  await recordBookingFact(ctx, "booking.no_show", updated, { session: factSession(session), by });
  return { booking: updated, creditReleased };
}

/** The `confirmed` rows of sessions with `ends_at + after_end_minutes <= now`, locked, oldest session first. */
async function dueNoShows(tx: Tx, now: Date, afterEndMinutes: number, limit: number) {
  return tx
    .select({ booking: bookings, session: sessions })
    .from(bookings)
    .innerJoin(sessions, eq(sessions.id, bookings.sessionId))
    .where(
      and(
        eq(bookings.status, "confirmed"),
        inArray(sessions.status, ["open", "closed"]),
        sql`${sessions.endsAt} + make_interval(mins => ${afterEndMinutes}) <= ${now.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(asc(sessions.endsAt), asc(bookings.id))
    .limit(limit)
    .for("update", { of: bookings, skipLocked: true });
}

/** Rows handled per run by the event-ended step. */
const EVENT_ENDED_BATCH = 500;
/**
 * R39 "no backfill burst": only events whose follow-up moment (`ends_at + after_end_minutes`) lies
 * within this window are handled, so the first run after deployment does not emit facts for every
 * past event. The job runs every 15 minutes, so a live event is never missed.
 */
export const EVENT_ENDED_LOOKBACK_MS = 2 * DAY;

/** R39: the dedupe key of the post-event fact, one per booking (no version part). */
export const eventEndedKey = (bookingId: string) => `booking:${bookingId}:event_ended`;

/**
 * R39: `attended`, `no_show` and still `confirmed` rows of events past `ends_at +
 * after_end_minutes` (inside the lookback) without a `booking.event_ended` fact yet.
 */
async function dueEventEnded(tx: Tx, now: Date, afterEndMinutes: number, limit: number) {
  const followUp = sql`${sessions.endsAt} + make_interval(mins => ${afterEndMinutes})`;
  return tx
    .select({ booking: bookings, session: sessions })
    .from(bookings)
    .innerJoin(sessions, eq(sessions.id, bookings.sessionId))
    .where(
      and(
        eq(sessions.kind, "event"),
        inArray(sessions.status, ["open", "closed"]),
        inArray(bookings.status, ["attended", "no_show", "confirmed"]),
        sql`${followUp} <= ${now.toISOString()}::timestamptz`,
        sql`${followUp} > ${new Date(now.getTime() - EVENT_ENDED_LOOKBACK_MS).toISOString()}::timestamptz`,
        sql`not exists (select 1 from ${activityEvents} ae where ae.dedupe_key = 'booking:' || ${bookings.id}::text || ':event_ended')`,
      ),
    )
    .orderBy(asc(sessions.endsAt), asc(bookings.id))
    .limit(limit)
    .for("update", { of: bookings, skipLocked: true });
}

/**
 * R39: one `booking.event_ended { attended, event_category }` per booking row (owner and guests)
 * with the R61 keys, dedupe `booking:<id>:event_ended`. Returns whether a fact was written.
 */
export async function recordEventEnded(ctx: Ctx, booking: BookingRow, session: Pick<SessionRow, "kind" | "eventCategory" | "startsAt" | "partnerCompanyId">): Promise<boolean> {
  let ownerPersonId = booking.personId;
  let guestOfPersonId: string | null = null;
  if (booking.guestOfBookingId) {
    const [owner] = await ctx.tx.select({ personId: bookings.personId }).from(bookings).where(eq(bookings.id, booking.guestOfBookingId));
    if (owner) {
      ownerPersonId = owner.personId;
      guestOfPersonId = owner.personId;
    }
  }
  await lockPerson(ctx.tx, booking.personId);
  const data: Record<string, unknown> = {
    session_id: booking.sessionId,
    session_kind: session.kind,
    event_category: session.eventCategory ?? null,
    starts_at: session.startsAt,
    paid_with: booking.paidWith,
    is_guest: booking.guestOfBookingId !== null,
    guest_of_person_id: guestOfPersonId,
    owner_person_id: ownerPersonId,
    is_first_booking: await isFirstBooking(ctx.tx, booking.personId, booking.id),
    is_first_visit: await isFirstVisit(ctx.tx, booking.personId, booking.id),
    queue: null,
    booking_id: booking.id,
    source: booking.source,
    by: "system",
    attended: booking.status === "attended",
  };
  if (session.partnerCompanyId) data.partner_company_id = session.partnerCompanyId;
  const { id } = await ctx.recordEvent({
    kind: "booking.event_ended",
    personId: booking.personId,
    data,
    ref: { type: "booking", id: booking.id },
    dedupeKey: eventEndedKey(booking.id),
  });
  return id !== null;
}

/** R39: the post-event step of the job; independent of `no_show.auto_mark`. */
async function emitEventEnded(ctx: JobCtx, rules: BookingRules): Promise<number> {
  const due = await dueEventEnded(ctx.tx, ctx.now, rules.no_show.after_end_minutes, EVENT_ENDED_BATCH);
  let emitted = 0;
  for (const row of due) if (await recordEventEnded(ctx, row.booking, row.session)) emitted++;
  return emitted;
}

/**
 * R37: marks `confirmed` rows of ended sessions `no_show` when `no_show.auto_mark = true`, then
 * (R39) emits `booking.event_ended` for the bookings of ended events, after the marking so the
 * `attended` flag reads the final status. Idempotent: a second run finds no `confirmed` row of
 * those sessions and no booking without its event-ended fact, and the
 * `booking:<id>:no_show:<version>` / `booking:<id>:event_ended` keys dedupe the facts (edge case 20).
 */
export async function runMarkNoShows(
  ctx: JobCtx,
  _input: z.infer<typeof MarkNoShowsInput>,
): Promise<{ marked: number; creditsReleased: number; eventsEnded: number; skipped?: "auto_mark_off" }> {
  const rules: BookingRules = await getSetting(ctx.tx, "booking_rules");
  let marked = 0;
  let creditsReleased = 0;
  if (rules.no_show.auto_mark) {
    const due = await dueNoShows(ctx.tx, ctx.now, rules.no_show.after_end_minutes, NO_SHOW_BATCH);
    for (const row of due) {
      const r = await markNoShowRow(ctx, row.booking, row.session, rules, "system");
      marked++;
      if (r.creditReleased) creditsReleased++;
    }
  }
  const eventsEnded = await emitEventEnded(ctx, rules);
  return rules.no_show.auto_mark ? { marked, creditsReleased, eventsEnded } : { marked, creditsReleased, eventsEnded, skipped: "auto_mark_off" };
}
