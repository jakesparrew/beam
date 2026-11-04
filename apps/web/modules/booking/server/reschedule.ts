/**
 * Reschedule (booking spec R31, R59, R61, R34): in one transaction the old owner row and its live
 * guests become `cancelled` (code `rescheduled`, no refund) and new `confirmed` rows are created on
 * the target session with `rescheduled_from_booking_id`, the same `paid_with`, `order_line_id`
 * and guests. Credits are released on the old rows (`rescheduled`) and consumed on the new ones.
 * Facts: `booking.rescheduled`, `booking.cancelled` (old) and `booking.confirmed` (new, the old
 * `is_first_booking` carried over); the only email is one `booking.booking_rescheduled` per
 * attendee with an email.
 */
import { randomUUID } from "node:crypto";
import type { Tx } from "@beam/db";
import { activityEvents, bookings, creditEntries, persons } from "@beam/db/schema";
import { AlreadyBookedError, BookingConflictError, SessionFullError, bookingTransition, canReschedule, computeAvailability, type BookingRules } from "@beam/core/booking";
import { URL_SEGMENT, formatDateTime, pick } from "@beam/core/i18n";
import { ForbiddenError } from "@beam/core/errors";
import { NotFoundError, ValidationError, actorHasPermission, and, asc, desc, eq, inArray, sql, type Ctx } from "@/lib/ctx";
import { getSetting } from "@/lib/settings";
import { consumeCredits, releaseCredits } from "@/modules/credits/api";
import { sendTransactional } from "@/modules/email/api";
import { LIVE_STATUSES, lockSession, mapCreditError, readAvailabilityRow, releaseWaitlistEntryOnBooking, viewerFor, type BookingRow, type SessionRow } from "./book";
import { enqueueOfferNext, transitionActor } from "./cancel";
import { recordBookingFact } from "./facts";
import { qrAttachment, renderCheckinQr } from "./qr";

export type RescheduleInput = {
  bookingId: string;
  expectedVersion: number;
  targetSessionId: string;
  by: "customer" | "staff";
  /** Staff reason (audited; written to `cancel_reason` of the old row). */
  reason?: string;
};

export type RescheduleResult = { newBookingId: string; bookingIds: string[] };

const appUrl = (path: string) => `${(process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "")}${path}`;

/** Reschedules so far along the chain of `rescheduled_from_booking_id` (R31 `max_reschedules_per_booking`). */
export async function rescheduleChainLength(tx: Tx, booking: Pick<BookingRow, "rescheduledFromBookingId">): Promise<number> {
  let n = 0;
  let from = booking.rescheduledFromBookingId;
  while (from && n < 100) {
    n++;
    const [prev] = await tx.select({ from: bookings.rescheduledFromBookingId }).from(bookings).where(eq(bookings.id, from));
    from = prev?.from ?? null;
  }
  return n;
}

/** The `is_first_booking` written on the old row's last `booking.confirmed` fact (null when none). */
async function previousFirstBooking(tx: Tx, bookingId: string): Promise<boolean | null> {
  const [fact] = await tx
    .select({ data: activityEvents.data })
    .from(activityEvents)
    .where(and(eq(activityEvents.kind, "booking.confirmed"), eq(activityEvents.refType, "booking"), eq(activityEvents.refId, bookingId)))
    .orderBy(desc(activityEvents.id))
    .limit(1);
  const v = (fact?.data as { is_first_booking?: unknown } | undefined)?.is_first_booking;
  return typeof v === "boolean" ? v : null;
}

/** The person whose grant paid a credit row (the consume entry's owner; a guest row is paid by the owner's grant). */
async function creditPayer(tx: Tx, booking: BookingRow): Promise<string> {
  const [entry] = await tx
    .select({ personId: creditEntries.personId })
    .from(creditEntries)
    .where(and(eq(creditEntries.kind, "consume"), eq(creditEntries.refType, "booking"), eq(creditEntries.refId, booking.id)))
    .limit(1);
  return entry?.personId ?? booking.bookedByPersonId ?? booking.personId;
}

/** Maps a `canReschedule` refusal to the action error. */
function refuse(code: "outside_window" | "different_kind" | "different_product" | "too_many"): never {
  if (code === "outside_window") throw new BookingConflictError("outside_window");
  throw new ValidationError(`reschedule_${code}`, { targetSessionId: code });
}

