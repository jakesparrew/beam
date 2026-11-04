"use server";
/**
 * booking server actions, area `attendance` (booking spec 4.2, R35-R37), booking-P4: `checkIn`,
 * `undoCheckIn`, `markNoShow`, `revertNoShow` and `updateBookingNotes`, all staff with
 * `bookings.write` and audited by the `action()` wrapper (spec 7). Every change locks the booking
 * row, follows `bookingTransition()` and writes its R61 fact. Check-in outside the window of
 * `settings.booking_rules.check_in` (and a code of another day) needs `bookings.override` and
 * `override: true`; a `reserved` (unpaid) row is refused with `payment_required`; a missing or
 * expired health declaration never blocks (R62b). A "use server" file exports async functions
 * only, so Zod inputs and helpers stay unexported.
 */
import { z } from "zod";
import { bookings, orderLines, orders, persons, sessions } from "@beam/db/schema";
import { BookingConflictError, InvalidTransitionError, OutsideWindowError, PaymentRequiredError, bookingTransition, brusselsDate, type BookingRules, type BookingStatus } from "@beam/core/booking";
import { pick } from "@beam/core/i18n";
import { action } from "@/lib/action";
import { NotFoundError, actorHasPermission, eq, sql, type Ctx } from "@/lib/ctx";
import { getSetting } from "@/lib/settings";
import type { BookingRow, SessionRow } from "../server/book";
import { transitionActor } from "../server/cancel";
import { recordBookingFact } from "../server/facts";
import { checkInWindow, isInCheckInWindow, markNoShowRow, revertNoShowUntil } from "../jobs/attendance";
import { codeFromScan } from "../queries/attendance";

type AttendanceResult = { bookingId: string; personName: string; sessionTitle: string; status: BookingStatus; attendedAt: Date | null; alreadyCheckedIn: boolean };

const factSession = (s: SessionRow) => ({ kind: s.kind, eventCategory: s.eventCategory, startsAt: s.startsAt, partnerCompanyId: s.partnerCompanyId });

/** The booking (locked), its session and the attendee's name. */
async function lockBooking(ctx: Ctx, where: { bookingId: string } | { checkinCode: string }) {
  const cond = "bookingId" in where ? eq(bookings.id, where.bookingId) : eq(bookings.checkinCode, where.checkinCode);
  const [booking] = await ctx.tx.select().from(bookings).where(cond).for("update");
  if (!booking) throw new NotFoundError("booking_not_found");
  const [session] = await ctx.tx.select().from(sessions).where(eq(sessions.id, booking.sessionId));
  if (!session) throw new NotFoundError("session_not_found");
  const [person] = await ctx.tx.select({ firstName: persons.firstName, lastName: persons.lastName }).from(persons).where(eq(persons.id, booking.personId));
  const personName = [person?.firstName, person?.lastName].filter((x) => x && x.trim()).join(" ");
  return { booking, session, personName };
}

function result(ctx: Ctx, b: BookingRow, s: SessionRow, personName: string, alreadyCheckedIn = false): AttendanceResult {
  return { bookingId: b.id, personName, sessionTitle: pick(s.title, ctx.locale, "session title"), status: b.status, attendedAt: b.attendedAt, alreadyCheckedIn };
}

/** The unpaid order of a `reserved` row (for the desk's "To pay" and the POS link). */
async function unpaidOrder(ctx: Ctx, booking: BookingRow): Promise<{ orderId: string | null; amountCents: number | null }> {
  if (!booking.orderLineId) return { orderId: null, amountCents: null };
  const [row] = await ctx.tx
    .select({ orderId: orders.id, total: orderLines.lineTotalCents, quantity: orderLines.quantity })
    .from(orderLines)
    .innerJoin(orders, eq(orders.id, orderLines.orderId))
    .where(eq(orderLines.id, booking.orderLineId));
  if (!row) return { orderId: null, amountCents: null };
  return { orderId: row.orderId, amountCents: Math.round(row.total / Math.max(1, row.quantity)) };
}

