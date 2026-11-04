/**
 * Analytics gating that is pure and safe on both server and client (rule 37, site spec section 6).
 * `gaIdFor` lives here, not in the client `AnalyticsLoader` module, because the site layout (a
 * server component) calls it: a function exported from a `"use client"` module is only a client
 * reference on the server and cannot be called there.
 */

const GA_ID_RE = /^G-[A-Z0-9]{4,12}$/;

/** True for a syntactically valid GA4 measurement id (`G-` and 4 to 12 upper-case letters or digits). */
export function isGaMeasurementId(id: string | null | undefined): id is string {
  return typeof id === "string" && GA_ID_RE.test(id);
}

/** The GA4 id to load on this page, or null (production, switched on, valid id). */
export function gaIdFor(input: { isProduction: boolean; analyticsEnabled: boolean; gaMeasurementId: string | null | undefined }): string | null {
  if (!input.isProduction || !input.analyticsEnabled) return null;
  const id = input.gaMeasurementId?.trim() ?? "";
  return isGaMeasurementId(id) ? id : null;
}

/**
 * Pages whose URL carries a credential: the seat claim (`/<p>/claim/<token>`), the preference
 * centre (`/<p>/preferences/<token>`), the payment link (`/<p>/pay/<token>`) and a form result link
 * (`/<p>/f/<slug>/r/<token>`). GA4 sends `page_location` and Vercel Analytics the path, so no
 * analytics script loads there, whatever the consent (booking spec 5.3 "no third-party scripts").
 */
const TOKEN_PAGE_RE = /^\/(nl|fr|en)\/(?:(?:claim|preferences|pay)\/|f\/[^/]+\/r\/)/i;

/**
 * Whether analytics may load on the requested path (`x-pathname`, query ignored). An unknown path
 * (no header) fails closed: no analytics rather than a possible token leak.
 */
export function analyticsAllowedOnPath(path: string | null | undefined): boolean {
  const p = (path ?? "").split(/[?#]/)[0] ?? "";
  if (!p.startsWith("/")) return false;
  return !TOKEN_PAGE_RE.test(p);
}
