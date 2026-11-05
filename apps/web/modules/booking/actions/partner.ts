"use server";
/**
 * booking server actions, area `partner` (booking spec 4.2, 5.1 and 7, R3, R9-R11; booking-P9):
 * `assignHoldSeat` and `unassignHoldSeat` (`booking.assign_hold_seat`, `booking.unassign_hold_seat`).
 *
 * Who: staff with `bookings.write` on every hold, or a user with `partner.own` on the holds of
 * their own partner company (platform's `requirePartnerOrPermission`; an `external_partner` is
 * always scoped). A hold of another company reads as `not_found`, so a partner learns nothing
 * about it. Both run under the session row lock and the hold row lock (R10): a hold never
 * holds more live bookings than its `quantity` (`session_full`). An assigned seat is a
 * `confirmed`, `paid_with = free` booking with `capacity_hold_id` and `source = admin`; its
 * `booking.confirmed` fact carries `data.partner_company_id` (the hold's company, else the
 * session's organising partner) for ops' partner reports. Assigning and unassigning stop once
 * the session has started (`outside_window`). Every call is audited by the `action()` wrapper.
 * A "use server" file exports async functions only, so the Zod inputs and helpers stay unexported.
 */
import { z } from "zod";
import type { Tx } from "@beam/db";
import { bookings, capacityHolds } from "@beam/db/schema";
import { AlreadyBookedError, BookingConflictError, SessionFullError, bookingTransition } from "@beam/core/booking";
import { action } from "@/lib/action";
import { NotFoundError, and, eq, gt, inArray, or, sql, type Ctx } from "@/lib/ctx";
import { createPersonWithoutEmail, findOrCreatePersonByEmail } from "@/modules/crm/api";
import { requirePartnerOrPermission } from "@/modules/platform/api";
import { LIVE_STATUSES, lockSession, releaseWaitlistEntryOnBooking, sendConfirmationEmail, type SessionRow } from "../server/book";
import { sendCancellationEmail } from "../server/cancel";
import { recordBookingFact } from "../server/facts";

const name = z.string().trim().min(1).max(100);

const AssignHoldSeatInput = z.object({
  holdId: z.uuid(),
  firstName: name,
  lastName: name,
  email: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.email().max(254).optional()),
});

const UnassignHoldSeatInput = z.object({ bookingId: z.uuid() });

type HoldRow = typeof capacityHolds.$inferSelect;

/** The hold, or `not_found` when it does not exist or belongs to another company than the scope's. */
async function scopedHold(tx: Tx, holdId: string, companyId: string | null, lock: boolean): Promise<HoldRow> {
  const q = tx.select().from(capacityHolds).where(eq(capacityHolds.id, holdId));
  const [hold] = lock ? await q.for("update") : await q;
  if (!hold || (companyId !== null && hold.companyId !== companyId)) throw new NotFoundError("hold_not_found");
  return hold;
}

/** R10, R3: the session must still be open to changes and not have started. */
function assertChangeable(session: SessionRow, ctx: Ctx): void {
  if (session.webinarId) throw new BookingConflictError("webinar_session");
  if (session.status === "cancelled") throw new BookingConflictError("session_closed");
  if (session.startsAt.getTime() <= ctx.now.getTime()) throw new BookingConflictError("outside_window", { startsAt: session.startsAt });
}

/** R11: live bookings in the hold (expired reservations do not count), under the hold lock. */
async function holdUsed(tx: Tx, holdId: string, now: Date): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`coalesce(sum(${bookings.capacityUnits}), 0)::int` })
    .from(bookings)
    .where(
      and(
        eq(bookings.capacityHoldId, holdId),
        or(inArray(bookings.status, ["confirmed", "attended", "no_show"]), and(eq(bookings.status, "reserved"), gt(bookings.reservedUntil, now))),
      ),
    );
  return Number(row?.n ?? 0);
}

const factSessionOf = (session: SessionRow, hold: HoldRow) => ({
  kind: session.kind,
  eventCategory: session.eventCategory,
  startsAt: session.startsAt,
  partnerCompanyId: hold.companyId ?? session.partnerCompanyId,
});

/**
 * R3: puts a named person on one seat of a hold. With an email the person is crm's
 * `findOrCreatePersonByEmail` (existing names are never overwritten, no consent implied); without
 * one, `createPersonWithoutEmail`. Acquisition `partner` with the hold's company. The attendee
 * gets the confirmation email with their QR code when they have an email.
 */
