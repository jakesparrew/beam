/**
 * Booking policy (booking spec 3.5, 3.0b, R6b, R27b-R32): cancellation outcome, reschedule
 * rules, the booking and session state machines, opening hours and room overlaps. Pure.
 */
import { InvalidTransitionError } from "./errors";
import type { BookingRules } from "./rules";
import type { ActorKind, BookingStatus, CreditKind, PaidWith, SessionKind, SessionStatus } from "./types";

const HOUR_MS = 3_600_000;

/** The end of the free cancellation window (`starts_at - free_cancel_hours[kind]`); null = never free. */
export function freeCancelUntil(kind: SessionKind, startsAt: Date, rules: BookingRules): Date | null {
  const hours = rules.free_cancel_hours[kind];
  return hours === null ? null : new Date(startsAt.getTime() - hours * HOUR_MS);
}

/**
 * R28 and R29: what cancelling at `now` does. Inside the free window (until `freeUntil`, that
 * second included): `cancelled`, credits released, order lines refunded. After it:
 * `late_cancelled`, credits released only when `late_cancel_releases_credit`, no refund.
 */
export function cancellationOutcome(
  b: { kind: SessionKind; startsAt: Date; paidWith: PaidWith },
  rules: BookingRules,
  now: Date,
): { status: "cancelled" | "late_cancelled"; releaseCredit: boolean; refund: boolean; freeUntil: Date | null } {
  const freeUntil = freeCancelUntil(b.kind, b.startsAt, rules);
  const usesCredit = b.paidWith === "credit" || b.paidWith === "guest";
  if (freeUntil && now.getTime() <= freeUntil.getTime()) {
    return { status: "cancelled", releaseCredit: usesCredit, refund: b.paidWith === "order", freeUntil };
  }
  return { status: "late_cancelled", releaseCredit: usesCredit && rules.late_cancel_releases_credit, refund: false, freeUntil };
}

export type BookingLike = { kind: SessionKind; startsAt: Date; paidWith: PaidWith; creditKind: CreditKind | null; productId: string | null };
export type SessionLike = { kind: SessionKind; startsAt: Date; creditKind: CreditKind | null; productId: string | null };

/**
 * R31 (customer rules): only inside the free window of the current booking, same kind and
 * credit kind, the same product for order-paid rows, and fewer than `max_reschedules_per_booking`
 * reschedules along the chain (`chainLength` = reschedules so far).
 */
export function canReschedule(
  from: BookingLike,
  to: SessionLike,
  rules: BookingRules,
  chainLength: number,
  now: Date,
): { ok: true } | { ok: false; code: "outside_window" | "different_kind" | "different_product" | "too_many" } {
  const freeUntil = freeCancelUntil(from.kind, from.startsAt, rules);
  if (!freeUntil || now.getTime() > freeUntil.getTime()) return { ok: false, code: "outside_window" };
  if (from.kind !== to.kind || from.creditKind !== to.creditKind) return { ok: false, code: "different_kind" };
  if (from.paidWith === "order" && from.productId !== to.productId) return { ok: false, code: "different_product" };
  if (chainLength >= rules.max_reschedules_per_booking) return { ok: false, code: "too_many" };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// State machines
// ---------------------------------------------------------------------------

const ALL: readonly ActorKind[] = ["staff", "customer", "system", "webhook", "public"];

/**
 * R27b: allowed booking transitions and who may make them. `null` is a new row. Commerce's
 * paid and expiry hooks run under whatever actor commerce has (customer page, webhook, POS
 * staff, job), so `reserved -> confirmed` accepts every actor; a customer can never cancel a
 * `reserved` row (it lapses with its order).
 */
export const BOOKING_TRANSITIONS: Readonly<Record<string, Partial<Record<BookingStatus, readonly ActorKind[]>>>> = {
  new: { reserved: ["customer", "staff", "public"], confirmed: ["customer", "staff", "public", "system"] },
  reserved: { confirmed: ALL, cancelled: ["staff", "system", "webhook"] },
  confirmed: {
    cancelled: ["customer", "staff", "system", "webhook"],
    late_cancelled: ["customer", "staff"],
    attended: ["staff"],
    no_show: ["staff", "system"],
  },
  attended: { confirmed: ["staff"] },
  no_show: { attended: ["staff"] },
  late_cancelled: { cancelled: ["staff"] },
  cancelled: {},
};

/** Throws `InvalidTransitionError` unless `actor` may move a booking from `from` (null = new) to `to`. */
export function bookingTransition(from: BookingStatus | null, to: BookingStatus, actor: ActorKind): void {
  const allowed = BOOKING_TRANSITIONS[from ?? "new"]?.[to];
  if (!allowed || !allowed.includes(actor)) throw new InvalidTransitionError(from, to, { entity: "booking", actor });
}

/** Session status machine: `open <-> closed`, `open | closed -> cancelled`; `cancelled` is terminal. */
export const SESSION_TRANSITIONS: Readonly<Record<SessionStatus, readonly SessionStatus[]>> = {
  open: ["closed", "cancelled"],
  closed: ["open", "cancelled"],
  cancelled: [],
};

/** Throws `InvalidTransitionError` for a forbidden session status change. */
export function sessionTransition(from: SessionStatus, to: SessionStatus): void {
  if (!SESSION_TRANSITIONS[from].includes(to)) throw new InvalidTransitionError(from, to, { entity: "session" });
}

// ---------------------------------------------------------------------------
// Rooms (R6b)
// ---------------------------------------------------------------------------

const roomKey = (location: string | null) => (location ?? "").trim().toLowerCase();

/** R6b: the ids of other sessions in the same room (case-insensitive `location`) that overlap in time. */
export function overlapsByLocation(
  a: { location: string | null; startsAt: Date; endsAt: Date },
  others: Array<{ id: string; location: string | null; startsAt: Date; endsAt: Date }>,
): string[] {
  const room = roomKey(a.location);
  if (!room) return [];
  return others
    .filter((o) => roomKey(o.location) === room && o.startsAt.getTime() < a.endsAt.getTime() && a.startsAt.getTime() < o.endsAt.getTime())
    .map((o) => o.id);
}