/** R31: moves an owner booking and its live guests to `targetSessionId`. */
export async function rescheduleRow(tx: Tx, ctx: Ctx, input: RescheduleInput): Promise<RescheduleResult> {
  const staff = input.by === "staff";
  if (staff && ctx.actor.kind !== "staff") throw new ForbiddenError("forbidden: staff");
  const [peek] = await tx.select({ sessionId: bookings.sessionId }).from(bookings).where(eq(bookings.id, input.bookingId));
  if (!peek) throw new NotFoundError("booking_not_found");
  if (peek.sessionId === input.targetSessionId) throw new ValidationError("reschedule_same_session", { targetSessionId: "same_session" });

  // R10: both session locks, in id order (no deadlock between two opposite reschedules).
  const locked = new Map<string, SessionRow>();
  for (const id of [peek.sessionId, input.targetSessionId].sort()) locked.set(id, await lockSession(tx, id));
  const from = locked.get(peek.sessionId)!;
  const to = locked.get(input.targetSessionId)!;
  const [old] = await tx.select().from(bookings).where(eq(bookings.id, input.bookingId)).for("update");
  const booking = old!;

  if (booking.version !== input.expectedVersion) throw new BookingConflictError("stale_version", { expected: input.expectedVersion, actual: booking.version });
  if (!staff && (ctx.actor.kind !== "customer" || booking.personId !== ctx.actor.personId)) throw new NotFoundError("booking_not_found");
  if (booking.guestOfBookingId) throw new ValidationError("reschedule_owner_row", { bookingId: "guest_row" });
  bookingTransition(booking.status, "cancelled", transitionActor(ctx));
  if (booking.status !== "confirmed") throw new BookingConflictError("invalid_transition", { from: booking.status, to: "cancelled" });

  const rules: BookingRules = await getSetting(tx, "booking_rules");
  const chainLength = await rescheduleChainLength(tx, booking);
  const check = canReschedule(
    { kind: from.kind, startsAt: from.startsAt, paidWith: booking.paidWith, creditKind: from.creditKind, productId: from.productId },
    { kind: to.kind, startsAt: to.startsAt, creditKind: to.creditKind, productId: to.productId },
    rules,
    chainLength,
    ctx.now,
  );
  if (!check.ok) {
    // Staff (`bookings.write`) may move outside the window and past the chain limit; across products needs `bookings.override`.
    const staffMay = staff && (check.code === "outside_window" || check.code === "too_many" || (check.code === "different_product" && actorHasPermission(ctx.actor, "bookings.override")));
    if (!staffMay) refuse(check.code);
  }

  // The target must be bookable now (R7, R64) for the attendees.
  if (to.webinarId) throw new BookingConflictError("webinar_session");
  if (to.status === "cancelled") throw new BookingConflictError("session_closed");
  if (to.status !== "open" && !staff) throw new BookingConflictError("session_closed");
  if (to.startsAt.getTime() <= ctx.now.getTime()) throw new BookingConflictError("outside_window");

  const guests = await tx
    .select()
    .from(bookings)
    .where(and(eq(bookings.guestOfBookingId, booking.id), inArray(bookings.status, ["confirmed"])))
    .orderBy(asc(bookings.createdAt))
    .for("update");
  const moving = [booking, ...guests];
  const units = moving.reduce((n, b) => n + b.capacityUnits, 0);

  const attendeeIds = moving.map((b) => b.personId);
  const already = await tx
    .select({ personId: bookings.personId })
    .from(bookings)
    .where(and(eq(bookings.sessionId, to.id), inArray(bookings.personId, attendeeIds), inArray(bookings.status, [...LIVE_STATUSES])));
  if (already.length) throw new AlreadyBookedError({ personIds: already.map((a) => a.personId) });

  const availability = await readAvailabilityRow(tx, to);
  if (staff) {
    if (to.isMemberOnly && !(await viewerFor(tx, to, booking.personId)).isMember && !actorHasPermission(ctx.actor, "bookings.override")) {
      throw new BookingConflictError("member_only");
    }
    if (availability.availableTotal < units) throw new SessionFullError({ free: availability.availableTotal, needed: units });
  } else {
    const computed = computeAvailability(availability, await viewerFor(tx, to, booking.personId), ctx.now, rules);
    if (computed.reason === "member_only") throw new BookingConflictError("member_only");
    if (computed.reason !== "ok" && computed.reason !== "full") throw new BookingConflictError(computed.reason === "closed" ? "session_closed" : "outside_window");
    if (computed.bookable < units) throw new SessionFullError({ free: computed.bookable, needed: units });
  }

  const firstBooking = await previousFirstBooking(tx, booking.id);
  const by = staff ? "staff" : "customer";
  const actor = transitionActor(ctx);
  const fromFact = { kind: from.kind, eventCategory: from.eventCategory, startsAt: from.startsAt, partnerCompanyId: from.partnerCompanyId };
  const toFact = { kind: to.kind, eventCategory: to.eventCategory, startsAt: to.startsAt, partnerCompanyId: to.partnerCompanyId };

  // Old rows: cancelled, `rescheduled`, credits back (no refund: the order line moves along).
  const payers = new Map<string, string>();
  const cancelled: BookingRow[] = [];
  for (const b of moving) {
    if (b.paidWith === "credit" || b.paidWith === "guest") payers.set(b.id, await creditPayer(tx, b));
    const [row] = await tx
      .update(bookings)
      .set({
        status: "cancelled",
        cancelledAt: ctx.now,
        cancelReasonCode: "rescheduled",
        ...(input.reason?.trim() ? { cancelReason: input.reason.trim() } : {}),
        version: sql`${bookings.version} + 1`,
        updatedAt: ctx.now,
      })
      .where(eq(bookings.id, b.id))
      .returning();
    cancelled.push(row!);
    if (payers.has(b.id)) await releaseCredits(tx, ctx, { ref: { type: "booking", id: b.id }, reason: "rescheduled" });
  }

  // New rows on the target, owner first; guests point at the new owner row.
  const newOwnerId = randomUUID();
  const created: BookingRow[] = [];
  for (const b of moving) {
    bookingTransition(null, "confirmed", actor === "webhook" ? "system" : actor);
    const id = b.id === booking.id ? newOwnerId : randomUUID();
    const [row] = await tx
      .insert(bookings)
      .values({
        id,
        sessionId: to.id,
        personId: b.personId,
        status: "confirmed",
        paidWith: b.paidWith,
        guestOfBookingId: b.guestOfBookingId ? newOwnerId : null,
        capacityUnits: b.capacityUnits,
        orderLineId: b.orderLineId,
        isPayAtDesk: false,
        bookedByUserId: ctx.actor.kind === "staff" ? ctx.actor.userId : b.bookedByUserId,
        bookedByPersonId: b.bookedByPersonId,
        source: b.source,
        rescheduledFromBookingId: b.id,
        notes: b.notes,
      })
      .returning();
    created.push(row!);
    const payer = payers.get(b.id);
    if (payer && to.creditKind && to.creditCost > 0) {
      try {
        await consumeCredits(tx, ctx, { personId: payer, beneficiaryPersonId: b.personId, kind: to.creditKind, units: to.creditCost, ref: { type: "booking", id }, validAt: to.startsAt });
      } catch (error) {
        throw mapCreditError(error);
      }
    }
  }

  // Facts (R31, R61): rescheduled and cancelled on the old row, confirmed on the new one.
  for (let i = 0; i < moving.length; i++) {
    const oldRow = cancelled[i]!;
    const newRow = created[i]!;
    const carried = i === 0 ? firstBooking : await previousFirstBooking(tx, moving[i]!.id);
    await recordBookingFact(ctx, "booking.rescheduled", oldRow, { session: fromFact, by, rescheduledFromBookingId: oldRow.id, newBookingId: newRow.id });
    await recordBookingFact(ctx, "booking.cancelled", oldRow, { session: fromFact, by, cancelReasonCode: "rescheduled" });
    await recordBookingFact(ctx, "booking.confirmed", newRow, {
      session: toFact,
      by,
      rescheduledFromBookingId: oldRow.id,
      ...(carried !== null ? { isFirstBooking: carried } : {}),
    });
  }

  for (const row of created) {
    await sendRescheduledEmail(ctx, row, { from, to });
    await releaseWaitlistEntryOnBooking(ctx, to.id, row.personId);
  }
  // R34: the old seats go to the waitlist.
  if (from.status !== "cancelled") await enqueueOfferNext(ctx, from.id, booking.id);
  return { newBookingId: newOwnerId, bookingIds: created.map((r) => r.id) };
}

/** R59 `booking.booking_rescheduled`: old and new times, QR inline, key `booking:<new id>:confirmed`. */
async function sendRescheduledEmail(ctx: Ctx, booking: BookingRow, s: { from: SessionRow; to: SessionRow }): Promise<boolean> {
  const [person] = await ctx.tx.select({ email: persons.email, locale: persons.locale }).from(persons).where(eq(persons.id, booking.personId));
  if (!person?.email) return false;
  const locale = person.locale;
  const fileId = await renderCheckinQr(ctx, booking);
  await sendTransactional(ctx, {
    template: "booking.booking_rescheduled",
    personId: booking.personId,
    locale,
    data: {
      title: pick(s.to.title, locale, "session title"),
      date: formatDateTime(s.to.startsAt, locale, "full"),
      oldDate: formatDateTime(s.from.startsAt, locale, "full"),
      url: appUrl(`/${URL_SEGMENT[locale]}/account/bookings/${booking.id}`),
    },
    key: `booking:${booking.id}:confirmed`,
    attachments: [qrAttachment(fileId)],
  });
  return true;
}
