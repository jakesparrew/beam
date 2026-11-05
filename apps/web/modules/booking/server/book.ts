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
  NeedsReviewError,
  SessionFullError,
  bookingTransition,
  computeAvailability,
  deriveIpSalt,
  duplicateSignals,
  hashIp,
  normaliseEmail,
  transition as waitlistTransition,
  type Availability,
  type AvailabilityRow,
  type AvailabilityViewer,
  type BookingRules,
  type DupCandidate,
  type PaidWith,
} from "@beam/core/booking";
import { URL_SEGMENT, formatDateTime, missingLocales, pick, type Locale } from "@beam/core/i18n";
import { NotFoundError, ValidationError, actorHasPermission, and, createCtx, eq, gt, inArray, ne, or, sql, writeDurably, type Ctx } from "@/lib/ctx";
import { getSetting } from "@/lib/settings";
import { createOrder } from "@/modules/commerce/api";
import { InsufficientCreditsError, SharingNotAllowedError, checkCredits, consumeCredits, getMembershipForPerson } from "@/modules/credits/api";
import { createPersonWithoutEmail, findOrCreatePersonByEmail, getPersonStatus } from "@/modules/crm/api";
import { sendTransactional } from "@/modules/email/api";
import { ensureHealthAndContact, type EmergencyContactInput } from "./declarations";
import { recordBookingFact } from "./facts";
import { linkOrderLines } from "./order-hooks";
import { qrAttachment, renderCheckinQr } from "./qr";
import { ensureTermsAccepted } from "./terms";

export type { Availability };
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

/**
 * booking-P7 (R20-R27): the phase-aware availability of one session for one person (or the
 * public with `personId = null`): the crm status at this moment (`getPersonStatus(...).status`,
 * staff override respected) decides the lead, customer or public pools and queue; a customer in
 * the lead window with no general seat left gets `opensAt = lead_window_end_at`, a lead in
 * `customer_release` gets `opensAt = opens_for_public_at` (R22, R24). The view computes the pools
 * with the database clock, so `at` only moves the horizon and cut-off checks.
 */
export async function availabilityFor(db: DbOrTx, sessionId: string, personId: string | null, at: Date = new Date()): Promise<Availability> {
  const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
  if (!session) throw new NotFoundError("session_not_found");
  const rules: BookingRules = await getSetting(db, "booking_rules");
  const row = await readAvailabilityRow(db, session);
  return computeAvailability(row, await viewerFor(db, session, personId), at, rules);
}

/**
 * R48 for a direct lead-seat booking: the duplicate signals of the person against the session's
 * other waitlist entries and live bookings (same normalised email, phone, name and birth date, or
 * the same IP hash within 24 h in the `lead` queue).
 */
async function leadSeatSignals(tx: DbOrTx, ctx: Ctx, sessionId: string, personId: string, entryId: string): Promise<{ signals: string[]; emailNormalised: string | null; joinIpHash: string | null }> {
  const [me] = await tx
    .select({ email: persons.email, phone: persons.phone, lastName: persons.lastName, birthOn: persons.birthOn })
    .from(persons)
    .where(eq(persons.id, personId));
  if (!me) throw new NotFoundError("person_not_found");
  const emailNormalised = me.email ? normaliseEmail(me.email) : null;
  const joinIpHash = ctx.ip ? hashIp(ctx.ip, deriveIpSalt(process.env.AUTH_SECRET ?? "")) : null;
  const entries = await tx
    .select({
      id: waitlistEntries.id,
      personId: waitlistEntries.personId,
      emailNormalised: waitlistEntries.emailNormalised,
      joinIpHash: waitlistEntries.joinIpHash,
      joinedAt: waitlistEntries.joinedAt,
      queue: waitlistEntries.queue,
      phone: persons.phone,
      lastName: persons.lastName,
      birthOn: persons.birthOn,
    })
    .from(waitlistEntries)
    .innerJoin(persons, eq(persons.id, waitlistEntries.personId))
    .where(and(eq(waitlistEntries.sessionId, sessionId), ne(waitlistEntries.personId, personId)));
  const live = await tx
    .select({ id: bookings.id, personId: bookings.personId, createdAt: bookings.createdAt, email: persons.email, phone: persons.phone, lastName: persons.lastName, birthOn: persons.birthOn })
    .from(bookings)
    .innerJoin(persons, eq(persons.id, bookings.personId))
    .where(and(eq(bookings.sessionId, sessionId), inArray(bookings.status, [...LIVE_STATUSES]), ne(bookings.personId, personId)));
  const others: DupCandidate[] = [
    ...entries.map((e) => ({ ...e, birthOn: e.birthOn ?? null })),
    ...live.map((b) => ({
      id: b.id,
      personId: b.personId,
      emailNormalised: b.email ? normaliseEmail(b.email) : null,
      phone: b.phone,
      lastName: b.lastName,
      birthOn: b.birthOn ?? null,
      joinIpHash: null,
      joinedAt: b.createdAt,
      queue: null,
    })),
  ];
  const candidate: DupCandidate = { id: entryId, personId, emailNormalised, phone: me.phone, lastName: me.lastName, birthOn: me.birthOn ?? null, joinIpHash, joinedAt: ctx.now, queue: "lead" };
  return { signals: duplicateSignals(candidate, others), emailNormalised, joinIpHash };
}

