/**
 * site's cross-module door. Forward stub written by platform-P5 (runbook DR-10): platform's
 * customer sign-up (PL-12) calls `readReferralCode`. platform-P7 rewrites this file with the
 * full stub set and keeps this export unchanged; site implements it in R3.
 */

/** Site rule 63: the referral code of the `beam_ref` cookie or `?ref=`; `null` before R3 (cross-module D18). */
export function readReferralCode(cookies: { get(name: string): { value: string } | undefined }, searchParams?: URLSearchParams): string | null {
  void cookies;
  void searchParams;
  return null;
}
