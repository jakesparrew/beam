/**
 * Referral links (site rule 63, R3). platform-P5's forward stub, moved here unchanged by site-P1:
 * returns `null` before R3 (cross-module D18). site-P9 implements it (cookie `beam_ref`, 30 days,
 * marketing consent; `?ref=` of 8 characters from `A-HJ-NP-Z2-9`).
 */
export function readReferralCode(cookies: { get(name: string): { value: string } | undefined }, searchParams?: URLSearchParams): string | null {
  void cookies;
  void searchParams;
  return null;
}
