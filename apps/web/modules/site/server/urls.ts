/**
 * Public URLs of pages, events and portal routes (site rules 31 and 57; api.ts section 4).
 * `portalUrl` is pure; `getPageUrl` and `getEventPageUrl` read `page_routes` and the canonical
 * origin from `settings.site.canonical_origin` (site-P2).
 */
import type { DbOrTx } from "@beam/db";
import { pageRoutes, pages, sessions, settings } from "@beam/db/schema";
import type { Locale } from "@beam/core/i18n";
import { localePath, parseSiteSettings, portalPath, prefixFromLocale, type PortalRoute } from "@beam/core/site";
import { and, eq } from "@/lib/ctx";

/** `settings.site.canonical_origin` without trailing slash (default `https://www.beam.be`). */
export async function canonicalOrigin(db: DbOrTx): Promise<string> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, "site"));
  return parseSiteSettings(row?.value).canonical_origin.replace(/\/+$/, "");
}

/** `origin` + a site-relative path (`/nl/...`). */
export function absoluteUrl(origin: string, path: string): string {
  return `${origin.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

/** The live path of a page in `locale` (`''` for home), or null. */
export async function livePagePath(db: DbOrTx, pageId: string, locale: Locale): Promise<string | null> {
  const [row] = await db
    .select({ path: pageRoutes.path })
    .from(pageRoutes)
    .innerJoin(pages, eq(pages.id, pageRoutes.pageId))
    .where(and(eq(pageRoutes.pageId, pageId), eq(pageRoutes.locale, locale), eq(pages.status, "published")));
  return row ? row.path : null;
}

/** Absolute URL of a page's live route in `locale`, or null. */
export async function getPageUrl(db: DbOrTx, ref: { pageId: string } | { slug: string }, locale: Locale): Promise<string | null> {
  let pageId: string | undefined;
  if ("pageId" in ref) pageId = ref.pageId;
  else {
    const [row] = await db.select({ id: pages.id }).from(pages).where(eq(pages.slug, ref.slug));
    pageId = row?.id;
  }
  if (!pageId) return null;
  const path = await livePagePath(db, pageId, locale);
  if (path === null) return null;
  return absoluteUrl(await canonicalOrigin(db), localePath(locale, path));
}

/** Site-relative booking page of one session: `/<prefix>/account/book/<sessionId>` (booking). */
export function bookSessionPath(locale: Locale, sessionId: string): string {
  return `/${prefixFromLocale(locale)}/account/book/${sessionId}`;
}

/** Site-relative guest checkout of a product: `/<prefix>/checkout?sku=<sku>&from=<page path>` (rule 31, D56). */
export function checkoutPath(locale: Locale, sku: string, fromPath: string): string {
  const query = new URLSearchParams({ sku, from: fromPath }).toString();
  return `/${prefixFromLocale(locale)}/checkout?${query}`;
}

/** Site-relative gift voucher page (commerce). */
export function giftPath(locale: Locale): string {
  return `/${prefixFromLocale(locale)}/gift`;
}

/** The stable event link `/<prefix>/events/<sessionId>` (rule 57). */
export function stableEventPath(locale: Locale, sessionId: string): string {
  return `/${prefixFromLocale(locale)}/events/${sessionId}`;
}

/** Site-relative path of the published event page of a session in `locale`, or null. */
export async function eventPagePath(db: DbOrTx, sessionId: string, locale: Locale): Promise<string | null> {
  const [row] = await db
    .select({ path: pageRoutes.path })
    .from(pages)
    .innerJoin(pageRoutes, and(eq(pageRoutes.pageId, pages.id), eq(pageRoutes.locale, locale)))
    .where(and(eq(pages.sessionId, sessionId), eq(pages.status, "published"), eq(pages.kind, "event")));
  return row ? localePath(locale, row.path) : null;
}

/** Whether `sessionId` is an existing session of kind `event`. */
export async function isEventSession(db: DbOrTx, sessionId: string): Promise<boolean> {
  const [row] = await db.select({ kind: sessions.kind }).from(sessions).where(eq(sessions.id, sessionId));
  return row?.kind === "event";
}

/**
 * The event page of a session in `locale` (absolute), or the portal booking URL when no page is
 * published in that locale; null for an unknown or non-event session.
 */
export async function getEventPageUrl(db: DbOrTx, sessionId: string, locale: Locale): Promise<string | null> {
  if (!(await isEventSession(db, sessionId))) return null;
  const origin = await canonicalOrigin(db);
  const path = await eventPagePath(db, sessionId, locale);
  return absoluteUrl(origin, path ?? bookSessionPath(locale, sessionId));
}

/** Site-relative portal URL, e.g. `/nl/account/book?kind=day`. */
export function portalUrl(locale: Locale, route: PortalRoute, params?: Record<string, string>): string {
  return portalPath(locale, route, params);
}
