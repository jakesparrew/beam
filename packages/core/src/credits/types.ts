/**
 * credits types named in the cross-module contract (02-data-model section 6.5). Wave 0
 * skeleton by platform-P7; credits owns this file from credits-P1 on.
 */
export type CreditKind = "day" | "night" | "euro";

export type ReleaseReason =
  | "cancelled_in_policy"
  | "late_cancel_released"
  | "no_show_released"
  | "rescheduled"
  | "session_cancelled"
  | "staff_override"
  | "order_expired"
  | "refund";

/** How a grant may be shared (credits rule 2; rows from R2). */
export type GrantSharing = {
  mode: "none" | "guests" | "named";
  max_guests_per_month?: number | null;
  named_person_ids?: string[];
};

/** The result of the pure allocation over a person's usable grants. */
export type AllocationResult =
  | { ok: true; allocations: { grantId: string; quantity: number }[]; remainingUnits: number }
  | { ok: false; reason: "insufficient" | "guest_limit" | "not_shareable" | "share_limit"; needed: number; available: number };

export type SharingReviewRow = {
  personId: string;
  grantId: string;
  distinctGuests30d: number;
  guestUses30d: number;
  lastUseAt: Date | null;
};
