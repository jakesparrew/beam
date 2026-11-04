/**
 * The booking engine (booking spec R8-R19, R54-R56, R59, R61-R63): `bookSeats` books an owner
 * and guests on one session from any channel, paid with credits, an order, a shared package
 * (`guest`) or free, in the caller's transaction under the session row lock. Used by the
 * portal and staff actions, the waitlist claim (booking-P5) and the api.
 */
import { randomUUID } from "node:crypto";
import type { DbOrTx, Tx } from "@beam/db";
import { bookings, capacityHolds, orderLines, orders, persons, sessions, ticketTypes, vSessionAvailability, waitlistEntries } from "@beam/db/schema";
import {
  AlreadyBookedError,
  BookingConflictError,
  SessionFullError,
  bookingTransition,
  computeAvailability,
  transition as waitlistTransition,
  type AvailabilityRow,
  type AvailabilityViewer,
  type BookingRules,
  type PaidWith,
} from "@beam/core/booking";
import { URL_SEGMENT, formatDateTime, pick, type Locale } from "@beam/core/i18n";
import { NotFoundError, ValidationError, actorHasPermission, and, eq, gt, inArray, or, sql, type Ctx } from "@/lib/ctx";
import { getSetting } from "@/lib/settings";
import { createOrder } from "@/modules/commerce/api";
import { InsufficientCreditsError, SharingNotAllowedError, consumeCredits, getMembershipForPerson } from "@/modules/credits/api";
import { createPersonWithoutEmail, findOrCreatePersonByEmail, getPersonStatus } from "@/modules/crm/api";
import { sendTransactional } from "@/modules/email/api";
import { ensureHealthAndContact, type EmergencyContactInput } from "./declarations";
import { recordBookingFact } from "./facts";
import { linkOrderLines } from "./order-hooks";
import { qrAttachment, renderCheckinQr } from "./qr";
import { ensureTermsAccepted } from "./terms";

export type SessionRow = typeof sessions.$inferSelect;
export type BookingRow = typeof bookings.$inferSelect;

export type GuestSeatInput = { firstName: string; lastName: string; email?: string; sharesBed?: boolean; payWith: "guest" | "order" | "free" };

export type BookSeatsInput = {
  sessionId: string;
  /** The owner and attendee of the first row (the payer unless `grantOwnerPersonId`). */
  personId: string;
  payWith: PaidWith;
  /** `payWith: 'guest'` for oneself: the owner of the shared grant (R55). */
  grantOwnerPersonId?: string;
  ticketTypeId?: string;
  guests?: GuestSeatInput[];
  promoCode?: string;
  useEuroCredit?: boolean;
  acceptTerms?: boolean;
  emergencyContact?: EmergencyContactInput;
  clientKey: string;
  source: "portal" | "admin" | "site" | "waitlist";
  by: "customer" | "staff";
  /** Staff: fill this capacity hold (R11). */
  holdId?: string;
  /** Staff with `bookings.override`: book past capacity (R12). */
  overCapacity?: boolean;
  /** Staff: pay at the desk on arrival (R63). */
  payAtDesk?: boolean;
  /** Staff reason (required for free and over-capacity bookings). */
  reason?: string;
  /** Default true. */
  sendEmail?: boolean;
  locale?: Locale;
};

export type BookResult =
  | { kind: "confirmed"; bookingIds: string[] }
  | { kind: "checkout"; bookingIds: string[]; orderId: string; redirectTo: string };

/** Live booking statuses that hold a seat (the partial unique index, R14). */
export const LIVE_STATUSES = ["reserved", "confirmed"] as const;
/** Provisional reservation before `createOrder` returns the order's expiry (R18). */
export const PROVISIONAL_RESERVATION_MS = 30 * 60_000;

const appUrl = (path: string) => `${(process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "")}${path}`;

// ---------------------------------------------------------------------------
// Shared helpers (order hooks, api)
// ---------------------------------------------------------------------------

