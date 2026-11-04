/**
 * Adding a guest to an existing booking (booking spec R13, R54-R58, R59): within
 * `max_guests_per_booking`, the shared-bed limit and capacity, under the session lock. The guest
 * is a `bookings` row with `guest_of_booking_id = owner row`, paid from the owner's credits
 * (`guest`), by an extra order line (`order`, a `reserved` row and a checkout) or free (staff
 * override). A guest with an email receives `booking.guest_invited` once (key
 * `booking:<id>:confirmed`).
 */
import { randomUUID } from "node:crypto";
import type { Tx } from "@beam/db";
import { bookings, creditEntries, persons } from "@beam/db/schema";
import { AlreadyBookedError, BookingConflictError, SessionFullError, bookingTransition, computeAvailability, type BookingRules } from "@beam/core/booking";
import { URL_SEGMENT, type Locale } from "@beam/core/i18n";
import { ForbiddenError } from "@beam/core/errors";
import { NotFoundError, ValidationError, actorHasPermission, and, eq, inArray, type Ctx } from "@/lib/ctx";
import { getSetting } from "@/lib/settings";
import { createOrder } from "@/modules/commerce/api";
import { consumeCredits } from "@/modules/credits/api";
import { createPersonWithoutEmail, findOrCreatePersonByEmail } from "@/modules/crm/api";
import {
  LIVE_STATUSES,
  PROVISIONAL_RESERVATION_MS,
  lockSession,
  mapCreditError,
  readAvailabilityRow,
  releaseWaitlistEntryOnBooking,
  sendConfirmationEmail,
  viewerFor,
  type BookingRow,
} from "./book";
import { transitionActor } from "./cancel";
import { recordBookingFact } from "./facts";
import { linkOrderLines } from "./order-hooks";

export type AddGuestInput = {
  ownerBookingId: string;
  guest: { firstName: string; lastName: string; email?: string; sharesBed?: boolean; payWith: "guest" | "order" | "free" };
  by: "customer" | "staff";
  /** Idempotency of the order for an order-paid guest (default: a fresh one). */
  clientKey?: string;
  /** Staff reason (required for a free guest of a paid session). */
  reason?: string;
  locale?: Locale;
};

export type AddGuestResult = { kind: "confirmed"; bookingId: string } | { kind: "checkout"; bookingId: string; orderId: string; redirectTo: string };

/** The person whose grant pays the owner's guests: the owner, or the grant owner of a shared package (R55). */
async function guestPayer(tx: Tx, owner: BookingRow): Promise<string> {
  if (owner.paidWith !== "guest") return owner.personId;
  const [entry] = await tx
    .select({ personId: creditEntries.personId })
    .from(creditEntries)
    .where(and(eq(creditEntries.kind, "consume"), eq(creditEntries.refType, "booking"), eq(creditEntries.refId, owner.id)))
    .limit(1);
  return entry?.personId ?? owner.personId;
}

