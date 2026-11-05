/**
 * site queries, public pages (site spec section 4, site-P2): `getPageByPath`, `getNavMenus`,
 * `listPublicEventsForSite`, `listPosts`, `getPricingRows`, `getOpeningHours`,
 * `getCompanyFooter` and the small readers the block renderer needs (media, legal meta, event
 * facts, availability preview). Read through the app database; the public ones are wrapped in
 * `unstable_cache` with the tags of section 4, so every result is JSON-safe (ISO date strings,
 * never `Date`). `resolveRequest` lives in `server/resolve.ts`; `getSitemapEntries` and
 * `getLegalLinks` belong to site-P5. site-P8 (R2) adds the event extensions: ticket types with
 * public and member prices, the lead-window state of Lead Magnet events (rule 32, scenario 3), the
 * waitlist entry of a full event and the webinar link of a webinar-linked event (edge case 36).
 */
import { unstable_cache } from "next/cache";
import { files, mediaAssets, navMenus, pageRoutes, pages, pageVersions, products, sessions, ticketTypes, vLegalVersions, vTicketTypeAvailability } from "@beam/db/schema";
import type { DbOrTx } from "@beam/db";
import { percentOf } from "@beam/core/commerce";
import { LOCALES, type Locale, type LocalizedText } from "@beam/core/i18n";
import { BusinessHours, DEFAULT_BUSINESS_HOURS } from "@beam/core/booking";
import {
  bandFor,
  BlockSchema,
  companyFooter,
  localePath,
  parseSiteSettings,
  portalPath,
  prefixFromLocale,
  type AvailabilityBand,
  type Block,
  type CompanyFooter,
  type CompanySetting,
  type LegalKey,
  type Link,
  type NavItem,
  type NavMenuKey,
  type PageKind,
  type PageSeo,
  type SiteSettings,
} from "@beam/core/site";
import { and, asc, desc, eq, getAppDb, inArray, sql } from "@/lib/ctx";
import { NotImplementedError } from "@beam/core/errors";
import { reportError } from "@/lib/logger";
import { flag } from "@/lib/flags";
import { getSetting } from "@/lib/settings";
import { getAvailability, getAvailabilityPreview, getOpeningHours as bookingOpeningHours, listPublicEvents } from "@/modules/booking/api";
import { getProductPrice } from "@/modules/commerce/api";
import { bookSessionPath } from "../server/urls";

/** Cache lifetime of dynamic data blocks (rule 27: visible within 5 minutes). */
export const DYNAMIC_REVALIDATE = 300;

/**
 * `unstable_cache` with a fallback for code running outside a Next.js request (Vitest, scripts),
 * where the incremental cache does not exist and the function simply runs.
 */
function publicCache<A extends unknown[], R>(fn: (...args: A) => Promise<R>, key: string, opts: { tags: (...args: A) => string[]; revalidate?: number }) {
  return async (...args: A): Promise<R> => {
    const cached = unstable_cache(() => fn(...args), [key, JSON.stringify(args)], { tags: opts.tags(...args), revalidate: opts.revalidate });
    try {
      return await cached();
    } catch (error) {
      if (/incrementalCache missing|static generation store missing/i.test(String((error as Error)?.message ?? error))) return fn(...args);
      throw error;
    }
  };
}

/** A module api still a typed stub (`NotImplementedError`) is expected while modules land: not reported. */
function reportUnlessStub(error: unknown, step: string): void {
  if (!(error instanceof NotImplementedError)) reportError(error, { tags: { module: "site", step } });
}

const iso = (d: Date | string | null | undefined): string | null => (d ? new Date(d).toISOString() : null);
const pickText = (text: LocalizedText | null | undefined, locale: Locale): string | null => {
  const v = text?.[locale];
  return v && v.trim() ? v : null;
};

// ---------------------------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------------------------

export type ResolvedPage = {
  pageId: string;
  kind: PageKind;
  slug: string;
  legalKey: LegalKey | null;
  sessionId: string | null;
  versionId: string;
  version: number;
  locale: Locale;
  /** Path in `locale` without prefix (`''` = home). */
  path: string;
  title: string;
  blocks: Block[];
  seo: PageSeo | null;
  excerpt: string | null;
  coverMediaId: string | null;
  /** Live path per locale (only locales with a route); for a preview, the version's paths. */
  routes: Partial<Record<Locale, string>>;
  publishedAt: string | null;
  firstPublishedAt: string | null;
  isPreview: boolean;
};

type VersionRow = {
  pageId: string;
  kind: PageKind;
  slug: string;
  legalKey: LegalKey | null;
  sessionId: string | null;
  firstPublishedAt: Date | null;
  versionId: string;
  version: number;
  title: LocalizedText;
  blocks: Partial<Record<Locale, Block[]>>;
  seo: Partial<Record<Locale, PageSeo>>;
  excerpt: LocalizedText | null;
  coverMediaId: string | null;
  publishedAt: Date | null;
  paths: Partial<Record<Locale, string>>;
};