export const assignHoldSeat = action(
  {
    name: "booking.assign_hold_seat",
    audience: "staff",
    input: AssignHoldSeatInput,
    audit: { entityType: "booking", entityId: (_i, o: { bookingId: string; personId: string }) => o.bookingId, personId: (_i, o) => o.personId },
  },
  async (ctx, input): Promise<{ bookingId: string; personId: string }> => {
    const { companyId } = await requirePartnerOrPermission(ctx, "bookings.write");
    const tx = ctx.tx;
    const found = await scopedHold(tx, input.holdId, companyId, false);
    const session = await lockSession(tx, found.sessionId);
    const hold = await scopedHold(tx, input.holdId, companyId, true);
    assertChangeable(session, ctx);
    if ((await holdUsed(tx, hold.id, ctx.now)) + 1 > hold.quantity) throw new SessionFullError({ holdId: hold.id, quantity: hold.quantity });

    const acquisition = {
      source: "partner" as const,
      ...(hold.companyId ? { partner_company_id: hold.companyId } : {}),
      ...(session.kind === "event" ? { event_session_id: session.id } : {}),
    };
    const email = input.email?.trim();
    const personId = email
      ? (await findOrCreatePersonByEmail(tx, ctx, { email, firstName: input.firstName, lastName: input.lastName, locale: ctx.locale, acquisition })).personId
      : (await createPersonWithoutEmail(tx, ctx, { firstName: input.firstName, lastName: input.lastName, locale: ctx.locale, acquisition })).personId;

    // R14: one live booking per person and session.
    const [existing] = await tx
      .select({ id: bookings.id })
      .from(bookings)
      .where(and(eq(bookings.sessionId, session.id), eq(bookings.personId, personId), inArray(bookings.status, [...LIVE_STATUSES])));
    if (existing) throw new AlreadyBookedError();

    bookingTransition(null, "confirmed", "staff");
    let row: typeof bookings.$inferSelect;
    try {
      [row] = (await tx
        .insert(bookings)
        .values({
          sessionId: session.id,
          personId,
          status: "confirmed",
          paidWith: "free",
          capacityUnits: 1,
          capacityHoldId: hold.id,
          bookedByUserId: ctx.actor.kind === "staff" ? ctx.actor.userId : null,
          source: "admin",
        })
        .returning()) as [typeof bookings.$inferSelect];
    } catch (error) {
      const e = error as { code?: unknown; cause?: { code?: unknown } } | null;
      if (e?.code === "23505" || e?.cause?.code === "23505") throw new AlreadyBookedError();
      throw error;
    }

    await recordBookingFact(ctx, "booking.confirmed", row, { session: factSessionOf(session, hold), by: "staff" });
    await sendConfirmationEmail(ctx, row, session);
    await releaseWaitlistEntryOnBooking(ctx, session.id, personId);
    return { bookingId: row.id, personId };
  },
);

/**
 * R3: frees one seat of a hold again. The booking becomes `cancelled` (code `staff`); the seat
 * goes back to the hold, not to general capacity, so no waitlist offer follows. The attendee
 * gets the cancellation email when they have an email.
 */
export const unassignHoldSeat = action(
  {
    name: "booking.unassign_hold_seat",
    audience: "staff",
    input: UnassignHoldSeatInput,
    audit: { entityType: "booking", entityId: (i) => i.bookingId, personId: (_i, o: { bookingId: string; personId: string }) => o.personId },
  },
  async (ctx, input): Promise<{ bookingId: string; personId: string }> => {
    const { companyId } = await requirePartnerOrPermission(ctx, "bookings.write");
    const tx = ctx.tx;
    const [found] = await tx.select({ sessionId: bookings.sessionId, holdId: bookings.capacityHoldId }).from(bookings).where(eq(bookings.id, input.bookingId));
    if (!found?.holdId) throw new NotFoundError("hold_seat_not_found");
    await scopedHold(tx, found.holdId, companyId, false);
    const session = await lockSession(tx, found.sessionId);
    const hold = await scopedHold(tx, found.holdId, companyId, true);
    const [booking] = await tx.select().from(bookings).where(eq(bookings.id, input.bookingId)).for("update");
    if (!booking || booking.capacityHoldId !== hold.id) throw new NotFoundError("hold_seat_not_found");
    assertChangeable(session, ctx);
    bookingTransition(booking.status, "cancelled", "staff");

    const [updated] = await tx
      .update(bookings)
      .set({ status: "cancelled", cancelledAt: ctx.now, cancelReasonCode: "staff", version: sql`${bookings.version} + 1`, updatedAt: ctx.now })
      .where(eq(bookings.id, booking.id))
      .returning();
    await recordBookingFact(ctx, "booking.cancelled", updated!, { session: factSessionOf(session, hold), by: "staff", cancelReasonCode: "staff" });
    await sendCancellationEmail(ctx, updated!, session, { notify: true, refunded: false, creditReleased: false });
    return { bookingId: booking.id, personId: booking.personId };
  },
);