/** `confirmed | no_show -> attended` with `attended_at = now` and the `booking.attended` fact (R35, R36, R61). */
async function attend(ctx: Ctx, booking: BookingRow, session: SessionRow): Promise<BookingRow> {
  bookingTransition(booking.status, "attended", transitionActor(ctx));
  const [row] = await ctx.tx
    .update(bookings)
    .set({ status: "attended", attendedAt: ctx.now, version: sql`${bookings.version} + 1`, updatedAt: ctx.now })
    .where(eq(bookings.id, booking.id))
    .returning();
  // The dedupe key carries the new version: a check-in after an undo writes a new fact with
  // `is_first_visit` recomputed (R36).
  await recordBookingFact(ctx, "booking.attended", row!, { session: factSession(session), by: "staff" });
  return row!;
}

const CheckInInput = z
  .object({
    bookingId: z.uuid().optional(),
    /** A typed or scanned code, or the QR URL `.../admin/bookings/checkin?c=<code>`. */
    checkinCode: z.string().trim().min(1).max(500).optional(),
    /** Outside the window or another day's session; needs `bookings.override` (R35, edge case 21). */
    override: z.boolean().default(false),
  })
  .refine((v) => !!v.bookingId !== !!v.checkinCode, { message: "booking_or_code", path: ["bookingId"] });

/**
 * R35: `confirmed -> attended`. A row that is already `attended` returns its check-in time and
 * writes nothing (double scan). A `no_show` row inside the window is checked in as well (late
 * arrival after a manual no-show).
 */
export const checkIn = action(
  { name: "booking.check_in", audience: "staff", permission: "bookings.write", input: CheckInInput, audit: { entityType: "booking", entityId: (_i, o: AttendanceResult) => o.bookingId } },
  async (ctx, input): Promise<AttendanceResult> => {
    let where: { bookingId: string } | { checkinCode: string };
    if (input.bookingId) where = { bookingId: input.bookingId };
    else {
      const code = codeFromScan(input.checkinCode ?? "");
      if (!code) throw new NotFoundError("booking_not_found");
      where = { checkinCode: code };
    }
    const { booking, session, personName } = await lockBooking(ctx, where);
    if (booking.status === "attended") return result(ctx, booking, session, personName, true);
    if (booking.status === "reserved") {
      const pay = await unpaidOrder(ctx, booking);
      throw new PaymentRequiredError({ bookingId: booking.id, orderId: pay.orderId, amountCents: pay.amountCents });
    }
    if (booking.status !== "confirmed" && booking.status !== "no_show") bookingTransition(booking.status, "attended", transitionActor(ctx));
    const rules: BookingRules = await getSetting(ctx.tx, "booking_rules");
    const wrongDay = brusselsDate(session.startsAt) !== brusselsDate(ctx.now) && brusselsDate(session.endsAt) !== brusselsDate(ctx.now);
    const inWindow = isInCheckInWindow(session, rules, ctx.now);
    if (wrongDay || !inWindow) {
      if (!input.override || !actorHasPermission(ctx.actor, "bookings.override")) {
        const w = checkInWindow(session, rules);
        throw new OutsideWindowError({ bookingId: booking.id, wrongDay, startsAt: session.startsAt, opensAt: w.opensAt, closesAt: w.closesAt });
      }
    }
    if (session.status === "cancelled") throw new BookingConflictError("invalid_transition", { from: booking.status, to: "attended", session: "cancelled" });
    const row = await attend(ctx, booking, session);
    return result(ctx, row, session, personName);
  },
);

const BookingIdInput = z.object({ bookingId: z.uuid() });