const versionColumns = {
  pageId: pages.id,
  kind: pages.kind,
  slug: pages.slug,
  legalKey: pages.legalKey,
  sessionId: pages.sessionId,
  firstPublishedAt: pages.firstPublishedAt,
  versionId: pageVersions.id,
  version: pageVersions.version,
  title: pageVersions.title,
  blocks: pageVersions.blocks,
  seo: pageVersions.seo,
  excerpt: pageVersions.excerpt,
  coverMediaId: pageVersions.coverMediaId,
  publishedAt: pageVersions.publishedAt,
  paths: pageVersions.paths,
};

/** Stored blocks are validated on write; anything that no longer parses is dropped and reported. */
function safeBlocks(raw: unknown, versionId: string): Block[] {
  if (!Array.isArray(raw)) return [];
  const out: Block[] = [];
  for (const b of raw) {
    const parsed = BlockSchema.safeParse(b);
    if (parsed.success) out.push(parsed.data);
    else reportError(new Error("site: stored block failed to parse"), { tags: { module: "site" }, extra: { versionId } });
  }
  return out;
}

function toResolved(row: VersionRow, locale: Locale, routes: Partial<Record<Locale, string>>, isPreview: boolean): ResolvedPage {
  return {
    pageId: row.pageId,
    kind: row.kind,
    slug: row.slug,
    legalKey: row.legalKey,
    sessionId: row.sessionId,
    versionId: row.versionId,
    version: row.version,
    locale,
    path: routes[locale] ?? row.paths[locale] ?? "",
    title: pickText(row.title, locale) ?? "",
    blocks: safeBlocks(row.blocks?.[locale], row.versionId),
    seo: row.seo?.[locale] ?? null,
    excerpt: pickText(row.excerpt, locale),
    coverMediaId: row.coverMediaId,
    routes,
    publishedAt: iso(row.publishedAt),
    firstPublishedAt: iso(row.firstPublishedAt),
    isPreview,
  };
}

/** Live routes of a page per locale. */
export async function pageRoutesOf(db: DbOrTx, pageId: string): Promise<Partial<Record<Locale, string>>> {
  const rows = await db.select({ locale: pageRoutes.locale, path: pageRoutes.path }).from(pageRoutes).where(eq(pageRoutes.pageId, pageId));
  const out: Partial<Record<Locale, string>> = {};
  for (const r of rows) out[r.locale] = r.path;
  return out;
}

async function loadPageByPath(locale: Locale, path: string): Promise<ResolvedPage | null> {
  const db = await getAppDb();
  const [row] = await db
    .select(versionColumns)
    .from(pageRoutes)
    .innerJoin(pages, and(eq(pages.id, pageRoutes.pageId), eq(pages.status, "published")))
    .innerJoin(pageVersions, eq(pageVersions.id, pages.currentVersionId))
    .where(and(eq(pageRoutes.locale, locale), eq(pageRoutes.path, path)));
  if (!row) return null;
  return toResolved(row, locale, await pageRoutesOf(db, row.pageId), false);
}

/** The live page at `path` (no prefix, `''` = home) in `locale`, or null (tags `site:routes`, `site:page:*`). */
export const getPageByPath = publicCache(loadPageByPath, "site:getPageByPath", { tags: () => ["site:routes", "site:pages"] });

/** Any version of a page, for the staff preview (never cached). */
export async function getPreviewPage(versionId: string, locale: Locale): Promise<ResolvedPage | null> {
  const db = await getAppDb();
  const [row] = await db.select(versionColumns).from(pageVersions).innerJoin(pages, eq(pages.id, pageVersions.pageId)).where(eq(pageVersions.id, versionId));
  if (!row) return null;
  return toResolved(row, locale, (row).paths ?? {}, true);
}

/** Live locales and paths of a page plus its title per locale (unavailable page, locale switch). */
export async function getPageAlternates(pageId: string): Promise<{ pageId: string; routes: Partial<Record<Locale, string>>; titles: LocalizedText } | null> {
  const db = await getAppDb();
  const [row] = await db
    .select({ title: pageVersions.title })
    .from(pages)
    .innerJoin(pageVersions, eq(pageVersions.id, pages.currentVersionId))
    .where(and(eq(pages.id, pageId), eq(pages.status, "published")));
  if (!row) return null;
  return { pageId, routes: await pageRoutesOf(db, pageId), titles: row.title };
}

// ---------------------------------------------------------------------------------------------
// Links and navigation
// ---------------------------------------------------------------------------------------------

