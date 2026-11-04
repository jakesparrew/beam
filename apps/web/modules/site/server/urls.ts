/**
 * Public URLs of pages, events and portal routes (site rules 31 and 57; api.ts section 4).
 * site-P1 writes `portalUrl` (pure) and the stubs of the database-backed functions with their final
 * signatures; site-P2 implements those over `page_routes` and `settings.site.canonical_origin`.
 */
import type { DbOrTx } from "@beam/db";
import { NotImplementedError } from "@beam/core/errors";
import type { Locale } from "@beam/core/i18n";
import { portalPath, type PortalRoute } from "@beam/core/site";

const notYet = <T>(fn: string): Promise<T> => Promise.reject(new NotImplementedError(`site.${fn}`));

/** Absolute URL of a page's live route in `locale`, or null. */
export function getPageUrl(_db: DbOrTx, _ref: { pageId: string } | { slug: string }, _locale: Locale): Promise<string | null> {
  return notYet("getPageUrl");
}

/** The event page of a session, or the portal booking URL when no page exists. */
export function getEventPageUrl(_db: DbOrTx, _sessionId: string, _locale: Locale): Promise<string | null> {
  return notYet("getEventPageUrl");
}

/** Site-relative portal URL, e.g. `/nl/account/book?kind=day`. */
export function portalUrl(locale: Locale, route: PortalRoute, params?: Record<string, string>): string {
  return portalPath(locale, route, params);
}