/** R10: `select ... from sessions where id = $1 for update`. */
export async function lockSession(tx: DbOrTx, sessionId: string): Promise<SessionRow> {
  const [row] = await tx.select().from(sessions).where(eq(sessions.id, sessionId)).for("update");
  if (!row) throw new NotFoundError("session_not_found");
  return row;
}

/** One `v_session_availability` row with the session fields `computeAvailability` needs. */
export async function readAvailabilityRow(db: DbOrTx, session: Pick<SessionRow, "id" | "isMemberOnly" | "webinarId">): Promise<AvailabilityRow> {
  const [v] = await db.select().from(vSessionAvailability).where(eq(vSessionAvailability.sessionId, session.id));
  if (!v) throw new NotFoundError("session_not_found");
  const n = (x: unknown) => Number(x ?? 0);
  return {
    ...v,
    capacity: n(v.capacity),
    held: n(v.held),
    booked: n(v.booked),
    leadBooked: n(v.leadBooked),
    liveOffers: n(v.liveOffers),
    liveLeadOffers: n(v.liveLeadOffers),
    availableTotal: n(v.availableTotal),
    leadReservedRemaining: n(v.leadReservedRemaining),
    availableGeneral: n(v.availableGeneral),
    waiting: n(v.waiting),
    isMemberOnly: session.isMemberOnly,
    webinarId: session.webinarId,
  };
}

/** R15, R20: crm status only matters on lead magnets; membership only on member-only sessions. */
export async function viewerFor(db: DbOrTx, session: Pick<SessionRow, "isMemberOnly" | "isLeadMagnet">, personId: string | null): Promise<AvailabilityViewer> {
  if (!personId) return { status: "anonymous", isMember: false };
  const isMember = session.isMemberOnly ? (await getMembershipForPerson(db, personId)).isMember : false;
  const status = session.isLeadMagnet ? (await getPersonStatus(db, personId)).status : isMember ? "member" : "customer";
  return { status, isMember };
}

/** R17: credits' two error classes, `SharingNotAllowedError` first. */
export function mapCreditError(error: unknown): unknown {
  if (error instanceof SharingNotAllowedError) return new BookingConflictError("sharing_not_allowed", { reason: error.reason });
  if (error instanceof InsufficientCreditsError) return new BookingConflictError("insufficient_credits", { needed: error.needed, available: error.available });
  return error;
}

function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: unknown; cause?: { code?: unknown } } | null;
  return e?.code === "23505" || e?.cause?.code === "23505";
}

/** R59: `booking.booking_confirmed` (owner) or `booking.guest_invited` (guest), QR inline, key `booking:<id>:confirmed`. */
export async function sendConfirmationEmail(ctx: Ctx, booking: BookingRow, session: Pick<SessionRow, "title" | "startsAt">, opts: { payAtDesk?: boolean } = {}): Promise<boolean> {
  const [person] = await ctx.tx.select({ email: persons.email, locale: persons.locale }).from(persons).where(eq(persons.id, booking.personId));
  if (!person?.email) return false;
  const locale = person.locale;
  const fileId = await renderCheckinQr(ctx, booking);
  const base = {
    title: pick(session.title, locale, "session title"),
    date: formatDateTime(session.startsAt, locale, "full"),
    url: appUrl(`/${URL_SEGMENT[locale]}/account/bookings/${booking.id}`),
  };
  let template = "booking.booking_confirmed";
  let data: Record<string, unknown> = { ...base, payAtDesk: opts.payAtDesk ?? false };
  if (booking.guestOfBookingId) {
    const [owner] = await ctx.tx
      .select({ firstName: persons.firstName })
      .from(bookings)
      .innerJoin(persons, eq(persons.id, bookings.personId))
      .where(eq(bookings.id, booking.guestOfBookingId));
    template = "booking.guest_invited";
    data = { ...base, ownerFirstName: owner?.firstName?.trim() || "BEAM" };
  }
  await sendTransactional(ctx, { template, personId: booking.personId, locale, data, key: `booking:${booking.id}:confirmed`, attachments: [qrAttachment(fileId)] });
  return true;
}