/** Site-relative hrefs of the live routes of `pageIds` in `locale` (missing = hidden, rule 24). */
export async function pageHrefs(db: DbOrTx, pageIds: readonly string[], locale: Locale): Promise<Record<string, string>> {
  const ids = [...new Set(pageIds)];
  if (!ids.length) return {};
  const rows = await db
    .select({ pageId: pageRoutes.pageId, path: pageRoutes.path })
    .from(pageRoutes)
    .innerJoin(pages, and(eq(pages.id, pageRoutes.pageId), eq(pages.status, "published")))
    .where(and(inArray(pageRoutes.pageId, ids), eq(pageRoutes.locale, locale)));
  return Object.fromEntries(rows.map((r) => [r.pageId, localePath(locale, r.path)]));
}

/** The href of a content link, or null when its page target is hidden in this locale. */
export function linkHref(link: Link, locale: Locale, hrefs: Readonly<Record<string, string>>): string | null {
  if (link.kind === "url") return link.href;
  if (link.kind === "portal") return portalPath(locale, link.route);
  return hrefs[link.pageId] ?? null;
}

export type PublicNavItem = { id: string; label: string; href: string; external: boolean; children: PublicNavItem[] };
export type PublicNavMenus = Record<NavMenuKey, PublicNavItem[]>;

function collectPageIds(items: readonly NavItem[], out: string[] = []): string[] {
  for (const i of items) {
    if (i.target.kind === "page") out.push(i.target.pageId);
    collectPageIds(i.children ?? [], out);
  }
  return out;
}

