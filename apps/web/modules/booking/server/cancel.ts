/**
 * Cancellation (booking spec R27b-R30, R32-R34, R59, R61, edge cases 19, 27 and 31): one booking
 * (customer, staff, staff force), a whole session (BEAM, chunks of 50), an order line refunded in
 * commerce, and an expired reservation. Everything runs in the caller's transaction under the
 * session row lock; credits go back through `credits.releaseCredits`, money through
 * `commerce.refundOrderLine` / `commerce.cancelOrder`; freed capacity enqueues
 * `waitlist.offer_next` (R34).
 */
import type { Tx } from "@beam/db";
import { bookings, creditGrants, orderLines, orders, persons, sessions, waitlistEntries } from "@beam/db/schema";
import {
  BookingConflictError,
  SessionFullError,
  bookingTransition,
  cancellationOutcome,
  sessionTransition,
  transition as waitlistTransition,
  type ActorKind,
  type BookingRules,
  type CancelReasonCode,
} from "@beam/core/booking";
import type { ReleaseReason } from "@beam/core/credits";
import { URL_SEGMENT, formatDateTime, pick } from "@beam/core/i18n";
import { ForbiddenError } from "@beam/core/errors";
import { NotFoundError, ValidationError, actorHasPermission, and, asc, eq, gt, inArray, lte, or, sql, type Ctx } from "@/lib/ctx";
import { getSetting } from "@/lib/settings";
import { cancelOrder, refundOrderLine } from "@/modules/commerce/api";
import { grantCredits, releaseCredits } from "@/modules/credits/api";
import { sendTransactional } from "@/modules/email/api";
import { LIVE_STATUSES, lockSession, readAvailabilityRow, type BookingRow, type SessionRow } from "./book";
import { recordBookingFact } from "./facts";
import { expireClaimedOffers } from "./order-hooks";

export type CancelBy = "customer" | "staff" | "beam" | "system";
export type CancelForce = "release_credit" | "refund";

export type CancelBookingInput = {
  bookingId: string;
  /** The version the caller read; a mismatch is `conflict` `stale_version`. Omitted by system paths. */
  expectedVersion?: number;
  /** R30: also cancel the owner's live guest rows (default yes in the actions). */
  includeGuests: boolean;
  by: CancelBy;
  /** R32: staff with `bookings.override` cancel outside the window with release or refund. */
  force?: CancelForce;
  /** Staff free text (`cancel_reason`), mandatory for `force`. */
  reason?: string;
  /** System paths: the code to write (`refunded` from commerce). */
  reasonCode?: CancelReasonCode;
  /** System paths that already moved the money (a commerce refund): no second refund. */
  skipRefund?: boolean;
};

export type CancelResult = {
  status: "cancelled" | "late_cancelled";
  creditReleased: boolean;
  refundRequested: boolean;
  /** Every row this call changed, the requested one first. */
  cancelledBookingIds: string[];
};

/** What happens to one row. */
type Plan = {
  status: "cancelled" | "late_cancelled";
  code: CancelReasonCode;
  release: ReleaseReason | null;
  refund: "cancelled_in_policy" | "session_cancelled" | null;
};

type RowOutcome = { booking: BookingRow; plan: Plan; creditReleased: boolean; refundRequested: boolean; unpaidOrderId: string | null };

const appUrl = (path: string) => `${(process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "")}${path}`;

/** The state-machine actor of the context (commerce's webhook and public paths count as system). */
export function transitionActor(ctx: Ctx): ActorKind {
  const kind = ctx.actor.kind;
  return kind === "public" ? "system" : kind;
}

const usesCredit = (b: Pick<BookingRow, "paidWith">) => b.paidWith === "credit" || b.paidWith === "guest";

/** The order line of a booking with its order's id and status (null when the row has none). */
async function orderOf(tx: Tx, orderLineId: string | null): Promise<{ orderId: string; status: string } | null> {
  if (!orderLineId) return null;
  const [row] = await tx
    .select({ orderId: orders.id, status: orders.status })
    .from(orderLines)
    .innerJoin(orders, eq(orders.id, orderLines.orderId))
    .where(eq(orderLines.id, orderLineId));
  return row ?? null;
}

