/**
 * Referral links (site rule 63, R3; site-P9). A visit with `?ref=<CODE>` (8 characters from
 * `A-HJ-NP-Z2-9`) keeps the code in cookie `beam_ref` (30 days, marketing consent) or, without
 * marketing consent, carries it on that page view's portal, checkout and form links
 * (`ui/public/referral-capture.tsx`). The request handlers that create persons (forms' submit
 * route, commerce's checkout, platform's customer sign-up, webinar's registration route) call
 * `readReferralCode` and pass the result to crm as `acquisition.referral_code` (cross-module D18).
 * The stored code wins over a later `?ref=` (the first code wins while the cookie lives).
 */
import { normaliseReferralCode, REFERRAL_COOKIE, REFERRAL_PARAM } from "@beam/core/site";

/** The valid code in `beam_ref`, or null (a cookie store that throws reads as none). */
function storedCode(cookies: { get(name: string): { value: string } | undefined }): string | null {
  try {
    return normaliseReferralCode(cookies.get(REFERRAL_COOKIE)?.value);
  } catch {
    return null;
  }
}

export function readReferralCode(cookies: { get(name: string): { value: string } | undefined }, searchParams?: URLSearchParams): string | null {
  const stored = storedCode(cookies);
  return stored ?? normaliseReferralCode(searchParams?.get(REFERRAL_PARAM));
}