function resolveItems(items: readonly NavItem[], locale: Locale, hrefs: Record<string, string>): PublicNavItem[] {
  const out: PublicNavItem[] = [];
  for (const item of items) {
    const label = pickText(item.label, locale);
    const href = linkHref(item.target, locale, hrefs);
    if (!label || !href) continue;
    out.push({ id: item.id, label, href, external: /^https:\/\//i.test(href), children: resolveItems(item.children ?? [], locale, hrefs) });
  }
  return out;
}

async function loadNavMenus(locale: Locale): Promise<PublicNavMenus> {
  const db = await getAppDb();
  const rows = await db.select({ key: navMenus.key, items: navMenus.items }).from(navMenus);
  const all = rows.flatMap((r) => r.items ?? []);
  const hrefs = await pageHrefs(db, collectPageIds(all), locale);
  const menus: PublicNavMenus = { header: [], footer: [], legal: [] };
  for (const r of rows) menus[r.key] = resolveItems(r.items ?? [], locale, hrefs);
  return menus;
}

/** Header, footer and legal menus in `locale`; items to hidden pages are left out (tag `site:nav`). */
export const getNavMenus = publicCache(loadNavMenus, "site:getNavMenus", { tags: () => ["site:nav", "site:routes"] });

// ---------------------------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------------------------

export type PublicMedia = { id: string; url: string; width: number; height: number; alt: string; decorative: boolean; caption: string | null };

/** Image URL served by platform's `/api/public/files/[id]`. */
export const fileUrl = (fileId: string): string => `/api/public/files/${fileId}`;

export async function getMediaByIds(mediaIds: readonly string[], locale: Locale): Promise<Record<string, PublicMedia>> {
  const ids = [...new Set(mediaIds)];
  if (!ids.length) return {};
  const db = await getAppDb();
  const rows = await db
    .select({ id: mediaAssets.id, fileId: mediaAssets.fileId, width: mediaAssets.width, height: mediaAssets.height, alt: mediaAssets.alt, decorative: mediaAssets.isDecorative, caption: mediaAssets.caption })
    .from(mediaAssets)
    .innerJoin(files, eq(files.id, mediaAssets.fileId))
    .where(inArray(mediaAssets.id, ids));
  return Object.fromEntries(
    rows.map((r) => [
      r.id,
      { id: r.id, url: fileUrl(r.fileId), width: r.width, height: r.height, alt: r.decorative ? "" : (pickText(r.alt, locale) ?? ""), decorative: r.decorative, caption: pickText(r.caption, locale) },
    ]),
  );
}

// ---------------------------------------------------------------------------------------------
// Events (rules 28-32)
// ---------------------------------------------------------------------------------------------

export type PublicEvent = {
  sessionId: string;
  title: string;
  startsAt: string;
  endsAt: string;
  status: "open" | "closed" | "cancelled";
  band: AvailabilityBand;
  isMemberOnly: boolean;
  isLeadMagnet: boolean;
  location: string | null;
  /** The event page in this locale, else the portal booking page. */
  href: string;
  bookHref: string;
  /**
   * R2 (rule 32, scenario 3): end of the open lead window of a Lead Magnet event (ISO), shown as
   * "Priority access for new guests until <date>"; null outside the window. Never a count or rank.
   */
  priorityUntil: string | null;
};

/** R2: the lead phase of a Lead Magnet session at `now`, from its window (same rule as `v_session_availability`). */
export function leadWindowOpen(s: { isLeadMagnet: boolean; leadWindowStartAt: Date | string | null; leadWindowEndAt: Date | string | null }, now: Date): boolean {
  if (!s.isLeadMagnet || !s.leadWindowEndAt) return false;
  const start = s.leadWindowStartAt ? new Date(s.leadWindowStartAt).getTime() : Number.NEGATIVE_INFINITY;
  return start <= now.getTime() && now.getTime() < new Date(s.leadWindowEndAt).getTime();
}

/** Lead window starts of the Lead Magnet sessions among `sessionIds` (the listing row carries only the end). */
async function leadWindowStarts(db: DbOrTx, sessionIds: readonly string[]): Promise<Map<string, Date | null>> {
  const ids = [...new Set(sessionIds)];
  if (!ids.length) return new Map();
  const rows = await db.select({ id: sessions.id, start: sessions.leadWindowStartAt }).from(sessions).where(inArray(sessions.id, ids));
  return new Map(rows.map((r) => [r.id, r.start]));
}

/** Site-relative event page paths of sessions in `locale`. */
export async function eventPageHrefs(db: DbOrTx, sessionIds: readonly string[], locale: Locale): Promise<Record<string, string>> {
  const ids = [...new Set(sessionIds)];
  if (!ids.length) return {};
  const rows = await db
    .select({ sessionId: pages.sessionId, path: pageRoutes.path })
    .from(pages)
    .innerJoin(pageRoutes, and(eq(pageRoutes.pageId, pages.id), eq(pageRoutes.locale, locale)))
    .where(and(inArray(pages.sessionId, ids), eq(pages.status, "published"), eq(pages.kind, "event")));
  return Object.fromEntries(rows.filter((r) => r.sessionId).map((r) => [r.sessionId!, localePath(locale, r.path)]));
}

async function loadPublicEvents(locale: Locale, opts: { page: number; limit: number; showFull: boolean }) {
  const db = await getAppDb();
  const page = Math.max(1, Math.floor(opts.page));
  const now = new Date();
  const rows = await listPublicEvents(db, { from: now, limit: opts.limit + 1, offset: (page - 1) * opts.limit });
  const hasMore = rows.length > opts.limit;
  const visible = rows
    .slice(0, opts.limit)
    .filter((r) => (r.status === "open" || r.status === "closed") && new Date(r.startsAt).getTime() >= now.getTime())
    .filter((r) => opts.showFull || (r.availabilityBand !== "full" && r.status !== "closed"));
  const hrefs = await eventPageHrefs(db, visible.map((r) => r.sessionId), locale);
  const starts = await leadWindowStarts(db, visible.filter((r) => r.isLeadMagnet && r.leadWindowEndAt).map((r) => r.sessionId));
  const items: PublicEvent[] = visible
    .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime())
    .map((r) => ({
      sessionId: r.sessionId,
      title: pickText(r.title, locale) ?? "",
      startsAt: iso(r.startsAt)!,
      endsAt: iso(r.endsAt)!,
      status: r.status,
      band: r.status === "closed" ? "full" : r.availabilityBand,
      isMemberOnly: r.isMemberOnly,
      isLeadMagnet: r.isLeadMagnet,
      location: r.location,
      href: hrefs[r.sessionId] ?? bookSessionPath(locale, r.sessionId),
      bookHref: bookSessionPath(locale, r.sessionId),
      priorityUntil: leadWindowOpen({ isLeadMagnet: r.isLeadMagnet, leadWindowStartAt: starts.get(r.sessionId) ?? null, leadWindowEndAt: r.leadWindowEndAt }, now) ? iso(r.leadWindowEndAt) : null,
    }));
  return { items, page, hasMore };
}

/** Upcoming public events, 12 per page by default (rule 28; revalidate 300, tag `site:events`). */
export const listPublicEventsForSite = publicCache(loadPublicEvents, "site:listPublicEventsForSite", {
  tags: () => ["site:events", "site:routes"],
  revalidate: DYNAMIC_REVALIDATE,
});

/** R2: one ticket type of an event (booking `ticket_types`, prices through `commerce.getProductPrice`). */
export type TicketTypeFact = {
  id: string;
  name: string;
  /** Null when the product has no current public price (the type is then shown without a price). */
  publicCents: number | null;
  /** "Members: <amount>" (rule 26), null when members pay the public price. */
  memberCents: number | null;
  isMemberOnly: boolean;
  /** On sale now (R51: active, after `sales_start_at`, before `sales_end_at` or the start). */
  onSale: boolean;
  /** Sales open later: the ISO start, else null. */
  salesStartAt: string | null;
  /** A capped type with no seat left ("Sold out"; never the count). */
  soldOut: boolean;
};

export type EventFacts = {
  sessionId: string;
  title: string;
  startsAt: string;
  endsAt: string;
  status: "open" | "closed" | "cancelled";
  location: string | null;
  isMemberOnly: boolean;
  isLeadMagnet: boolean;
  priceCents: number | null;
  /** R2: the member price of the session product (rule 26), null when equal to the public price. */
  memberPriceCents: number | null;
  /** Null when booking could not answer (the band is then not shown). */
  band: AvailabilityBand | null;
  bookHref: string;
  /** R2: the active ticket types in `sort_order`; empty for an event priced by its product only. */
  ticketTypes: TicketTypeFact[];
  /** R2 (rule 32, scenario 3): end of the open lead window (ISO), else null. */
  priorityUntil: string | null;
  /**
   * R2: whether booking now depends on the viewer's status (lead window or customer release of a
   * Lead Magnet event). The cached public page then shows "Check your access", never a booking button.
   */
  accessDependsOnViewer: boolean;
  /** R2: the session belongs to a webinar (booking refuses it; the webinar page registers). */
  isWebinar: boolean;
  /** R2 (edge case 36): the webinar's public page in this locale, null while it is not public. */
  webinar: { href: string } | null;
};

/** The member price of a product: its member price version or the public price minus the member discount (rule 26). */
async function memberPriceOf(db: DbOrTx, productId: string, publicCents: number, memberDiscountPct: string | number | null): Promise<number | null> {
  const candidates: number[] = [];
  const member = await getProductPrice(db, productId, "member");
  if (member) candidates.push(member.amountCents);
  if (memberDiscountPct !== null && Number(memberDiscountPct) > 0) candidates.push(Math.max(0, publicCents - percentOf(publicCents, memberDiscountPct)));
  const memberCents = candidates.length ? Math.min(...candidates) : null;
  return memberCents !== null && memberCents < publicCents ? memberCents : null;
}

/** Public and member price of a product; nulls when commerce cannot answer (reported unless a stub). */
async function pricesOf(db: DbOrTx, productId: string, step: string): Promise<{ publicCents: number | null; memberCents: number | null }> {
  try {
    const pub = await getProductPrice(db, productId, "public");
    if (!pub) return { publicCents: null, memberCents: null };
    const [p] = await db.select({ pct: products.memberDiscountPct }).from(products).where(eq(products.id, productId));
    return { publicCents: pub.amountCents, memberCents: await memberPriceOf(db, productId, pub.amountCents, p?.pct ?? null) };
  } catch (error) {
    reportUnlessStub(error, step);
    return { publicCents: null, memberCents: null };
  }
}

/** R2: the active ticket types of an event with their prices and sale state at `now`. */
export async function loadTicketTypeFacts(db: DbOrTx, session: { id: string; startsAt: Date }, locale: Locale, now: Date): Promise<TicketTypeFact[]> {
  const rows = await db
    .select({ t: ticketTypes, available: vTicketTypeAvailability.available })
    .from(ticketTypes)
    .leftJoin(vTicketTypeAvailability, eq(vTicketTypeAvailability.ticketTypeId, ticketTypes.id))
    .where(and(eq(ticketTypes.sessionId, session.id), eq(ticketTypes.isActive, true)))
    .orderBy(asc(ticketTypes.sortOrder), asc(ticketTypes.createdAt));
  const out: TicketTypeFact[] = [];
  for (const { t, available } of rows) {
    const prices = await pricesOf(db, t.productId, "event_ticket_price");
    const notYet = !!t.salesStartAt && now.getTime() < t.salesStartAt.getTime();
    const end = t.salesEndAt ?? session.startsAt;
    out.push({
      id: t.id,
      name: pickText(t.name, locale) ?? pickText(t.name, "en") ?? "",
      ...prices,
      isMemberOnly: t.isMemberOnly,
      onSale: !notYet && now.getTime() < end.getTime(),
      salesStartAt: notYet ? iso(t.salesStartAt) : null,
      soldOut: t.capacity !== null && available !== null && Number(available) <= 0,
    });
  }
  return out;
}

/** R2 (edge case 36): the public page of the webinar linked to the session, while webinars are public. */
async function webinarLinkOf(db: DbOrTx, sessionId: string, locale: Locale): Promise<{ href: string } | null> {
  try {
    if (!(await flag("ff_webinar_portal", { kind: "public" }))) return null;
    // Loaded on use: the webinar api pulls in email templates the other public readers do not need.
    const { getWebinarForSession } = await import("@/modules/webinar/api");
    const w = await getWebinarForSession(db, sessionId);
    return w ? { href: `/${prefixFromLocale(locale)}/webinars/${encodeURIComponent(w.slug)}` } : null;
  } catch (error) {
    reportUnlessStub(error, "event_webinar");
    return null;
  }
}

async function loadEventFacts(sessionId: string, locale: Locale): Promise<EventFacts | null> {
  const db = await getAppDb();
  const now = new Date();
  const [s] = await db
    .select({
      id: sessions.id,
      kind: sessions.kind,
      title: sessions.title,
      startsAt: sessions.startsAt,
      endsAt: sessions.endsAt,
      status: sessions.status,
      location: sessions.location,
      isMemberOnly: sessions.isMemberOnly,
      isLeadMagnet: sessions.isLeadMagnet,
      leadWindowStartAt: sessions.leadWindowStartAt,
      leadWindowEndAt: sessions.leadWindowEndAt,
      webinarId: sessions.webinarId,
      productId: sessions.productId,
    })
    .from(sessions)
    .where(eq(sessions.id, sessionId));
  if (!s || s.kind !== "event") return null;
  let band: AvailabilityBand | null = null;
  let phase: string = "none";
  try {
    const a = await getAvailability(db, { sessionId });
    band = bandFor({ bookable: a.bookable, capacity: a.capacity, reason: a.reason });
    phase = a.phase;
  } catch (error) {
    reportUnlessStub(error, "event_availability");
  }
  const prices = s.productId ? await pricesOf(db, s.productId, "event_price") : { publicCents: null, memberCents: null };
  let types: TicketTypeFact[] = [];
  try {
    types = await loadTicketTypeFacts(db, s, locale, now);
  } catch (error) {
    reportUnlessStub(error, "event_ticket_types");
  }
  const leadOpen = leadWindowOpen(s, now) || (s.isLeadMagnet && phase === "lead");
  const isWebinar = !!s.webinarId;
  return {
    sessionId: s.id,
    title: pickText(s.title, locale) ?? "",
    startsAt: iso(s.startsAt)!,
    endsAt: iso(s.endsAt)!,
    status: s.status,
    location: s.location,
    isMemberOnly: s.isMemberOnly,
    isLeadMagnet: s.isLeadMagnet,
    priceCents: prices.publicCents,
    memberPriceCents: prices.memberCents,
    band: isWebinar ? null : band,
    bookHref: bookSessionPath(locale, s.id),
    ticketTypes: types,
    priorityUntil: leadOpen ? iso(s.leadWindowEndAt) : null,
    accessDependsOnViewer: s.isLeadMagnet && (leadOpen || phase === "customer_release"),
    isWebinar,
    webinar: isWebinar ? await webinarLinkOf(db, s.id, locale) : null,
  };
}

/** Facts of an event page's session: date, place, prices, ticket types, band, lead window and webinar (revalidate 300). */
export const getEventFacts = publicCache(loadEventFacts, "site:getEventFacts", { tags: () => ["site:events", "site:prices"], revalidate: DYNAMIC_REVALIDATE });

export type AvailabilityDay = { sessionId: string; startsAt: string; band: AvailabilityBand };

async function loadAvailabilityPreview(kind: "day" | "night", days: number): Promise<AvailabilityDay[]> {
  const db = await getAppDb();
  const from = startOfBrusselsDay(new Date());
  const to = new Date(from.getTime() + days * 86_400_000);
  const rows = await getAvailabilityPreview(db, { kind, from, to });
  return rows.map((r) => ({ sessionId: r.sessionId, startsAt: iso(r.startsAt)!, band: r.band }));
}

/** Bands of the next `days` days for the `availability_preview` block (rule 30; revalidate 300). */
export const getAvailabilityPreviewForSite = publicCache(loadAvailabilityPreview, "site:getAvailabilityPreview", {
  tags: () => ["site:events"],
  revalidate: DYNAMIC_REVALIDATE,
});

// ---------------------------------------------------------------------------------------------
// Posts
// ---------------------------------------------------------------------------------------------

export type PublicPost = { pageId: string; title: string; excerpt: string | null; href: string; publishedAt: string; coverMediaId: string | null };

async function loadPosts(locale: Locale, opts: { page: number; limit: number }) {
  const db = await getAppDb();
  const page = Math.max(1, Math.floor(opts.page));
  const rows = await db
    .select({ pageId: pages.id, path: pageRoutes.path, title: pageVersions.title, excerpt: pageVersions.excerpt, firstPublishedAt: pages.firstPublishedAt, publishedAt: pageVersions.publishedAt, coverMediaId: pageVersions.coverMediaId })
    .from(pages)
    .innerJoin(pageRoutes, and(eq(pageRoutes.pageId, pages.id), eq(pageRoutes.locale, locale)))
    .innerJoin(pageVersions, eq(pageVersions.id, pages.currentVersionId))
    .where(and(eq(pages.kind, "post"), eq(pages.status, "published")))
    .orderBy(sql`${pages.firstPublishedAt} desc nulls last`, desc(pageVersions.publishedAt), asc(pages.id))
    .limit(opts.limit + 1)
    .offset((page - 1) * opts.limit);
  const items: PublicPost[] = rows.slice(0, opts.limit).map((r) => ({
    pageId: r.pageId,
    title: pickText(r.title, locale) ?? "",
    excerpt: pickText(r.excerpt, locale),
    href: localePath(locale, r.path),
    publishedAt: iso(r.firstPublishedAt ?? r.publishedAt) ?? new Date(0).toISOString(),
    coverMediaId: r.coverMediaId,
  }));
  return { items, page, hasMore: rows.length > opts.limit };
}

/** Published posts in `locale`, newest first (blog index, RSS). */
export const listPosts = publicCache(loadPosts, "site:listPosts", { tags: () => ["site:routes", "site:posts"] });

// ---------------------------------------------------------------------------------------------
// Pricing (rules 25-26)
// ---------------------------------------------------------------------------------------------

export type PricingRow = {
  productId: string;
  sku: string;
  kind: string;
  name: string;
  publicCents: number;
  /** "Members: <amount>": the member price version or the public price minus the member discount. */
  memberCents: number | null;
  creditKind: string | null;
  creditUnits: number | null;
  validityDays: number | null;
};

async function loadPricingRows(productIds: string[], locale: Locale): Promise<PricingRow[]> {
  if (!productIds.length) return [];
  const db = await getAppDb();
  const rows = await db
    .select({ id: products.id, sku: products.sku, kind: products.kind, name: products.name, creditKind: products.creditKind, creditUnits: products.creditUnits, validityDays: products.validityDays, memberDiscountPct: products.memberDiscountPct, isActive: products.isActive })
    .from(products)
    .where(inArray(products.id, productIds));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: PricingRow[] = [];
  for (const id of productIds) {
    const p = byId.get(id);
    if (!p || !p.isActive) continue;
    const pub = await getProductPrice(db, id, "public");
    if (!pub) continue;
    const memberCents = await memberPriceOf(db, id, pub.amountCents, p.memberDiscountPct);
    out.push({
      productId: id,
      sku: p.sku,
      kind: p.kind,
      name: pickText(p.name, locale) ?? p.sku,
      publicCents: pub.amountCents,
      memberCents,
      creditKind: p.creditKind,
      creditUnits: p.creditUnits,
      validityDays: p.validityDays,
    });
  }
  return out;
}

/** Rows of a pricing table in block order; inactive and unpriced products are left out (revalidate 300, tag `site:prices`). */
export const getPricingRows = publicCache(loadPricingRows, "site:getPricingRows", { tags: () => ["site:prices"], revalidate: DYNAMIC_REVALIDATE });

/** `sku` per product id, for `buy_product` links (active products only). */
export async function getProductSkus(productIds: readonly string[]): Promise<Record<string, string>> {
  const ids = [...new Set(productIds)];
  if (!ids.length) return {};
  const db = await getAppDb();
  const rows = await db.select({ id: products.id, sku: products.sku }).from(products).where(and(inArray(products.id, ids), eq(products.isActive, true)));
  return Object.fromEntries(rows.map((r) => [r.id, r.sku]));
}

// ---------------------------------------------------------------------------------------------
// Opening hours (rules 58-59), company and settings
// ---------------------------------------------------------------------------------------------

/** UTC instant of 00:00 Europe/Brussels on the day of `at`. */
export function startOfBrusselsDay(at: Date): Date {
  const day = brusselsDate(at);
  const guess = new Date(`${day}T00:00:00Z`);
  const offsetMin = brusselsOffsetMinutes(guess);
  return new Date(guess.getTime() - offsetMin * 60_000);
}

/** `YYYY-MM-DD` in Europe/Brussels. */
export function brusselsDate(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Brussels", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

function brusselsOffsetMinutes(at: Date): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Brussels", timeZoneName: "shortOffset" }).formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? "GMT+1";
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name);
  if (!m) return 60;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}