const PAID_ORDER = ["paid", "partially_refunded"];

/** R28, R29, R32, R33: the plan for one row, or throws when the change is not allowed. */
function planFor(booking: BookingRow, session: SessionRow, input: CancelBookingInput, rules: BookingRules, ctx: Ctx): Plan {
  // R33: a live row of a session BEAM cancelled (its chunks still pending) is a BEAM cancellation,
  // whoever cancels it first, and before the R29 after-start refusal.
  const liveOfCancelledSession = session.status === "cancelled" && (booking.status === "reserved" || booking.status === "confirmed") && input.by !== "system";
  if (input.by === "beam" || liveOfCancelledSession) {
    return { status: "cancelled", code: "session_cancelled", release: usesCredit(booking) ? "session_cancelled" : null, refund: booking.paidWith === "order" ? "session_cancelled" : null };
  }
  if (input.by === "system") {
    return { status: "cancelled", code: input.reasonCode ?? "staff", release: null, refund: null };
  }
  const code: CancelReasonCode = input.by === "customer" ? "customer" : "staff";
  if (booking.status === "reserved") {
    // An unpaid row has nothing to give back; its order is cancelled when no live row is left.
    return { status: "cancelled", code, release: null, refund: null };
  }
  if (booking.status === "late_cancelled") {
    // R32: only `bookings.override` converts a late cancellation into a release.
    return { status: "cancelled", code, release: usesCredit(booking) ? "staff_override" : null, refund: input.force === "refund" && booking.paidWith === "order" ? "cancelled_in_policy" : null };
  }
  if (ctx.now.getTime() >= session.startsAt.getTime() && input.by === "customer") {
    // R29: after the start a customer can no longer cancel.
    throw new BookingConflictError("outside_window", { startsAt: session.startsAt });
  }
  const outcome = cancellationOutcome({ kind: session.kind, startsAt: session.startsAt, paidWith: booking.paidWith }, rules, ctx.now);
  if (outcome.status === "cancelled") {
    return { status: "cancelled", code, release: outcome.releaseCredit ? "cancelled_in_policy" : null, refund: outcome.refund ? "cancelled_in_policy" : null };
  }
  if (input.force) {
    return {
      status: "cancelled",
      code,
      release: input.force === "release_credit" && usesCredit(booking) ? "staff_override" : null,
      refund: input.force === "refund" && booking.paidWith === "order" ? "cancelled_in_policy" : null,
    };
  }
  return { status: "late_cancelled", code, release: outcome.releaseCredit ? "late_cancel_released" : null, refund: null };
}

/**
 * R65: an imported credit row was never consumed (ops imported the balance net of it), so a
 * release finds nothing; the unit ops already deducted comes back as a `manual` grant of the
 * payer, valid as long as their latest grant of that kind (no expiry when none is live). Key
 * `grant:import-booking-release:<booking id>`.
 */
async function restoreImportedUnit(ctx: Ctx, booking: BookingRow, session: SessionRow, reason: ReleaseReason): Promise<boolean> {
  if (booking.source !== "import" || !session.creditKind || session.creditCost <= 0) return false;
  const personId = booking.paidWith === "guest" ? (booking.bookedByPersonId ?? booking.personId) : booking.personId;
  const [latest] = await ctx.tx
    .select({ expiresAt: creditGrants.expiresAt })
    .from(creditGrants)
    .where(and(eq(creditGrants.personId, personId), eq(creditGrants.creditKind, session.creditKind)))
    .orderBy(sql`${creditGrants.expiresAt} desc nulls first`)
    .limit(1);
  const expiresAt = latest?.expiresAt && latest.expiresAt.getTime() > ctx.now.getTime() ? latest.expiresAt : null;
  await grantCredits(ctx.tx, ctx, {
    source: "manual",
    personId,
    kind: session.creditKind,
    units: session.creditCost,
    expiresAt,
    reason,
    key: `grant:import-booking-release:${booking.id}`,
  });
  return true;
}