/** Booking a session directly releases the person's waiting or offered entry (`booked_directly`). */
export async function releaseWaitlistEntryOnBooking(ctx: Ctx, sessionId: string, personId: string): Promise<void> {
  const [entry] = await ctx.tx
    .select()
    .from(waitlistEntries)
    .where(and(eq(waitlistEntries.sessionId, sessionId), eq(waitlistEntries.personId, personId), inArray(waitlistEntries.state, ["waiting", "offered"])));
  if (!entry) return;
  waitlistTransition(entry, "released", ctx.actor.kind);
  await ctx.tx
    .update(waitlistEntries)
    .set({ state: "released", endedReason: "booked_directly", updatedAt: ctx.now })
    .where(eq(waitlistEntries.id, entry.id));
  const [s] = await ctx.tx.select().from(sessions).where(eq(sessions.id, sessionId));
  await ctx.recordEvent({
    kind: "waitlist.released",
    personId,
    data: {
      session_id: sessionId,
      session_kind: s!.kind,
      event_category: s!.eventCategory,
      starts_at: s!.startsAt,
      paid_with: null,
      is_guest: false,
      guest_of_person_id: null,
      owner_person_id: personId,
      is_first_booking: false,
      is_first_visit: false,
      queue: entry.queue,
      ended_reason: "booked_directly",
    },
    ref: { type: "waitlist_entry", id: entry.id },
    dedupeKey: `waitlist:${entry.id}:released:${entry.offersCount}:${entry.rejoinCount}`,
  });
}

// ---------------------------------------------------------------------------
// bookSeats
// ---------------------------------------------------------------------------

type PlannedRow = {
  id: string;
  personId: string;
  paidWith: PaidWith;
  /** Credit payer for `credit` / `guest` rows. */
  payerPersonId: string;
  guestOfBookingId: string | null;
  capacityUnits: 0 | 1;
};

function assertPayable(session: SessionRow, payWith: PaidWith, productId: string | null, opts: { staff: boolean; override: boolean; reason?: string }): void {
  const fail = (field: string): never => {
    throw new ValidationError("pay_with_not_available", { [field]: "not_available" });
  };
  if ((payWith === "credit" || payWith === "guest") && !session.creditKind) fail("payWith");
  if (payWith === "order" && !productId) fail("payWith");
  if (payWith === "free") {
    const freeSession = !productId && (session.creditKind === null || session.creditCost === 0);
    if (freeSession) return;
    if (!opts.staff || !opts.override) fail("payWith");
    if (!opts.reason?.trim()) fail("reason");
  }
}

/** Customer-facing refusals (R7, R15, R64) for an `Availability.reason`. */
function refuseFor(reason: string): never {
  switch (reason) {
    case "webinar":
      throw new BookingConflictError("webinar_session");
    case "member_only":
      throw new BookingConflictError("member_only");
    case "closed":
    case "cancelled":
      throw new BookingConflictError("session_closed");
    case "past":
    case "not_open_yet":
      throw new BookingConflictError("outside_window");
    default:
      throw new SessionFullError();
  }
}

/**
 * Edge case 2: the owner's live `reserved` rows of this session whose order has this
 * `client_key` (the same submit twice). Null when there is none.
 */
async function existingCheckout(tx: Tx, sessionId: string, personId: string, clientKey: string): Promise<{ orderId: string; bookingIds: string[] } | null> {
  const [own] = await tx
    .select({ id: bookings.id, orderId: orders.id })
    .from(bookings)
    .innerJoin(orderLines, eq(orderLines.id, bookings.orderLineId))
    .innerJoin(orders, eq(orders.id, orderLines.orderId))
    .where(and(eq(bookings.sessionId, sessionId), eq(bookings.personId, personId), eq(bookings.status, "reserved"), eq(orders.clientKey, clientKey)));
  if (!own) return null;
  const rows = await tx
    .select({ id: bookings.id })
    .from(bookings)
    .where(and(eq(bookings.status, "reserved"), or(eq(bookings.id, own.id), eq(bookings.guestOfBookingId, own.id))))
    .orderBy(sql`${bookings.guestOfBookingId} is not null`, bookings.createdAt);
  return { orderId: own.orderId, bookingIds: rows.map((r) => r.id) };
}