const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export type OpeningHoursView = {
  /** Weekly hours, ISO weekday 1-7; null when `settings.business_hours` has no open day (rule 59). */
  weekly: { weekday: number; opensAt: string | null; closesAt: string | null }[] | null;
  /** Days of the next 30 with an exception name (rule 58). */
  exceptions: { onDate: string; opensAt: string | null; closesAt: string | null; name: string }[];
  note: string | null;
};

/** A setting through platform's `getSetting` (its declared default when no row exists). */
async function readSetting(db: DbOrTx, key: "business_hours" | "company" | "site"): Promise<unknown> {
  return getSetting(db, key);
}

async function loadOpeningHours(locale: Locale): Promise<OpeningHoursView> {
  const db = await getAppDb();
  const raw = await readSetting(db, "business_hours");
  const parsed = BusinessHours.safeParse(raw ?? DEFAULT_BUSINESS_HOURS);
  const hours = parsed.success ? parsed.data : null;
  const weekly = hours
    ? ([1, 2, 3, 4, 5, 6, 7] as const).map((d) => ({ weekday: d, opensAt: hours.week[d]?.opens_at ?? null, closesAt: hours.week[d]?.closes_at ?? null }))
    : null;
  const hasOpenDay = !!weekly?.some((d) => d.opensAt && d.closesAt);
  const today = brusselsDate(new Date());
  let exceptions: OpeningHoursView["exceptions"] = [];
  try {
    const days = await bookingOpeningHours(db, { from: today, to: addDays(today, 30) });
    exceptions = days
      .filter((d) => d.exceptionName)
      .map((d) => ({ onDate: d.onDate, opensAt: d.opensAt, closesAt: d.closesAt, name: pickText(d.exceptionName, locale) ?? pickText(d.exceptionName, "en") ?? "" }))
      .filter((d) => d.name);
  } catch (error) {
    reportUnlessStub(error, "opening_hours");
  }
  return { weekly: hasOpenDay ? weekly : null, exceptions, note: hours?.note?.[locale] ?? null };
}