/** R54-R56: adds one guest to an owner booking. */
export async function addGuestRow(tx: Tx, ctx: Ctx, input: AddGuestInput): Promise<AddGuestResult> {
  const staff = input.by === "staff";
  if (staff && ctx.actor.kind !== "staff") throw new ForbiddenError("forbidden: staff");
  const override = staff && actorHasPermission(ctx.actor, "bookings.override");
  const [peek] = await tx.select({ sessionId: bookings.sessionId }).from(bookings).where(eq(bookings.id, input.ownerBookingId));
  if (!peek) throw new NotFoundError("booking_not_found");
  const session = await lockSession(tx, peek.sessionId);
  const [ownerRow] = await tx.select().from(bookings).where(eq(bookings.id, input.ownerBookingId)).for("update");
  const owner = ownerRow!;
  if (!staff && (ctx.actor.kind !== "customer" || owner.personId !== ctx.actor.personId)) throw new NotFoundError("booking_not_found");
  if (owner.guestOfBookingId) throw new ValidationError("guest_of_guest", { ownerBookingId: "guest_row" });
  if (owner.status !== "confirmed") throw new BookingConflictError("invalid_transition", { from: owner.status, reason: "owner_not_confirmed" });
  if (session.webinarId) throw new BookingConflictError("webinar_session");
  if (session.status === "cancelled" || (!staff && session.status !== "open")) throw new BookingConflictError("session_closed");
  if (session.startsAt.getTime() <= ctx.now.getTime()) throw new BookingConflictError("outside_window");

  const rules: BookingRules = await getSetting(tx, "booking_rules");
  const g = input.guest;
  const live = await tx
    .select({ capacityUnits: bookings.capacityUnits })
    .from(bookings)
    .where(and(eq(bookings.guestOfBookingId, owner.id), inArray(bookings.status, [...LIVE_STATUSES])));
  if (live.length + 1 > rules.max_guests_per_booking) throw new ValidationError("too_many_guests", { guests: "too_many" });
  // R13: only a night guest may share the owner's bed, and only when the owner uses one.
  if (g.sharesBed) {
    const sharers = live.filter((r) => r.capacityUnits === 0).length;
    if (session.kind !== "night" || owner.capacityUnits !== 1 || sharers + 1 > rules.max_shared_bed_guests_per_booking) throw new BookingConflictError("shared_bed_limit");
  }

  // R16, R55: payment options of the session.
  if (g.payWith === "guest" && !session.creditKind) throw new ValidationError("pay_with_not_available", { payWith: "not_available" });
  if (g.payWith === "order" && !session.productId) throw new ValidationError("pay_with_not_available", { payWith: "not_available" });
  if (g.payWith === "free") {
    const freeSession = !session.productId && (session.creditKind === null || session.creditCost === 0);
    if (!freeSession && !override) throw new ValidationError("pay_with_not_available", { payWith: "not_available" });
    if (!freeSession && !input.reason?.trim()) throw new ValidationError("reason_required", { reason: "required" });
  }

  const units = g.sharesBed ? 0 : 1;
  const availability = await readAvailabilityRow(tx, session);
  const free = staff ? availability.availableTotal : computeAvailability(availability, await viewerFor(tx, session, owner.personId), ctx.now, rules).bookable;
  if (units > 0 && free < units) throw new SessionFullError({ free, needed: units });

  const [ownerPerson] = await tx.select({ locale: persons.locale }).from(persons).where(eq(persons.id, owner.personId));
  const locale = input.locale ?? ownerPerson!.locale;
  const acquisition = { source: "guest" as const, referrer_person_id: owner.personId };
  const email = g.email?.trim();
  const guestPersonId = email
    ? (await findOrCreatePersonByEmail(tx, ctx, { email, firstName: g.firstName, lastName: g.lastName, locale, acquisition })).personId
    : (await createPersonWithoutEmail(tx, ctx, { firstName: g.firstName, lastName: g.lastName, locale, acquisition })).personId;
  if (guestPersonId === owner.personId) throw new AlreadyBookedError({ reason: "owner_as_guest" });
  const [other] = await tx
    .select({ id: bookings.id })
    .from(bookings)
    .where(and(eq(bookings.sessionId, session.id), eq(bookings.personId, guestPersonId), inArray(bookings.status, [...LIVE_STATUSES])));
  if (other) throw new AlreadyBookedError({ personIds: [guestPersonId] });

  const status = g.payWith === "order" ? "reserved" : "confirmed";
  bookingTransition(null, status, staff ? "staff" : transitionActor(ctx) === "system" ? "system" : "customer");
  const id = randomUUID();
  const [inserted] = await tx
    .insert(bookings)
    .values({
      id,
      sessionId: session.id,
      personId: guestPersonId,
      status,
      paidWith: g.payWith,
      guestOfBookingId: owner.id,
      capacityUnits: units,
      bookedByUserId: ctx.actor.kind === "staff" ? ctx.actor.userId : null,
      bookedByPersonId: owner.personId,
      source: staff ? "admin" : "portal",
      reservedUntil: status === "reserved" ? new Date(ctx.now.getTime() + PROVISIONAL_RESERVATION_MS) : null,
      notes: staff && input.reason?.trim() ? input.reason.trim() : null,
    })
    .returning();
  let row: BookingRow = inserted!;

  if (g.payWith === "guest" && session.creditKind && session.creditCost > 0) {
    try {
      await consumeCredits(tx, ctx, {
        personId: await guestPayer(tx, owner),
        beneficiaryPersonId: guestPersonId,
        kind: session.creditKind,
        units: session.creditCost,
        ref: { type: "booking", id },
        validAt: session.startsAt,
      });
    } catch (error) {
      throw mapCreditError(error);
    }
  }

  let orderId: string | null = null;
  let settled = false;
  if (g.payWith === "order") {
    const order = await createOrder(tx, ctx, {
      personId: owner.personId,
      channel: staff ? "admin" : "portal",
      items: [{ productId: session.productId!, quantity: 1, sessionId: session.id, bookingIds: [id] }],
      promoCode: null,
      clientKey: input.clientKey ?? randomUUID(),
      locale,
    });
    if (order.status === "paid") {
      // Rule 24 (nothing due): commerce already confirmed the row in this transaction, with its
      // line, `booking.confirmed` fact and email.
      const [fresh] = await tx.select().from(bookings).where(eq(bookings.id, id));
      row = fresh!;
      settled = row.status === "confirmed";
    } else {
      orderId = order.orderId;
      const [linked] = await linkOrderLines(tx, [row], order.lineIds);
      row = { ...row, orderLineId: linked!.orderLineId, reservedUntil: linked!.reservedUntil };
    }
  }

  const factSession = { kind: session.kind, eventCategory: session.eventCategory, startsAt: session.startsAt, partnerCompanyId: session.partnerCompanyId };
  if (!settled) await recordBookingFact(ctx, status === "reserved" ? "booking.reserved" : "booking.confirmed", row, { session: factSession, by: input.by });
  await recordBookingFact(ctx, "booking.guest_added", row, { session: factSession, by: input.by, subjectPersonId: owner.personId });
  if (!settled && status === "confirmed") await sendConfirmationEmail(ctx, row, session);
  await releaseWaitlistEntryOnBooking(ctx, session.id, guestPersonId);

  if (!orderId) return { kind: "confirmed", bookingId: id };
  const redirectTo = staff ? `/admin/pos?order=${orderId}` : `/${URL_SEGMENT[locale]}/account/checkout/${orderId}`;
  return { kind: "checkout", bookingId: id, orderId, redirectTo };
}
