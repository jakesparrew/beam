/**
 * site's cross-module door (02-data-model section 6.11, site spec section 4). A barrel created by
 * site-P1: every function another module calls, with its final signature, re-exported from the
 * `server/<area>.ts` file of the package that implements it (legal: site-P5, urls: site-P2,
 * settings: site-P3, referral: site-P9). Until then the functions throw `NotImplementedError`,
 * except `portalUrl` (pure) and `readReferralCode` (`null` before R3, build order section 2).
 * `PortalSiteChrome` is site-internal and not exported (cross-module D65).
 */
export type { LegalKey, PortalRoute, SiteSettings, TermsContext } from "@beam/core/site";
export { getCurrentLegalVersion, getLegalLinks, hasAcceptedCurrentTerms, recordTermsAcceptance } from "./server/legal";
export type { CurrentLegalVersion, RecordTermsAcceptanceInput } from "./server/legal";
export { getEventPageUrl, getPageUrl, portalUrl } from "./server/urls";
export { getSiteSettings } from "./server/settings";
export { readReferralCode } from "./server/referral";
/** The kind of the published page at `/<prefix>/<path>` in `locale`, or null (forms rule A2 branch 7). */
export { getPageKindByPath } from "./server/refs";
/**
 * The visit's stored UTM landing (rule 40). Client-safe itself, but this barrel also carries
 * server-only code: a client component imports it from `@beam/core/site`.
 */
export { readStoredUtm, UTM_STORAGE_KEY } from "@beam/core/site";
export type { StoredUtm } from "@beam/core/site";