/** Weekly hours plus the exceptions of the next 30 days (revalidate 300, tag `site:hours`). */
export const getOpeningHours = publicCache(loadOpeningHours, "site:getOpeningHours", { tags: () => ["site:hours"], revalidate: DYNAMIC_REVALIDATE });

export type CompanyFooterView = CompanyFooter & { social: { key: string; href: string }[] };

async function loadCompanyFooter(_locale: Locale): Promise<CompanyFooterView> {
  const db = await getAppDb();
  const [company, site] = await Promise.all([readSetting(db, "company"), readSetting(db, "site")]);
  const social = Object.entries(parseSiteSettings(site).social_links)
    .filter((e): e is [string, string] => typeof e[1] === "string" && e[1].startsWith("https://"))
    .map(([key, href]) => ({ key, href }));
  return { ...companyFooter((company ?? null)), social };
}

/** Company identification of the footer (rule 60) and the social links of `settings.site`. */
export const getCompanyFooter = publicCache(loadCompanyFooter, "site:getCompanyFooter", { tags: () => ["site:settings"], revalidate: DYNAMIC_REVALIDATE });

/** `settings.site` and `settings.company` for metadata and JSON-LD (revalidate 300). */
export const getPublicSettings = publicCache(
  async (): Promise<{ site: SiteSettings; company: CompanySetting }> => {
    const db = await getAppDb();
    const [company, site] = await Promise.all([readSetting(db, "company"), readSetting(db, "site")]);
    return { site: parseSiteSettings(site), company: (company ?? {}) };
  },
  "site:getPublicSettings",
  { tags: () => ["site:settings"], revalidate: DYNAMIC_REVALIDATE },
);