/**
 * R48: a suspicious direct lead-seat booking is refused with `needs_review` and the person is put
 * on the `lead` queue, flagged, instead. The refusal rolls the booking transaction back, so the
 * entry and its `waitlist.joined` / `waitlist.flagged` facts are written durably (after the
 * rollback, on the app database). An existing entry of the person is left as it is.
 */
async function flagLeadSeatAttempt(
  ctx: Ctx,
  session: SessionRow,
  personId: string,
  found: { entryId: string; signals: string[]; emailNormalised: string | null; joinIpHash: string | null },
): Promise<void> {
  await writeDurably(ctx, async (db) => {
    const [entry] = await db
      .insert(waitlistEntries)
      .values({
        id: found.entryId,
        sessionId: session.id,
        personId,
        queue: "lead",
        state: "waiting",
        joinedAt: ctx.now,
        isFlaggedDuplicate: true,
        flagReason: found.signals.join(","),
        emailNormalised: found.emailNormalised,
        joinIpHash: found.joinIpHash,
      })
      .onConflictDoNothing()
      .returning();
    if (!entry) return;
    const factCtx = createCtx({ tx: db as Tx, actor: ctx.actor, now: ctx.now, requestId: ctx.requestId, durableMode: "immediate" });
    const data = {
      session_id: session.id,
      session_kind: session.kind,
      event_category: session.eventCategory,
      starts_at: session.startsAt,
      paid_with: null,
      is_guest: false,
      guest_of_person_id: null,
      owner_person_id: personId,
      is_first_booking: false,
      is_first_visit: false,
      queue: entry.queue,
    };
    const ref = { type: "waitlist_entry", id: entry.id } as const;
    await factCtx.recordEvent({ kind: "waitlist.joined", personId, data: { ...data, by: "customer" }, ref, dedupeKey: `waitlist:${entry.id}:joined:0:0` });
    await factCtx.recordEvent({ kind: "waitlist.flagged", personId, data: { ...data, signals: found.signals }, ref, dedupeKey: `waitlist:${entry.id}:flagged:0:0` });
  });
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

// ---------------------------------------------------------------------------
// Ticket types (R2, R50-R52; booking-P8)
// ---------------------------------------------------------------------------

export type TicketTypeRow = typeof ticketTypes.$inferSelect;

/**
 * R51: a ticket type is on sale while active, from `sales_start_at` (null = from publication)
 * until `sales_end_at` (null = until the session starts). Same rule as `v_ticket_type_availability`,
 * evaluated at `now` so callers can pin the clock.
 */
export function isTicketOnSale(t: Pick<TicketTypeRow, "isActive" | "salesStartAt" | "salesEndAt">, session: Pick<SessionRow, "startsAt">, now: Date): boolean {
  if (!t.isActive) return false;
  if (t.salesStartAt && now.getTime() < t.salesStartAt.getTime()) return false;
  const end = t.salesEndAt ?? session.startsAt;
  return now.getTime() < end.getTime();
}

/** R51: live rows of a ticket type (`reserved` not yet expired, `confirmed`, `attended`, `no_show`). */
export async function ticketTypeSold(tx: DbOrTx, ticketTypeId: string, now: Date): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(bookings)
    .where(
      and(
        eq(bookings.ticketTypeId, ticketTypeId),
        or(inArray(bookings.status, ["confirmed", "attended", "no_show"]), and(eq(bookings.status, "reserved"), gt(bookings.reservedUntil, now))),
      ),
    );
  return Number(row?.n ?? 0);
}

