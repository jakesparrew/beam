/**
 * booking's error classes (booking spec 4.2). Each carries `code = 'conflict'` and a `reason`
 * from the spec's list, so `action()` maps it to `{ code: 'conflict', message: reason }`
 * through `error.code`. They are permanent: a job that hits one never succeeds by retrying.
 */
import { PermanentError } from "../errors";

/** Every `conflict` reason booking returns (booking spec 4.2). */
export const BOOKING_CONFLICT_REASONS = [
  "session_full",
  "already_booked",
  "already_waiting",
  "stale_version",
  "outside_window",
  "not_on_sale",
  "member_only",
  "insufficient_credits",
  "sharing_not_allowed",
  "needs_review",
  "capacity_below_bookings",
  "protected_seat",
  "payment_required",
  "terms_required",
  "health_declaration_required",
  "emergency_contact_required",
  "webinar_session",
  "webinar_session_mismatch",
  "session_closed",
  "invalid_transition",
  "shared_bed_limit",
] as const;
export type BookingConflictReason = (typeof BOOKING_CONFLICT_REASONS)[number];

/** A booking rule refused the request. `message` is the reason, which `action()` returns. */
export class BookingConflictError extends PermanentError {
  override readonly name: string = "BookingConflictError";
  readonly code = "conflict" as const;
  readonly reason: BookingConflictReason;
  /** Optional details for the caller (never personal data beyond ids). */
  readonly data: Record<string, unknown> | undefined;
  constructor(reason: BookingConflictReason, data?: Record<string, unknown>) {
    super(reason);
    this.reason = reason;
    this.data = data;
  }
}

/** No bookable unit left (R10, R13). */
export class SessionFullError extends BookingConflictError {
  override readonly name: string = "SessionFullError";
  constructor(data?: Record<string, unknown>) {
    super("session_full", data);
  }
}

/** The person already holds a live booking in the session (R14). */
export class AlreadyBookedError extends BookingConflictError {
  override readonly name: string = "AlreadyBookedError";
  constructor(data?: Record<string, unknown>) {
    super("already_booked", data);
  }
}

/** A booking, session or waitlist status change that the state machine forbids (R27b, R41). */
export class InvalidTransitionError extends BookingConflictError {
  override readonly name: string = "InvalidTransitionError";
  readonly from: string | null;
  readonly to: string;
  constructor(from: string | null, to: string, data?: Record<string, unknown>) {
    super("invalid_transition", { from, to, ...data });
    this.from = from;
    this.to = to;
  }
}

/** A `confirmed` waitlist entry can never be changed (R41, edge case 13). */
export class ProtectedSeatError extends BookingConflictError {
  override readonly name: string = "ProtectedSeatError";
  constructor(data?: Record<string, unknown>) {
    super("protected_seat", data);
  }
}

/** Outside the free cancellation, reschedule, check-in or booking window. */
export class OutsideWindowError extends BookingConflictError {
  override readonly name: string = "OutsideWindowError";
  constructor(data?: Record<string, unknown>) {
    super("outside_window", data);
  }
}

/** Duplicate signals put the request on staff review (R48). */
export class NeedsReviewError extends BookingConflictError {
  override readonly name: string = "NeedsReviewError";
  constructor(data?: Record<string, unknown>) {
    super("needs_review", data);
  }
}

/** A `reserved` (unpaid) booking cannot be checked in (R35). */
export class PaymentRequiredError extends BookingConflictError {
  override readonly name: string = "PaymentRequiredError";
  constructor(data?: Record<string, unknown>) {
    super("payment_required", data);
  }
}

/** The first booking or waitlist join needs `acceptTerms: true` (R62). */
export class TermsRequiredError extends BookingConflictError {
  override readonly name: string = "TermsRequiredError";
  constructor(data?: Record<string, unknown>) {
    super("terms_required", data);
  }
}

/** True for any booking conflict (optionally of one reason). */
export function isBookingConflict(error: unknown, reason?: BookingConflictReason): error is BookingConflictError {
  return error instanceof BookingConflictError && (reason === undefined || error.reason === reason);
}
