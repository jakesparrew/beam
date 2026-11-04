/**
 * Attendance jobs (booking spec 4.5, R37, R39): `bookings.mark_no_shows`. Registered in
 * `../jobs.ts` (booking-P1) with this name, input and signature; booking-P8 adds the
 * `booking.event_ended` step. Also holds the attendance helpers the staff actions in
 * `../actions/attendance.ts` share with the job (a "use server" file may export actions only):
 * the check-in window of R35 and the `confirmed -> no_show` change of R37.
 */
import { z } from "zod";
import type { Tx } from "@beam/db";
import { bookings, sessions } from "@beam/db/schema";
import { bookingTransition, type BookingRules } from "@beam/core/booking";
import type { JobCtx } from "@/lib/job-runner";
import { and, asc, eq, inArray, sql, type Ctx } from "@/lib/ctx";
import { getSetting } from "@/lib/settings";
import { releaseCredits } from "@/modules/credits/api";
import type { BookingRow, SessionRow } from "../server/book";
import { transitionActor } from "../server/cancel";
import { recordBookingFact } from "../server/facts";

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

/**
 * R37: marks `confirmed` rows of ended sessions `no_show` when `no_show.auto_mark = true`.
 * Idempotent: a second run finds no `confirmed` row of those sessions, and the
 * `booking:<id>:no_show:<version>` key dedupes the fact (edge case 20).
 */
export async function runMarkNoShows(ctx: JobCtx, _input: z.infer<typeof MarkNoShowsInput>): Promise<{ marked: number; creditsReleased: number; skipped?: "auto_mark_off" }> {
  const rules: BookingRules = await getSetting(ctx.tx, "booking_rules");
  if (!rules.no_show.auto_mark) return { marked: 0, creditsReleased: 0, skipped: "auto_mark_off" };
  const due = await dueNoShows(ctx.tx, ctx.now, rules.no_show.after_end_minutes, NO_SHOW_BATCH);
  let marked = 0;
  let creditsReleased = 0;
  for (const row of due) {
    const r = await markNoShowRow(ctx, row.booking, row.session, rules, "system");
    marked++;
    if (r.creditReleased) creditsReleased++;
  }
  return { marked, creditsReleased };
}