/** The active ticket types of a session, in `sort_order`. */
export function activeTicketTypes(db: DbOrTx, sessionId: string): Promise<TicketTypeRow[]> {
  return db
    .select()
    .from(ticketTypes)
    .where(and(eq(ticketTypes.sessionId, sessionId), eq(ticketTypes.isActive, true)))
    .orderBy(ticketTypes.sortOrder, ticketTypes.createdAt);
}

/**
 * R50: before an event is published every active ticket type name is complete in all three
 * locales. Throws `validation` with `ticketTypes.<id>.name.<locale>` fields. `publishSession`
 * calls it (booking-P8 request); `upsertTicketType` applies the same rule on a published event.
 */
export async function assertTicketTypesPublishable(db: DbOrTx, sessionId: string): Promise<void> {
  const fields: Record<string, string> = {};
  for (const t of await activeTicketTypes(db, sessionId)) for (const l of missingLocales(t.name)) fields[`ticketTypes.${t.id}.name.${l}`] = "missing";
  if (Object.keys(fields).length) throw new ValidationError("missing_translation", fields);
}

/**
 * R51, R52: the ticket type of a booking, checked. An event with active ticket types needs one on
 * every booking (holds excepted: a hold seat is not sold); it must belong to the session, be on
 * sale (staff with `bookings.override` may sell outside the window), respect `is_member_only`
 * (override bypasses) and `max_per_booking` (owner plus guests); with `requires_guest_details`
 * every guest needs a first and last name. Null when the booking carries no type.
 */
