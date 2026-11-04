/**
 * booking's shared types (02-data-model section 6.3, booking spec 4.1 and 4.9). The settings
 * schemas live in `rules.ts` and are re-exported from the module index. Enum value lists match
 * `packages/db/src/schema/booking.ts`.
 */
import type { Locale } from "../i18n/locales";
import type { LocalizedText } from "../i18n/localized-text";

export type { Locale };

export const SESSION_KINDS = ["day", "night", "event"] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];
export type CreditKind = "day" | "night";

export const SESSION_STATUSES = ["open", "closed", "cancelled"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const EVENT_CATEGORIES = ["lecture", "concert", "member_event", "experience", "webinar", "special_activity", "partner_event"] as const;
export type EventCategory = (typeof EVENT_CATEGORIES)[number];

export const LEAD_RELEASE_RULES = ["customers_then_public", "public", "keep_for_leads"] as const;
export type LeadReleaseRule = (typeof LEAD_RELEASE_RULES)[number];

export const EXCEPTION_KINDS = ["closed", "holiday", "special_hours"] as const;
export type ExceptionKind = (typeof EXCEPTION_KINDS)[number];

export const HOLD_KINDS = ["staff", "partner", "host", "speaker", "blocked"] as const;
export type HoldKind = (typeof HOLD_KINDS)[number];

export const BOOKING_STATUSES = ["reserved", "confirmed", "cancelled", "late_cancelled", "no_show", "attended"] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export const PAID_WITH = ["credit", "order", "guest", "free"] as const;
export type PaidWith = (typeof PAID_WITH)[number];

export const BOOKING_SOURCES = ["portal", "admin", "waitlist", "import", "pos", "site"] as const;
export type BookingSource = (typeof BOOKING_SOURCES)[number];

export const CANCEL_REASON_CODES = [
  "customer",
  "staff",
  "session_cancelled",
  "payment_expired",
  "order_cancelled",
  "refunded",
  "rescheduled",
  "erased",
  "duplicate",
] as const;
export type CancelReasonCode = (typeof CANCEL_REASON_CODES)[number];

export const WAITLIST_QUEUES = ["lead", "customer", "public"] as const;
export type WaitlistQueue = (typeof WAITLIST_QUEUES)[number];

export const WAITLIST_STATES = ["waiting", "offered", "confirmed", "released", "expired", "withdrawn"] as const;
export type WaitlistState = (typeof WAITLIST_STATES)[number];

export const WAITLIST_ENDED_REASONS = [
  "declined",
  "session_started",
  "session_cancelled",
  "staff",
  "booked_directly",
  "offer_timeout",
  "payment_not_completed",
  "flag_withdrawn",
  "customer",
] as const;
export type WaitlistEndedReason = (typeof WAITLIST_ENDED_REASONS)[number];

/** Lead Magnet phase of a session (`v_session_availability.lead_phase`). */
export const LEAD_PHASES = ["none", "pre", "lead", "customer_release", "public"] as const;
export type LeadPhase = (typeof LEAD_PHASES)[number];

/** Who changes a state (platform `Actor['kind']`). */
export type ActorKind = "staff" | "customer" | "system" | "webhook" | "public";

export type AvailabilityBand = "available" | "few" | "full";

/** At most this many places left counts as "few" and shows the exact number (decision 32). */
export const FEW_PLACES_THRESHOLD = 5;

/** Booking spec 4.8 (cross-module D48); `level` uses booking's own thresholds. */
export type BookingHealth = {
  level: "ok" | "warn" | "alert";
  materialisedThroughOn: string;
  overdueOffers: number;
  overdueReservations: number;
  unsentConfirmations24h: number;
};

/** One `v_session_availability` row plus the session fields `computeAvailability` needs. */
export type AvailabilityRow = {
  sessionId: string;
  kind: SessionKind;
  startsAt: Date;
  endsAt: Date;
  status: SessionStatus;
  isLeadMagnet: boolean;
  publishedAt: Date | null;
  capacity: number;
  held: number;
  booked: number;
  leadBooked: number;
  liveOffers: number;
  liveLeadOffers: number;
  availableTotal: number;
  leadReservedRemaining: number;
  leadPhase: LeadPhase;
  availableGeneral: number;
  opensForCustomersAt: Date | null;
  opensForPublicAt: Date | null;
  waiting: number;
  /** From `sessions` (not in the view). */
  isMemberOnly: boolean;
  /** From `sessions`; a webinar session is never bookable here (R64). */
  webinarId: string | null;
};

/** The viewer of an availability (R15, R20): crm status plus a real membership. */
export type AvailabilityViewer = { status: "lead" | "customer" | "member" | "anonymous"; isMember: boolean };

/** What a person may do on a session right now (booking spec 4.1, rules R7, R9, R15, R20-R27). */
export type Availability = {
  /** Units this viewer can book now. */
  bookable: number;
  reason: "ok" | "full" | "member_only" | "not_open_yet" | "closed" | "cancelled" | "past" | "webinar";
  /** When the session opens for this viewer (`not_open_yet`), else null. */
  opensAt: Date | null;
  /** The next booking uses a lead-reserved seat (R22). */
  useLeadSeat: boolean;
  canJoinWaitlist: boolean;
  /** The queue a waitlist join goes to; null when joining is impossible. */
  queue: WaitlistQueue | null;
  phase: LeadPhase;
};

/** A bookable session as listed to customers, commerce's POS picker and site. */
export type SessionSummary = {
  sessionId: string;
  templateId: string | null;
  kind: SessionKind;
  title: LocalizedText;
  description: LocalizedText | null;
  startsAt: Date;
  endsAt: Date;
  status: SessionStatus;
  location: string | null;
  capacity: number;
  /** Units free for the viewer (or for the general public without a person). */
  free: number;
  band: AvailabilityBand;
  productId: string | null;
  creditKind: CreditKind | null;
  creditCost: number;
  isMemberOnly: boolean;
  isLeadMagnet: boolean;
  eventCategory: EventCategory | null;
  availability: Availability;
};

/** The email `event` block (booking spec 4.9). Carries no person data. */
export type SessionCard = {
  sessionId: string;
  /** Resolved to the requested locale. */
  title: string;
  kind: SessionKind;
  startsAt: Date;
  endsAt: Date;
  location: string | null;
  productId: string | null;
  isMemberOnly: boolean;
  isLeadMagnet: boolean;
  availabilityBand: AvailabilityBand;
  /** `/<locale>/account/book/<sessionId>`. */
  bookUrl: string;
  /** Lead window end when phase `lead` and no general seat is left; null until booking-P7. */
  opensForCustomersAt: Date | null;
};

/** A booking row on crm's person page. */
export type PersonBookingRow = {
  bookingId: string;
  sessionId: string;
  kind: SessionKind;
  title: LocalizedText;
  startsAt: Date;
  endsAt: Date;
  status: BookingStatus;
  sessionStatus: SessionStatus;
  paidWith: PaidWith;
  source: BookingSource;
  isGuest: boolean;
  ownerPersonId: string;
  bookedByPersonId: string | null;
  attendedAt: Date | null;
  cancelledAt: Date | null;
  cancelReasonCode: CancelReasonCode | null;
  createdAt: Date;
};
