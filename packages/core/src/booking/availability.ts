/**
 * Per-viewer availability (booking spec 4.1; rules R7, R9, R15, R20-R27) from one
 * `v_session_availability` row. The view computes the capacity pools; this function decides
 * what a lead, customer, member or anonymous visitor may do with them right now.
 */
import { DEFAULT_BOOKING_RULES, type BookingRules } from "./rules";
import {
  FEW_PLACES_THRESHOLD,
  type Availability,
  type AvailabilityBand,
  type AvailabilityRow,
  type AvailabilityViewer,
  type WaitlistQueue,
} from "./types";

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

/** The availability band shown on site and in emails (decision 32). */
export function availabilityBand(available: number): AvailabilityBand {
  if (available <= 0) return "full";
  return available <= FEW_PLACES_THRESHOLD ? "few" : "available";
}

/** The queue a viewer joins: lead magnets split by status (R22-R25), others use `public`. */
function queueFor(row: AvailabilityRow, viewer: AvailabilityViewer): WaitlistQueue {
  if (!row.isLeadMagnet || row.leadPhase === "none") return "public";
  if (viewer.status === "lead") return "lead";
  if (viewer.status === "customer" || viewer.status === "member") return "customer";
  return "public";
}

/**
 * What `viewer` may do on the session at `now`. `rules` supplies the booking horizon and the
 * per-kind booking cut-off (R7); it defaults to `DEFAULT_BOOKING_RULES`.
 */
export function computeAvailability(
  row: AvailabilityRow,
  viewer: AvailabilityViewer,
  now: Date,
  rules: BookingRules = DEFAULT_BOOKING_RULES,
): Availability {
  const phase = row.isLeadMagnet ? row.leadPhase : "none";
  const blocked = (reason: Availability["reason"], opensAt: Date | null = null): Availability => ({
    bookable: 0,
    reason,
    opensAt,
    useLeadSeat: false,
    canJoinWaitlist: false,
    queue: null,
    phase,
  });

  if (row.webinarId) return blocked("webinar");
  if (row.status === "cancelled") return blocked("cancelled");
  if (row.startsAt.getTime() <= now.getTime()) return blocked("past");
  if (!row.publishedAt || row.publishedAt.getTime() > now.getTime()) return blocked("not_open_yet");
  const horizonOpensAt = new Date(row.startsAt.getTime() - rules.booking_horizon_days * DAY_MS);
  if (horizonOpensAt.getTime() > now.getTime()) return blocked("not_open_yet", horizonOpensAt);
  if (row.status === "closed") return blocked("closed");
  const cutoff = row.startsAt.getTime() - rules.book_until_minutes_before_start[row.kind] * MINUTE_MS;
  if (cutoff <= now.getTime()) return blocked("closed");
  if (row.isMemberOnly && !viewer.isMember) return blocked("member_only");

  const isLead = viewer.status === "lead";
  const isCustomer = viewer.status === "customer" || viewer.status === "member";
  const general = Math.max(0, row.availableGeneral);
  const leadSeats = Math.max(0, row.leadReservedRemaining);
  const total = Math.max(0, row.availableTotal);

  let bookable: number;
  let useLeadSeat = false;
  let opensAt: Date | null = null;
  switch (phase) {
    case "none":
      bookable = total;
      break;
    case "pre":
      bookable = general;
      break;
    case "lead":
      if (isLead) {
        bookable = leadSeats + general;
        useLeadSeat = leadSeats > 0;
      } else {
        bookable = general;
        if (general === 0 && leadSeats > 0) opensAt = row.opensForCustomersAt;
      }
      break;
    case "customer_release":
      if (isCustomer) bookable = total;
      else {
        bookable = 0;
        if (total > 0) opensAt = row.opensForPublicAt;
      }
      break;
    case "public":
      if (isLead) {
        bookable = leadSeats + general;
        useLeadSeat = leadSeats > 0;
      } else bookable = general;
      break;
  }

  const queue = queueFor(row, viewer);
  if (bookable > 0) return { bookable, reason: "ok", opensAt: null, useLeadSeat, canJoinWaitlist: false, queue, phase };
  if (opensAt) return { bookable: 0, reason: "not_open_yet", opensAt, useLeadSeat: false, canJoinWaitlist: true, queue, phase };
  return { bookable: 0, reason: "full", opensAt: null, useLeadSeat: false, canJoinWaitlist: true, queue, phase };
}