/** Free units of a capacity hold (R11), under the hold row lock. */
async function holdFree(tx: Tx, holdId: string, sessionId: string): Promise<number> {
  const [hold] = await tx.select().from(capacityHolds).where(and(eq(capacityHolds.id, holdId), eq(capacityHolds.sessionId, sessionId))).for("update");
  if (!hold) throw new NotFoundError("hold_not_found");
  const [used] = await tx
    .select({ n: sql<number>`coalesce(sum(${bookings.capacityUnits}), 0)::int` })
    .from(bookings)
    .where(
      and(
        eq(bookings.capacityHoldId, holdId),
        or(inArray(bookings.status, ["confirmed", "attended", "no_show"]), and(eq(bookings.status, "reserved"), gt(bookings.reservedUntil, sql`now()`))),
      ),
    );
  return hold.quantity - Number(used?.n ?? 0);
}

/** Books the owner and guests (R8-R19, R54-R56, R62, R62b, R63). Runs in the caller's transaction. */
export async function bookSeats(tx: Tx, ctx: Ctx, input: BookSeatsInput): Promise<BookResult> {
  const staff = input.by === "staff";
  if (staff && ctx.actor.kind !== "staff") throw new ValidationError("staff_booking_needs_staff_actor");
  const override = staff && actorHasPermission(ctx.actor, "bookings.override");
  const session = await lockSession(tx, input.sessionId);
  const rules: BookingRules = await getSetting(tx, "booking_rules");
  const guests = input.guests ?? [];

  if (session.webinarId) throw new BookingConflictError("webinar_session");
  if (session.status === "cancelled") throw new BookingConflictError("session_closed");
  if (staff && session.endsAt.getTime() <= ctx.now.getTime()) throw new BookingConflictError("outside_window");
  if (guests.length > rules.max_guests_per_booking) throw new ValidationError("too_many_guests", { guests: "too_many" });
  if (input.overCapacity && !override) throw new BookingConflictError("session_full");
  if (input.payAtDesk && (!staff || input.payWith !== "order" || !rules.pay_at_desk.enabled || !rules.pay_at_desk.kinds.includes(session.kind))) {
    throw new ValidationError("pay_at_desk_not_available", { payAtDesk: "not_available" });
  }
  if (input.payWith === "guest" && !input.grantOwnerPersonId) throw new ValidationError("grant_owner_required", { grantOwnerPersonId: "required" });

  // R13: shared beds only on nights, at most `max_shared_bed_guests_per_booking`.
  const sharers = guests.filter((g) => g.sharesBed).length;
  if (sharers > 0 && (session.kind !== "night" || sharers > rules.max_shared_bed_guests_per_booking)) throw new BookingConflictError("shared_bed_limit");

  let productId = session.productId;
  if (input.ticketTypeId) {
    const [tt] = await tx.select().from(ticketTypes).where(and(eq(ticketTypes.id, input.ticketTypeId), eq(ticketTypes.sessionId, session.id)));
    if (!tt || !tt.isActive) throw new BookingConflictError("not_on_sale");
    productId = tt.productId;
  }
  const payOpts = { staff, override, reason: input.reason };
  assertPayable(session, input.payWith, productId, payOpts);
  for (const g of guests) assertPayable(session, g.payWith, productId, payOpts);

  const [owner] = await tx.select({ id: persons.id, locale: persons.locale }).from(persons).where(eq(persons.id, input.personId));
  if (!owner) throw new NotFoundError("person_not_found");
  const locale = input.locale ?? owner.locale;

  // Edge case 2: a double submit of a paid booking returns the existing checkout.
  const repeat = await existingCheckout(tx, session.id, input.personId, input.clientKey);
  if (repeat) {
    const redirectTo = staff ? `/admin/pos?order=${repeat.orderId}` : `/${URL_SEGMENT[locale]}/account/checkout/${repeat.orderId}`;
    return { kind: "checkout", bookingIds: repeat.bookingIds, orderId: repeat.orderId, redirectTo };
  }

  // R15 member-only (staff with override may bypass) and the customer gate (R7).
  const viewer = await viewerFor(tx, session, input.personId);
  if (session.isMemberOnly && !viewer.isMember && !override) throw new BookingConflictError("member_only");
  const availability = await readAvailabilityRow(tx, session);
  const computed = computeAvailability(availability, viewer, ctx.now, rules);
  if (!staff && computed.reason !== "ok" && computed.reason !== "full") refuseFor(computed.reason);

  // R62b, then the rows (ids first so terms and credits can reference the owner row).
  await ensureHealthAndContact(tx, ctx, { personId: input.personId, kind: session.kind, emergencyContact: input.emergencyContact, by: input.by });
  const ownerId = randomUUID();
  const rows: PlannedRow[] = [
    {
      id: ownerId,
      personId: input.personId,
      paidWith: input.payWith,
      payerPersonId: input.payWith === "guest" ? input.grantOwnerPersonId! : input.personId,
      guestOfBookingId: null,
      capacityUnits: 1,
    },
  ];
  for (const g of guests) {
    const acquisition = { source: "guest" as const, referrer_person_id: input.personId };
    const email = g.email?.trim();
    const personId = email
      ? (await findOrCreatePersonByEmail(tx, ctx, { email, firstName: g.firstName, lastName: g.lastName, locale, acquisition })).personId
      : (await createPersonWithoutEmail(tx, ctx, { firstName: g.firstName, lastName: g.lastName, locale, acquisition })).personId;
    rows.push({
      id: randomUUID(),
      personId,
      paidWith: g.payWith,
      payerPersonId: input.grantOwnerPersonId ?? input.personId,
      guestOfBookingId: ownerId,
      capacityUnits: g.sharesBed ? 0 : 1,
    });
  }

  // R14: one live booking per person and session (also within this request).
  const attendeeIds = rows.map((r) => r.personId);
  if (new Set(attendeeIds).size !== attendeeIds.length) throw new AlreadyBookedError({ reason: "duplicate_in_request" });
  const existing = await tx
    .select({ personId: bookings.personId })
    .from(bookings)
    .where(and(eq(bookings.sessionId, session.id), inArray(bookings.personId, attendeeIds), inArray(bookings.status, [...LIVE_STATUSES])));
  if (existing.length) throw new AlreadyBookedError({ personIds: existing.map((e) => e.personId) });

  // R9-R12: capacity (or the hold) for every unit.
  const units = rows.reduce((n, r) => n + r.capacityUnits, 0);
  let isOverCapacity = false;
  if (input.holdId) {
    if (!staff) throw new ValidationError("hold_needs_staff", { holdId: "not_allowed" });
    if ((await holdFree(tx, input.holdId, session.id)) < units) throw new SessionFullError({ holdId: input.holdId });
  } else {
    const free = staff ? Math.max(0, availability.availableTotal) : computed.bookable;
    // R23: a lead seat is for the lead only; guests of a lead booking need general seats.
    const guestUnits = units - rows[0]!.capacityUnits;
    if (!staff && computed.useLeadSeat && guestUnits > Math.max(0, availability.availableGeneral)) {
      throw new SessionFullError({ free: availability.availableGeneral, needed: guestUnits, pool: "general" });
    }
    if (free < units) {
      if (!(override && input.overCapacity)) throw new SessionFullError({ free, needed: units });
      isOverCapacity = true;
    }
  }

  if (!staff) await ensureTermsAccepted(tx, ctx, input.personId, input.acceptTerms, { type: "booking", id: ownerId });

  // Insert: order rows `reserved` first (R18), every other row `confirmed` (R17).
  const reservedUntil = input.payAtDesk ? session.endsAt : new Date(ctx.now.getTime() + PROVISIONAL_RESERVATION_MS);
  const bookedByUserId = ctx.actor.kind === "staff" ? ctx.actor.userId : null;
  const inserted: BookingRow[] = [];
  try {
    for (const r of rows) {
      const status = r.paidWith === "order" ? "reserved" : "confirmed";
      bookingTransition(null, status, staff ? "staff" : ctx.actor.kind === "system" ? "system" : ctx.actor.kind === "public" ? "public" : "customer");
      const [row] = await tx
        .insert(bookings)
        .values({
          id: r.id,
          sessionId: session.id,
          personId: r.personId,
          status,
          paidWith: r.paidWith,
          guestOfBookingId: r.guestOfBookingId,
          capacityUnits: r.capacityUnits,
          ticketTypeId: input.ticketTypeId ?? null,
          capacityHoldId: input.holdId ?? null,
          usedLeadSeat: r.guestOfBookingId === null && computed.useLeadSeat,
          isOverCapacity,
          isPayAtDesk: !!input.payAtDesk && r.paidWith === "order",
          bookedByUserId,
          bookedByPersonId: r.guestOfBookingId || !staff ? input.personId : null,
          source: input.source,
          reservedUntil: status === "reserved" ? reservedUntil : null,
          notes: staff && input.reason?.trim() ? input.reason.trim() : null,
        })
        .returning();
      inserted.push(row!);
    }
  } catch (error) {
    if (isUniqueViolation(error)) throw new AlreadyBookedError();
    throw error;
  }

  // R17, R55: one consume per credit-paid row.
  if (session.creditKind && session.creditCost > 0) {
    for (const r of rows) {
      if (r.paidWith !== "credit" && r.paidWith !== "guest") continue;
      try {
        await consumeCredits(tx, ctx, {
          personId: r.payerPersonId,
          beneficiaryPersonId: r.personId,
          kind: session.creditKind,
          units: session.creditCost,
          ref: { type: "booking", id: r.id },
          validAt: session.startsAt,
        });
      } catch (error) {
        throw mapCreditError(error);
      }
    }
  }

  // R18: one quantity-1 item per order-paid seat, in row order.
  const orderRows = inserted.filter((b) => b.paidWith === "order");
  let orderId: string | null = null;
  if (orderRows.length) {
    const order = await createOrder(tx, ctx, {
      personId: input.personId,
      channel: staff ? "admin" : "portal",
      items: orderRows.map((b) => ({ productId: productId!, quantity: 1, sessionId: session.id, bookingIds: [b.id] })),
      promoCode: input.promoCode ?? null,
      clientKey: input.clientKey,
      locale,
      ...(input.useEuroCredit !== undefined ? { useEuroCredit: input.useEuroCredit } : {}),
      ...(input.payAtDesk ? { expiresAt: session.endsAt } : {}),
    });
    orderId = order.orderId;
    const linked = await linkOrderLines(tx, orderRows, order.lineIds);
    for (const b of inserted) {
      const l = linked.find((x) => x.id === b.id);
      if (l) Object.assign(b, { orderLineId: l.orderLineId, reservedUntil: l.reservedUntil });
    }
  }

  // R61 facts, R58 guest facts on the owner's timeline, R59 emails, waitlist release.
  const factSession = { kind: session.kind, eventCategory: session.eventCategory, startsAt: session.startsAt, partnerCompanyId: session.partnerCompanyId };
  for (const b of inserted) {
    await recordBookingFact(ctx, b.status === "reserved" ? "booking.reserved" : "booking.confirmed", b, { session: factSession, by: input.by });
    if (b.guestOfBookingId) await recordBookingFact(ctx, "booking.guest_added", b, { session: factSession, by: input.by, subjectPersonId: input.personId });
  }
  if (input.sendEmail !== false) {
    for (const b of inserted) {
      if (b.status === "confirmed") await sendConfirmationEmail(ctx, b, session);
      else if (b.isPayAtDesk && b.guestOfBookingId === null) await sendConfirmationEmail(ctx, b, session, { payAtDesk: true });
    }
  }
  for (const b of inserted) await releaseWaitlistEntryOnBooking(ctx, session.id, b.personId);

  const bookingIds = inserted.map((b) => b.id);
  if (!orderId) return { kind: "confirmed", bookingIds };
  const redirectTo = staff ? `/admin/pos?order=${orderId}` : `/${URL_SEGMENT[locale]}/account/checkout/${orderId}`;
  return { kind: "checkout", bookingIds, orderId, redirectTo };
}