/** Applies a plan to one locked row: status, credits, refund, fact and email (not the order cancel). */
async function applyPlan(ctx: Ctx, booking: BookingRow, session: SessionRow, plan: Plan, opts: { by: CancelBy; reason?: string; notify: boolean; skipRefund?: boolean }): Promise<RowOutcome> {
  const tx = ctx.tx;
  bookingTransition(booking.status, plan.status, transitionActor(ctx));
  const [row] = await tx
    .update(bookings)
    .set({
      status: plan.status,
      cancelledAt: ctx.now,
      cancelReasonCode: plan.code,
      ...(opts.reason?.trim() ? { cancelReason: opts.reason.trim() } : {}),
      version: sql`${bookings.version} + 1`,
      updatedAt: ctx.now,
    })
    .where(eq(bookings.id, booking.id))
    .returning();
  const updated = row!;

  let creditReleased = false;
  if (plan.release && usesCredit(booking)) {
    const { releasedUnits } = await releaseCredits(tx, ctx, { ref: { type: "booking", id: booking.id }, reason: plan.release });
    creditReleased = releasedUnits > 0 || (await restoreImportedUnit(ctx, booking, session, plan.release));
  }
  let refundRequested = false;
  let unpaidOrderId: string | null = null;
  const order = await orderOf(tx, booking.orderLineId);
  if (order && booking.orderLineId) {
    if (PAID_ORDER.includes(order.status)) {
      if (plan.refund && !opts.skipRefund) {
        await refundOrderLine(tx, ctx, { orderLineId: booking.orderLineId, reason: plan.refund });
        refundRequested = true;
      }
    } else if (order.status === "pending_payment" || order.status === "draft") {
      unpaidOrderId = order.orderId;
    }
  }

  const factSession = { kind: session.kind, eventCategory: session.eventCategory, startsAt: session.startsAt, partnerCompanyId: session.partnerCompanyId };
  await recordBookingFact(ctx, plan.status === "late_cancelled" ? "booking.late_cancelled" : "booking.cancelled", updated, {
    session: factSession,
    by: opts.by,
    cancelReasonCode: plan.code,
  });
  await sendCancellationEmail(ctx, updated, session, { notify: opts.notify, refunded: refundRequested, creditReleased });
  return { booking: updated, plan, creditReleased, refundRequested, unpaidOrderId };
}

/**
 * R59: `booking.booking_cancelled` (`reason` `cancelled` or `payment_expired`), `booking.booking_late_cancelled`
 * or, for a session BEAM cancelled, `booking.session_cancelled` (only with `notify`). Nothing for
 * `rescheduled` and `erased`, nothing to a person without an email. Key `booking:<id>:cancelled`.
 */
export async function sendCancellationEmail(
  ctx: Ctx,
  booking: Pick<BookingRow, "id" | "personId" | "status" | "cancelReasonCode">,
  session: Pick<SessionRow, "title" | "startsAt">,
  opts: { notify?: boolean; refunded?: boolean; creditReleased?: boolean } = {},
): Promise<boolean> {
  const code = booking.cancelReasonCode;
  if (code === "rescheduled" || code === "erased") return false;
  if (code === "session_cancelled" && opts.notify === false) return false;
  const [person] = await ctx.tx.select({ email: persons.email, locale: persons.locale }).from(persons).where(eq(persons.id, booking.personId));
  if (!person?.email) return false;
  const locale = person.locale;
  const base = {
    title: pick(session.title, locale, "session title"),
    date: formatDateTime(session.startsAt, locale, "full"),
    url: appUrl(`/${URL_SEGMENT[locale]}/account/book`),
  };
  let template: string;
  let data: Record<string, unknown>;
  if (code === "session_cancelled") {
    template = "booking.session_cancelled";
    data = { ...base, refunded: opts.refunded ?? false, creditReleased: opts.creditReleased ?? false };
  } else if (booking.status === "late_cancelled") {
    template = "booking.booking_late_cancelled";
    data = base;
  } else {
    template = "booking.booking_cancelled";
    data = { ...base, reason: code === "payment_expired" ? "payment_expired" : "cancelled" };
  }
  await sendTransactional(ctx, { template, personId: booking.personId, locale, data, key: `booking:${booking.id}:cancelled` });
  return true;
}

