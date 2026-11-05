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

// `GrantSharing` and `AllocationResult` are the spec shapes of `schemas.ts` and `allocate.ts`
// (credits section 4), re-exported by `index.ts`; the Wave 0 guesses that stood here are gone.
// `SharingReviewRow` is the real row type of `apps/web/modules/credits/server/sharing.ts`,
// exported from `apps/web/modules/credits/api.ts`; the Wave 0 guess that stood here is gone.