/** R36: `attended -> confirmed` until `ends_at + check_in.closes_minutes_after_end`; writes `booking.check_in_undone`. */
export const undoCheckIn = action(
  { name: "booking.undo_check_in", audience: "staff", permission: "bookings.write", input: BookingIdInput, audit: { entityType: "booking", entityId: (i) => i.bookingId } },
  async (ctx, input): Promise<{ status: BookingStatus }> => {
    const { booking, session } = await lockBooking(ctx, { bookingId: input.bookingId });
    bookingTransition(booking.status, "confirmed", transitionActor(ctx));
    const rules: BookingRules = await getSetting(ctx.tx, "booking_rules");
    const { closesAt } = checkInWindow(session, rules);
    if (ctx.now.getTime() > closesAt.getTime()) throw new OutsideWindowError({ bookingId: booking.id, closesAt });
    const [row] = await ctx.tx
      .update(bookings)
      .set({ status: "confirmed", attendedAt: null, version: sql`${bookings.version} + 1`, updatedAt: ctx.now })
      .where(eq(bookings.id, booking.id))
      .returning();
    await recordBookingFact(ctx, "booking.check_in_undone", row!, { session: factSession(session), by: "staff" });
    return { status: row!.status };
  },
);

/** R37: staff mark a `confirmed` row `no_show` by hand, only after `starts_at`; writes `booking.no_show`. */
export const markNoShow = action(
  { name: "booking.mark_no_show", audience: "staff", permission: "bookings.write", input: BookingIdInput, audit: { entityType: "booking", entityId: (i) => i.bookingId } },
  async (ctx, input): Promise<{ status: BookingStatus }> => {
    const { booking, session } = await lockBooking(ctx, { bookingId: input.bookingId });
    bookingTransition(booking.status, "no_show", transitionActor(ctx));
    if (ctx.now.getTime() < session.startsAt.getTime()) throw new OutsideWindowError({ bookingId: booking.id, startsAt: session.startsAt });
    const rules: BookingRules = await getSetting(ctx.tx, "booking_rules");
    const r = await markNoShowRow(ctx, booking, session, rules, "staff");
    return { status: r.booking.status };
  },
);

/** R37: late check-in correction `no_show -> attended` within `check_in.revert_no_show_days` after `ends_at`. */
export const revertNoShow = action(
  { name: "booking.revert_no_show", audience: "staff", permission: "bookings.write", input: BookingIdInput, audit: { entityType: "booking", entityId: (i) => i.bookingId } },
  async (ctx, input): Promise<{ status: BookingStatus }> => {
    const { booking, session } = await lockBooking(ctx, { bookingId: input.bookingId });
    // Only a no-show is corrected here; a `confirmed` row is checked in with `checkIn`.
    if (booking.status !== "no_show") throw new InvalidTransitionError(booking.status, "attended", { entity: "booking" });
    bookingTransition(booking.status, "attended", transitionActor(ctx));
    const rules: BookingRules = await getSetting(ctx.tx, "booking_rules");
    const until = revertNoShowUntil(session, rules);
    if (ctx.now.getTime() > until.getTime()) throw new OutsideWindowError({ bookingId: booking.id, until });
    const row = await attend(ctx, booking, session);
    return { status: row.status };
  },
);

const NotesInput = z.object({ bookingId: z.uuid(), notes: z.string().max(2000) });

/** Staff-only booking notes (never health information: the form says so, spec 2). An empty text clears them. */
export const updateBookingNotes = action(
  { name: "booking.update_notes", audience: "staff", permission: "bookings.write", input: NotesInput, audit: { entityType: "booking", entityId: (i) => i.bookingId } },
  async (ctx, input): Promise<{ id: string }> => {
    const notes = input.notes.trim();
    const [row] = await ctx.tx
      .update(bookings)
      .set({ notes: notes ? notes : null, version: sql`${bookings.version} + 1`, updatedAt: ctx.now })
      .where(eq(bookings.id, input.bookingId))
      .returning({ id: bookings.id });
    if (!row) throw new NotFoundError("booking_not_found");
    return { id: row.id };
  },
);