/** R34: freed capacity goes to the waitlist (key `waitlist:<session_id>:offer_next:<booking id>`). */
export async function enqueueOfferNext(ctx: Ctx, sessionId: string, trigger: string): Promise<void> {
  await ctx.enqueue({ kind: "waitlist.offer_next", payload: { sessionId, trigger }, key: `waitlist:${sessionId}:offer_next:${trigger}` });
}

/** Cancels each unpaid order that has no live (`reserved`) booking left (R33; stops a later payment re-booking). */
export async function cancelUnpaidOrders(ctx: Ctx, orderIds: Iterable<string>, reason: string): Promise<number> {
  let n = 0;
  for (const orderId of [...new Set(orderIds)].sort()) {
    const [live] = await ctx.tx
      .select({ id: bookings.id })
      .from(bookings)
      .innerJoin(orderLines, eq(orderLines.id, bookings.orderLineId))
      .where(and(eq(orderLines.orderId, orderId), inArray(bookings.status, [...LIVE_STATUSES])));
    if (live) continue;
    const { cancelled } = await cancelOrder(ctx.tx, ctx, { orderId, reason });
    if (cancelled) n++;
  }
  return n;
}

/** Locks the session of a booking, then the booking row. */
async function lockBooking(tx: Tx, bookingId: string): Promise<{ booking: BookingRow; session: SessionRow }> {
  const [peek] = await tx.select({ sessionId: bookings.sessionId }).from(bookings).where(eq(bookings.id, bookingId));
  if (!peek) throw new NotFoundError("booking_not_found");
  const session = await lockSession(tx, peek.sessionId);
  const [booking] = await tx.select().from(bookings).where(eq(bookings.id, bookingId)).for("update");
  return { booking: booking!, session };
}

/** A customer may cancel their own row or a guest row they booked (R30). */
async function assertCustomerOwns(tx: Tx, ctx: Ctx, booking: BookingRow): Promise<void> {
  if (ctx.actor.kind !== "customer") throw new ForbiddenError("forbidden: customer");
  const me = ctx.actor.personId;
  if (booking.personId === me) return;
  if (booking.guestOfBookingId) {
    const [owner] = await tx.select({ personId: bookings.personId }).from(bookings).where(eq(bookings.id, booking.guestOfBookingId));
    if (owner?.personId === me) return;
  }
  throw new NotFoundError("booking_not_found");
}

/**
 * R13 / edge case 31: when the owner of a shared bed is cancelled and the sharing guest stays,
 * the guest takes a bed of their own, or the whole cancellation is refused with `session_full`.
 */
async function convertSharingGuests(tx: Tx, ctx: Ctx, owner: BookingRow, session: SessionRow): Promise<void> {
  const sharers = await tx
    .select()
    .from(bookings)
    .where(and(eq(bookings.guestOfBookingId, owner.id), eq(bookings.capacityUnits, 0), inArray(bookings.status, [...LIVE_STATUSES, "attended", "no_show"])))
    .for("update");
  for (const guest of sharers) {
    const availability = await readAvailabilityRow(tx, session);
    if (availability.availableTotal < 1) throw new SessionFullError({ reason: "shared_bed_owner", guestBookingId: guest.id });
    await tx
      .update(bookings)
      .set({ capacityUnits: 1, version: sql`${bookings.version} + 1`, updatedAt: ctx.now })
      .where(eq(bookings.id, guest.id));
  }
}

/**
 * Cancels one booking (and by default its live guests) under the session lock (R27b-R32).
 * Customers: own rows, never `reserved` and never after the start; inside the free window
 * `cancelled` with release and refund, after it `late_cancelled`. Staff: the same policy result,
 * or with `bookings.override` and `force` a `cancelled` with `staff_override` release or a refund;
 * a `late_cancelled` row converts to `cancelled` only that way.
 */