async function resolveTicketType(
  tx: Tx,
  session: SessionRow,
  input: Pick<BookSeatsInput, "ticketTypeId" | "holdId" | "personId">,
  guests: GuestSeatInput[],
  opts: { staff: boolean; override: boolean; now: Date },
): Promise<TicketTypeRow | null> {
  if (!input.ticketTypeId) {
    if (session.kind === "event" && !input.holdId && (await activeTicketTypes(tx, session.id)).length > 0) {
      throw new ValidationError("ticket_type_required", { ticketTypeId: "required" });
    }
    return null;
  }
  const [tt] = await tx.select().from(ticketTypes).where(and(eq(ticketTypes.id, input.ticketTypeId), eq(ticketTypes.sessionId, session.id)));
  if (!tt || !tt.isActive) throw new BookingConflictError("not_on_sale");
  if (!isTicketOnSale(tt, session, opts.now) && !opts.override) throw new BookingConflictError("not_on_sale", { ticketTypeId: tt.id });
  if (tt.isMemberOnly && !opts.override && !(await getMembershipForPerson(tx, input.personId)).isMember) {
    throw new BookingConflictError("member_only", { ticketTypeId: tt.id });
  }
  if (1 + guests.length > tt.maxPerBooking) throw new ValidationError("too_many_tickets", { guests: `max_per_booking:${tt.maxPerBooking}` });
  if (tt.requiresGuestDetails) {
    const fields: Record<string, string> = {};
    guests.forEach((g, i) => {
      if (!g.firstName?.trim()) fields[`guests.${i}.firstName`] = "required";
      if (!g.lastName?.trim()) fields[`guests.${i}.lastName`] = "required";
    });
    if (Object.keys(fields).length) throw new ValidationError("guest_details_required", fields);
  }
  return tt;
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
  // A customer pays only from their own grants (credits rule 17's owner guest use): credits checks no
  // package_shares row or owner consent on that branch, so a foreign owner is refused here. Staff are
  // trusted (`bookings.write`). R2 named sharing will take credits' rule-18 branch instead.
  if (!staff && input.grantOwnerPersonId && input.grantOwnerPersonId !== input.personId) throw new BookingConflictError("sharing_not_allowed");

  // R13: shared beds only on nights, at most `max_shared_bed_guests_per_booking`.
  const sharers = guests.filter((g) => g.sharesBed).length;
  if (sharers > 0 && (session.kind !== "night" || sharers > rules.max_shared_bed_guests_per_booking)) throw new BookingConflictError("shared_bed_limit");

  // R51, R52 (booking-P8): ticket type checks under the session lock.
  const ticket = await resolveTicketType(tx, session, input, guests, { staff, override, now: ctx.now });
  const productId = ticket ? ticket.productId : session.productId;
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
  if (!staff && computed.reason === "not_open_yet" && computed.opensAt && computed.phase !== "none") {
    // R22, R24: the seats left are not for this person yet (lead seats in the lead window, or
    // released seats for customers first); the page shows "Opens for you on ..." and the queue.
    throw new SessionFullError({ opensAt: computed.opensAt.toISOString(), phase: computed.phase, queue: computed.queue });
  }
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
  // R51: the ticket type's own capacity (the session capacity above stays the hard limit).
  if (ticket && ticket.capacity !== null) {
    const left = ticket.capacity - (await ticketTypeSold(tx, ticket.id, ctx.now));
    if (left < rows.length) {
      if (!(override && input.overCapacity)) throw new SessionFullError({ ticketTypeId: ticket.id, free: Math.max(0, left), needed: rows.length });
      isOverCapacity = true;
    }
  }

  // R48: a direct lead-seat booking runs the duplicate check; a suspicious one is refused and the
  // person goes on the lead queue, flagged, for staff review.
  if (!staff && computed.useLeadSeat && !input.holdId) {
    const entryId = randomUUID();
    const found = await leadSeatSignals(tx, ctx, session.id, input.personId, entryId);
    if (found.signals.length) {
      await flagLeadSeatAttempt(ctx, session, input.personId, { entryId, ...found });
      throw new NeedsReviewError({ queue: "lead" });
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
  // Rows commerce confirmed inside createOrder (rule 24: euro credit or a promo covers the total).
  const settled = new Set<string>();
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
    if (order.status === "paid") {
      // `confirmBookingsForOrder` already ran in this transaction: it set the lines, confirmed the
      // rows and recorded `booking.confirmed` with its email. Nothing is left to pay or link.
      const fresh = await tx.select().from(bookings).where(inArray(bookings.id, orderRows.map((b) => b.id)));
      for (const b of inserted) {
        const f = fresh.find((x) => x.id === b.id);
        if (f && f.status === "confirmed") {
          Object.assign(b, f);
          settled.add(b.id);
        }
      }
    } else {
      orderId = order.orderId;
      const linked = await linkOrderLines(tx, orderRows, order.lineIds);
      for (const b of inserted) {
        const l = linked.find((x) => x.id === b.id);
        if (l) Object.assign(b, { orderLineId: l.orderLineId, reservedUntil: l.reservedUntil });
      }
    }
  }

  // R61 facts, R58 guest facts on the owner's timeline, R59 emails, waitlist release.
  const factSession = { kind: session.kind, eventCategory: session.eventCategory, startsAt: session.startsAt, partnerCompanyId: session.partnerCompanyId };
  for (const b of inserted) {
    if (!settled.has(b.id)) await recordBookingFact(ctx, b.status === "reserved" ? "booking.reserved" : "booking.confirmed", b, { session: factSession, by: input.by });
    if (b.guestOfBookingId) await recordBookingFact(ctx, "booking.guest_added", b, { session: factSession, by: input.by, subjectPersonId: input.personId });
  }
  if (input.sendEmail !== false) {
    for (const b of inserted) {
      if (settled.has(b.id)) continue;
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

/**
 * R55 "{n} guest uses left this month" at booking time: whether the owner's package can pay for a
 * guest on this session now, through `credits.checkCredits` with a stand-in guest (no row is
 * written). `usesLeft` is the number when credits can tell it (null until credits exposes the
 * monthly count, see the booking-P8 request); `reason` is credits' refusal (`guest_limit`,
 * `not_shareable`, `insufficient`). Null when the session cannot be paid with credits.
 */
export async function guestUseState(
  db: DbOrTx,
  ownerPersonId: string,
  session: Pick<SessionRow, "creditKind" | "creditCost" | "startsAt">,
): Promise<{ allowed: boolean; usesLeft: number | null; reason: string | null } | null> {
  if (!session.creditKind || session.creditCost <= 0) return null;
  const r = await checkCredits(db, { personId: ownerPersonId, beneficiaryPersonId: randomUUID(), kind: session.creditKind, units: session.creditCost, validAt: session.startsAt });
  return r.ok ? { allowed: true, usesLeft: null, reason: null } : { allowed: false, usesLeft: 0, reason: r.reason };
}