// ---------------------------------------------------------------------------------------------
// Legal meta
// ---------------------------------------------------------------------------------------------

/** "Version n, last updated <date>" of a published legal version (`v_legal_versions` ordinal). */
export async function getLegalMeta(versionId: string): Promise<{ ordinal: number; publishedAt: string } | null> {
  const db = await getAppDb();
  const [r] = await db.select({ ordinal: vLegalVersions.ordinal, publishedAt: vLegalVersions.publishedAt }).from(vLegalVersions).where(eq(vLegalVersions.versionId, versionId));
  return r ? { ordinal: Number(r.ordinal), publishedAt: iso(r.publishedAt)! } : null;
}

/** Locales a page may be offered in (every locale the site serves). */
export const SITE_LOCALES: readonly Locale[] = LOCALES;

/** Site-relative href of the live singleton page of `kind` (home, events index, blog index, contact) in `locale`. */
export async function getSingletonHref(kind: "home" | "events_index" | "blog_index" | "contact", locale: Locale): Promise<string | null> {
  const db = await getAppDb();
  const [row] = await db
    .select({ path: pageRoutes.path })
    .from(pages)
    .innerJoin(pageRoutes, and(eq(pageRoutes.pageId, pages.id), eq(pageRoutes.locale, locale)))
    .where(and(eq(pages.kind, kind), eq(pages.status, "published")))
    .limit(1);
  return row ? localePath(locale, row.path) : null;
}