export async function cancelBookingRow(tx: Tx, ctx: Ctx, input: CancelBookingInput): Promise<CancelResult> {
  const { booking, session } = await lockBooking(tx, input.bookingId);
  if (input.expectedVersion !== undefined && booking.version !== input.expectedVersion) {
    throw new BookingConflictError("stale_version", { expected: input.expectedVersion, actual: booking.version });
  }
  if (input.by === "customer") await assertCustomerOwns(tx, ctx, booking);
  if (input.by === "staff" && ctx.actor.kind !== "staff") throw new ForbiddenError("forbidden: staff");
  const override = actorHasPermission(ctx.actor, "bookings.override");
  if (input.force && (input.by !== "staff" || !override)) throw new ForbiddenError("forbidden: bookings.override", "bookings.override");
  if (input.force && !input.reason?.trim()) throw new ValidationError("reason_required", { reason: "required" });
  if (booking.status === "late_cancelled" && !(input.by === "staff" && override && input.force)) {
    throw new BookingConflictError("invalid_transition", { from: "late_cancelled", to: "cancelled" });
  }
  if (!["reserved", "confirmed", "late_cancelled"].includes(booking.status)) {
    throw new BookingConflictError("invalid_transition", { from: booking.status, to: "cancelled" });
  }

  const rules: BookingRules = await getSetting(tx, "booking_rules");
  const notify = true;
  const outcomes: RowOutcome[] = [];
  const wasLive = (LIVE_STATUSES as readonly string[]).includes(booking.status);
  outcomes.push(await applyPlan(ctx, booking, session, planFor(booking, session, input, rules, ctx), { by: input.by, reason: input.reason, notify, skipRefund: input.skipRefund }));

  if (booking.guestOfBookingId === null) {
    if (input.includeGuests) {
      const guests = await tx
        .select()
        .from(bookings)
        .where(and(eq(bookings.guestOfBookingId, booking.id), inArray(bookings.status, input.by === "customer" ? ["confirmed"] : [...LIVE_STATUSES])))
        .orderBy(asc(bookings.createdAt))
        .for("update");
      for (const g of guests) {
        outcomes.push(await applyPlan(ctx, g, session, planFor(g, session, input, rules, ctx), { by: input.by, reason: input.reason, notify, skipRefund: input.skipRefund }));
      }
    }
    if (wasLive && booking.capacityUnits > 0) await convertSharingGuests(tx, ctx, booking, session);
  }

  await cancelUnpaidOrders(ctx, outcomes.flatMap((o) => (o.unpaidOrderId ? [o.unpaidOrderId] : [])), "booking_cancelled");
  if (wasLive && session.status !== "cancelled") await enqueueOfferNext(ctx, session.id, booking.id);

  const first = outcomes[0]!;
  return {
    status: first.plan.status,
    creditReleased: outcomes.some((o) => o.creditReleased),
    refundRequested: outcomes.some((o) => o.refundRequested),
    cancelledBookingIds: outcomes.map((o) => o.booking.id),
  };
}

// ---------------------------------------------------------------------------
// Session cancellation (R33)
// ---------------------------------------------------------------------------

/** Above this many live bookings the session is processed by `sessions.cancel_bookings` (R33). */
export const SESSION_CANCEL_CHUNK = 50;

export type SessionCancelCounts = { cancelledBookings: number; refundsRequested: number; creditsReleased: number; ordersCancelled: number };

/**
 * One chunk of a cancelled session: the next `limit` bookings (any status) after `afterBookingId`
 * in id order; the live ones are cancelled with `session_cancelled`. Running the same chunk
 * twice changes nothing. Returns the last id of the window when more rows may follow.
 */
