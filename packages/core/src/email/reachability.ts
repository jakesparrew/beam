/**
 * Marketing reachability (email spec section 2, view `v_marketing_reachability`; rules 32, 40,
 * 55). Pure. `resolveReachability()` mirrors the view's `case` exactly, in the same order:
 * erased, no_email, restricted, suppressed, withdrawn, then granted (reachable) or no_consent.
 */

export const BLOCKED_REASONS = ["erased", "no_email", "restricted", "suppressed", "withdrawn", "no_consent"] as const;
export type BlockedReason = (typeof BLOCKED_REASONS)[number];

export type ReachabilityInput = {
  erased: boolean;
  hasEmail: boolean;
  restricted: boolean;
  isSuppressed: boolean;
  consentStatus: "granted" | "withdrawn" | null;
};

export function resolveReachability(input: ReachabilityInput): BlockedReason | null {
  if (input.erased) return "erased";
  if (!input.hasEmail) return "no_email";
  if (input.restricted) return "restricted";
  if (input.isSuppressed) return "suppressed";
  if (input.consentStatus === "withdrawn") return "withdrawn";
  if (input.consentStatus === "granted") return null;
  return "no_consent";
}

export type RecipientSkipStatus = "skipped_suppressed" | "skipped_consent" | "skipped_unreachable";

/** The `campaign_recipients.status` a chunk writes for a blocked recipient (rule 32). */
export function recipientSkipStatus(reason: BlockedReason): RecipientSkipStatus {
  switch (reason) {
    case "suppressed":
      return "skipped_suppressed";
    case "withdrawn":
    case "no_consent":
      return "skipped_consent";
    default:
      return "skipped_unreachable";
  }
}
