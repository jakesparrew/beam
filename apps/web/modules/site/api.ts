/**
 * site's cross-module door (02-data-model section 6.11). Wave 0 stubs by platform-P7 with the
 * owner's final signatures: each throws `NotImplementedError('site.<fn>')` until site implements
 * it. `readReferralCode` is platform-P5's forward stub, kept unchanged (DR-10): it returns
 * `null` before R3. `PortalSiteChrome` is site-internal and not exported (cross-module D65).
 */
import type { DbOrTx, Tx } from "@beam/db";
import { NotImplementedError } from "@beam/core/errors";
import type { Locale, LocalizedText } from "@beam/core/i18n";
import type { LegalKey, PortalRoute, SiteSettings, TermsContext } from "@beam/core/site";
import type { Ctx } from "@/lib/ctx";

export type { LegalKey, PortalRoute, SiteSettings, TermsContext } from "@beam/core/site";

const notYet = <T>(fn: string): Promise<T> => Promise.reject(new NotImplementedError(`site.${fn}`));

export function getCurrentLegalVersion(
  _db: DbOrTx,
  _key: LegalKey,
): Promise<{
  versionId: string;
  version: number;
  publishedAt: Date;
  requiresReacceptance: boolean;
  text: LocalizedText;
  urlByLocale: Partial<Record<Locale, string>>;
} | null> {
  return notYet("getCurrentLegalVersion");
}

export function recordTermsAcceptance(
  _tx: Tx,
  _ctx: Ctx,
  _input: { personId: string; versionId: string; context: TermsContext; refType?: "order" | "booking" | "user"; refId?: string; ip?: string | null },
): Promise<{ acceptanceId: string; created: boolean }> {
  return notYet("recordTermsAcceptance");
}

export function hasAcceptedCurrentTerms(_db: DbOrTx, _personId: string): Promise<boolean> {
  return notYet("hasAcceptedCurrentTerms");
}

/** Absolute URLs for email footers and checkout. */
export function getLegalLinks(_locale: Locale): Promise<{ privacy: string | null; terms: string | null; cookies: string | null; accessibility: string | null }> {
  return notYet("getLegalLinks");
}

export function getPageUrl(_db: DbOrTx, _ref: { pageId: string } | { slug: string }, _locale: Locale): Promise<string | null> {
  return notYet("getPageUrl");
}

export function getEventPageUrl(_db: DbOrTx, _sessionId: string, _locale: Locale): Promise<string | null> {
  return notYet("getEventPageUrl");
}

/** Site-relative portal URL, e.g. `/nl/account/book?kind=day`. */
export function portalUrl(_locale: Locale, _route: PortalRoute, _params?: Record<string, string>): string {
  throw new NotImplementedError("site.portalUrl");
}

export function getSiteSettings(_db: DbOrTx): Promise<SiteSettings> {
  return notYet("getSiteSettings");
}

/** Site rule 63: the referral code of the `beam_ref` cookie or `?ref=`; `null` before R3 (cross-module D18). */
export function readReferralCode(cookies: { get(name: string): { value: string } | undefined }, searchParams?: URLSearchParams): string | null {
  void cookies;
  void searchParams;
  return null;
}