export async function cancelSessionChunk(
  tx: Tx,
  ctx: Ctx,
  input: { sessionId: string; afterBookingId?: string; notify: boolean; limit?: number },
): Promise<SessionCancelCounts & { nextAfterBookingId: string | null }> {
  const session = await lockSession(tx, input.sessionId);
  const limit = input.limit ?? SESSION_CANCEL_CHUNK;
  const window = await tx
    .select()
    .from(bookings)
    .where(and(eq(bookings.sessionId, session.id), input.afterBookingId ? gt(bookings.id, input.afterBookingId) : undefined))
    .orderBy(asc(bookings.id))
    .limit(limit)
    .for("update");
  const counts: SessionCancelCounts = { cancelledBookings: 0, refundsRequested: 0, creditsReleased: 0, ordersCancelled: 0 };
  const unpaid: string[] = [];
  const plan = { by: "beam" as const, includeGuests: false, bookingId: "" };
  const rules: BookingRules = await getSetting(tx, "booking_rules");
  for (const b of window) {
    if (!(LIVE_STATUSES as readonly string[]).includes(b.status)) continue;
    const o = await applyPlan(ctx, b, session, planFor(b, session, { ...plan, bookingId: b.id }, rules, ctx), { by: "beam", notify: input.notify });
    counts.cancelledBookings++;
    if (o.refundRequested) counts.refundsRequested++;
    if (o.creditReleased) counts.creditsReleased++;
    if (o.unpaidOrderId) unpaid.push(o.unpaidOrderId);
  }
  counts.ordersCancelled = await cancelUnpaidOrders(ctx, unpaid, "session_cancelled");
  const nextAfterBookingId = window.length === limit ? window[window.length - 1]!.id : null;
  return { ...counts, nextAfterBookingId };
}

/** R33 waiting and offered entries of a cancelled session become `released` (`session_cancelled`). */
async function releaseSessionEntries(ctx: Ctx, session: SessionRow): Promise<number> {
  const entries = await ctx.tx
    .select()
    .from(waitlistEntries)
    .where(and(eq(waitlistEntries.sessionId, session.id), inArray(waitlistEntries.state, ["waiting", "offered"])))
    .for("update");
  for (const entry of entries) {
    waitlistTransition(entry, "released", transitionActor(ctx));
    await ctx.tx.update(waitlistEntries).set({ state: "released", endedReason: "session_cancelled", updatedAt: ctx.now }).where(eq(waitlistEntries.id, entry.id));
    await ctx.recordEvent({
      kind: "waitlist.released",
      personId: entry.personId,
      data: {
        session_id: session.id,
        session_kind: session.kind,
        event_category: session.eventCategory,
        starts_at: session.startsAt,
        paid_with: null,
        is_guest: false,
        guest_of_person_id: null,
        owner_person_id: entry.personId,
        is_first_booking: false,
        is_first_visit: false,
        queue: entry.queue,
        ended_reason: "session_cancelled",
        by: "beam",
      },
      ref: { type: "waitlist_entry", id: entry.id },
      dedupeKey: `waitlist:${entry.id}:released:${entry.offersCount}:${entry.rejoinCount}`,
    });
  }
  return entries.length;
}

/** The `sessions.cancel_bookings` job key of a chunk. */
export const cancelSessionJobKey = (sessionId: string, afterBookingId?: string | null) => `cancel_session:${sessionId}:${afterBookingId ?? "start"}`;

export type CancelSessionResult = SessionCancelCounts & { releasedEntries: number; queuedBookings: number };

/**
 * R33: the session becomes `cancelled` in this transaction (nobody books meanwhile), waiting and
 * offered entries are released, and the live bookings are cancelled with `session_cancelled`:
 * here when there are at most 50, otherwise in chunks of 50 by `sessions.cancel_bookings`.
 */
export async function cancelSessionRow(tx: Tx, ctx: Ctx, input: { sessionId: string; reason: string; notify: boolean }): Promise<CancelSessionResult> {
  const session = await lockSession(tx, input.sessionId);
  sessionTransition(session.status, "cancelled");
  const [updated] = await tx
    .update(sessions)
    .set({ status: "cancelled", cancelledAt: ctx.now, cancelReason: input.reason.trim(), updatedAt: ctx.now })
    .where(eq(sessions.id, session.id))
    .returning();
  const releasedEntries = await releaseSessionEntries(ctx, updated!);
  const [live] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(bookings)
    .where(and(eq(bookings.sessionId, session.id), inArray(bookings.status, [...LIVE_STATUSES])));
  const liveCount = Number(live?.n ?? 0);
  if (liveCount > SESSION_CANCEL_CHUNK) {
    await ctx.enqueue({ kind: "sessions.cancel_bookings", payload: { sessionId: session.id, notify: input.notify }, key: cancelSessionJobKey(session.id) });
    return { cancelledBookings: 0, refundsRequested: 0, creditsReleased: 0, ordersCancelled: 0, releasedEntries, queuedBookings: liveCount };
  }
  const counts = await cancelSessionChunk(tx, ctx, { sessionId: session.id, notify: input.notify, limit: Number.MAX_SAFE_INTEGER });
  return {
    cancelledBookings: counts.cancelledBookings,
    refundsRequested: counts.refundsRequested,
    creditsReleased: counts.creditsReleased,
    ordersCancelled: counts.ordersCancelled,
    releasedEntries,
    queuedBookings: 0,
  };
}

// ---------------------------------------------------------------------------
// Commerce refund and reservation expiry
// ---------------------------------------------------------------------------

/** Commerce's staff refund of a session line: its live rows become `cancelled` (`refunded`), never a second refund. */
export async function cancelRowsForOrderLine(tx: Tx, ctx: Ctx, input: { orderLineId: string; reason: "refunded" }): Promise<{ cancelledBookingIds: string[] }> {
  const rows = await tx
    .select({ id: bookings.id })
    .from(bookings)
    .where(and(eq(bookings.orderLineId, input.orderLineId), inArray(bookings.status, [...LIVE_STATUSES])))
    .orderBy(asc(bookings.createdAt));
  const out: string[] = [];
  for (const r of rows) {
    const result = await cancelBookingRow(tx, ctx, { bookingId: r.id, includeGuests: false, by: "system", reasonCode: input.reason, skipRefund: true });
    out.push(...result.cancelledBookingIds);
  }
  return { cancelledBookingIds: out };
}

/**
 * R18 safety net, R44, edge case 27: one `reserved` row past `reserved_until` whose order is not
 * paid becomes `cancelled` (`payment_expired`), its claimed waitlist entry `expired`
 * (`payment_not_completed`), and the seat goes to the waitlist. Returns false when the row is no
 * longer expirable (a repeated run).
 */
export async function expireReservedRow(tx: Tx, ctx: Ctx, bookingId: string): Promise<boolean> {
  const { booking, session } = await lockBooking(tx, bookingId);
  if (booking.status !== "reserved" || !booking.reservedUntil || booking.reservedUntil.getTime() > ctx.now.getTime()) return false;
  const order = await orderOf(tx, booking.orderLineId);
  if (order && PAID_ORDER.includes(order.status)) return false;
  bookingTransition("reserved", "cancelled", "system");
  const [row] = await tx
    .update(bookings)
    .set({ status: "cancelled", cancelledAt: ctx.now, cancelReasonCode: "payment_expired", version: sql`${bookings.version} + 1`, updatedAt: ctx.now })
    .where(eq(bookings.id, booking.id))
    .returning();
  await recordBookingFact(ctx, "booking.cancelled", row!, { by: "system", cancelReasonCode: "payment_expired" });
  await sendCancellationEmail(ctx, row!, session);
  await expireClaimedOffers(ctx, row!, session);
  if (session.status !== "cancelled") await enqueueOfferNext(ctx, session.id, booking.id);
  return true;
}

/** Ids of `reserved` rows past `reserved_until` (oldest first) whose order is not paid. */
export async function expiredReservationIds(tx: Tx, now: Date, limit: number): Promise<string[]> {
  const rows = await tx
    .select({ id: bookings.id })
    .from(bookings)
    .leftJoin(orderLines, eq(orderLines.id, bookings.orderLineId))
    .leftJoin(orders, eq(orders.id, orderLines.orderId))
    .where(
      and(
        eq(bookings.status, "reserved"),
        lte(bookings.reservedUntil, now),
        or(sql`${orders.id} is null`, sql`${orders.status} not in ('paid', 'partially_refunded')`),
      ),
    )
    .orderBy(asc(bookings.reservedUntil), asc(bookings.id))
    .limit(limit);
  return rows.map((r) => r.id);
}
