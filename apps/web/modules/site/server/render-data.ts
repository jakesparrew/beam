/**
 * Everything a page's blocks need, loaded before rendering (site-P2): media, link targets,
 * pricing rows, event and post lists, availability bands, opening hours, company details, the
 * legal "Version n", event facts and the page's JSON-LD. Each dynamic loader is isolated: a
 * failing module api (or a not-yet-built one) hides that block's data and is reported, and the
 * page still renders. The block components themselves stay synchronous and pure.
 */
import type { Locale } from "@beam/core/i18n";
import type { UtmParams } from "@beam/core/forms";
import { buildJsonLd, localePath, richDocToPlainText, type Block, type BreadcrumbFacts, type JsonLdFacts } from "@beam/core/site";
import { reportError } from "@/lib/logger";
import {
  getAvailabilityPreviewForSite,
  getCompanyFooter,
  getEventFacts,
  getLegalMeta,
  getMediaByIds,
  getOpeningHours,
  getPageByPath,
  getPricingRows,
  getProductSkus,
  getPublicSettings,
  listPosts,
  listPublicEventsForSite,
  pageHrefs,
  type AvailabilityDay,
  type CompanyFooterView,
  type EventFacts,
  type OpeningHoursView,
  type PricingRow,
  type PublicEvent,
  type PublicMedia,
  type PublicPost,
  type ResolvedPage,
} from "../queries/public";
import { getAppDb } from "@/lib/ctx";
import { absoluteUrl } from "./urls";

export type Paged<T> = { items: T[]; page: number; hasMore: boolean };

export type RenderData = {
  locale: Locale;
  /** Site-relative path of the page (`/nl/prijzen`); `from` of buy links, `pagePath` of forms. */
  pagePath: string;
  media: Record<string, PublicMedia>;
  /** Site-relative hrefs of linked pages that are live in this locale. */
  hrefs: Record<string, string>;
  skus: Record<string, string>;
  pricing: Record<string, PricingRow[] | null>;
  events: Record<string, Paged<PublicEvent> | null>;
  posts: Record<string, Paged<PublicPost> | null>;
  availability: Record<string, AvailabilityDay[] | null>;
  openingHours: OpeningHoursView | null;
  company: CompanyFooterView | null;
  legalMeta: { ordinal: number; publishedAt: string } | null;
  event: EventFacts | null;
  utm: UtmParams;
  /** `?page=n` of paginated lists. */
  listPage: number;
  jsonLd: object[];
};

type SearchParams = Record<string, string | string[] | undefined> | undefined;

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/** UTM parameters of the request (`utm_source` ... `utm_content`), passed to forms (rule 40). */
export function utmFrom(searchParams: SearchParams): UtmParams {
  const out: UtmParams = {};
  for (const key of ["source", "medium", "campaign", "term", "content"] as const) {
    const v = first(searchParams?.[`utm_${key}`]);
    if (v && v.length <= 200) out[key] = v;
  }
  return out;
}

async function safe<T>(step: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (error) {
    reportError(error, { tags: { module: "site", step } });
    return null;
  }
}

/** Media ids referenced by blocks (and the cover). */
export function blockMediaIds(blocks: readonly Block[]): string[] {
  const ids: string[] = [];
  for (const b of blocks) {
    if ((b.type === "hero" && b.mediaId) || b.type === "image" || b.type === "image_text" || b.type === "map") ids.push(b.mediaId!);
    if (b.type === "video") ids.push(b.posterMediaId);
    if (b.type === "card_grid") for (const c of b.cards) if (c.mediaId) ids.push(c.mediaId);
  }
  return ids;
}

/** Page ids referenced by block links. */
export function blockPageIds(blocks: readonly Block[]): string[] {
  const ids: string[] = [];
  const add = (link: { kind: string; pageId?: string } | undefined) => {
    if (link?.kind === "page" && link.pageId) ids.push(link.pageId);
  };
  for (const b of blocks) {
    if (b.type === "hero") add(b.cta?.link);
    if (b.type === "cta") add(b.button.link);
    if (b.type === "card_grid") for (const c of b.cards) add(c.link);
  }
  return ids;
}

/** An empty `RenderData` (tests and pages without dynamic blocks). */
export function emptyRenderData(locale: Locale, pagePath: string): RenderData {
  return { locale, pagePath, media: {}, hrefs: {}, skus: {}, pricing: {}, events: {}, posts: {}, availability: {}, openingHours: null, company: null, legalMeta: null, event: null, utm: {}, listPage: 1, jsonLd: [] };
}

/** Loads the data of every block of `page` in its locale. */
export async function loadRenderData(page: ResolvedPage, searchParams?: SearchParams): Promise<RenderData> {
  const locale = page.locale;
  const blocks = page.blocks;
  const pagePath = localePath(locale, page.path);
  const pageNo = Math.max(1, Math.min(1000, Number.parseInt(first(searchParams?.page) ?? "1", 10) || 1));
  const data = emptyRenderData(locale, pagePath);
  data.utm = utmFrom(searchParams);
  data.listPage = pageNo;

  const db = await getAppDb();
  const buyIds = blocks.flatMap((b) => (b.type === "booking_cta" && b.target.kind === "buy_product" ? [b.target.productId] : []));
  const tasks: Promise<unknown>[] = [
    safe("hrefs", () => pageHrefs(db, blockPageIds(blocks), locale)).then((v) => void (data.hrefs = v ?? {})),
    safe("skus", () => getProductSkus(buyIds)).then((v) => void (data.skus = v ?? {})),
  ];
  for (const b of blocks) {
    if (b.type === "pricing_table") tasks.push(safe("pricing", () => getPricingRows(b.productIds, locale)).then((v) => void (data.pricing[b.id] = v)));
    if (b.type === "events_list") tasks.push(safe("events", () => listPublicEventsForSite(locale, { page: pageNo, limit: b.limit, showFull: b.showFull })).then((v) => void (data.events[b.id] = v)));
    if (b.type === "posts_list") tasks.push(safe("posts", () => listPosts(locale, { page: b.paginate ? pageNo : 1, limit: b.limit })).then((v) => void (data.posts[b.id] = v)));
    if (b.type === "availability_preview") tasks.push(safe("availability", () => getAvailabilityPreviewForSite(b.kind, b.days)).then((v) => void (data.availability[b.id] = v)));
  }
  const needsHours = page.kind === "home" || blocks.some((b) => b.type === "contact_details" && b.showOpeningHours);
  if (needsHours) tasks.push(safe("opening_hours", () => getOpeningHours(locale)).then((v) => void (data.openingHours = v)));
  if (page.kind === "home" || blocks.some((b) => b.type === "contact_details")) tasks.push(safe("company", () => getCompanyFooter(locale)).then((v) => void (data.company = v)));
  if (blocks.some((b) => b.type === "legal_meta")) tasks.push(safe("legal_meta", () => getLegalMeta(page.versionId)).then((v) => void (data.legalMeta = v)));
  if (page.kind === "event" && page.sessionId) tasks.push(safe("event", () => getEventFacts(page.sessionId!, locale)).then((v) => void (data.event = v)));
  await Promise.all(tasks);

  const postCovers = Object.values(data.posts).flatMap((p) => p?.items.map((i) => i.coverMediaId).filter((x): x is string => !!x) ?? []);
  const mediaIds = [...blockMediaIds(blocks), ...(page.coverMediaId ? [page.coverMediaId] : []), ...postCovers];
  data.media = (await safe("media", () => getMediaByIds(mediaIds, locale))) ?? {};
  data.jsonLd = (await safe("json_ld", () => pageJsonLd(page, data))) ?? [];
  return data;
}

/** Breadcrumbs of a nested path: home, every live ancestor, the page. */
async function breadcrumbs(page: ResolvedPage, origin: string, homeLabel: string): Promise<BreadcrumbFacts> {
  const segments = page.path.split("/").filter(Boolean);
  if (segments.length < 2) return [];
  const crumbs: BreadcrumbFacts = [{ name: homeLabel, url: absoluteUrl(origin, localePath(page.locale, "")) }];
  for (let i = 1; i < segments.length; i++) {
    const path = segments.slice(0, i).join("/");
    const parent = await getPageByPath(page.locale, path);
    if (parent) crumbs.push({ name: parent.title, url: absoluteUrl(origin, localePath(page.locale, path)) });
  }
  crumbs.push({ name: page.title, url: absoluteUrl(origin, localePath(page.locale, page.path)) });
  return crumbs;
}

/** JSON-LD of a page (section 5): business on home, Event, BlogPosting, FAQPage, BreadcrumbList. */
export async function pageJsonLd(page: ResolvedPage, data: RenderData, homeLabel = "Home"): Promise<object[]> {
  const { site, company } = await getPublicSettings();
  const origin = site.canonical_origin.replace(/\/+$/, "");
  const url = absoluteUrl(origin, data.pagePath);
  const name = company.trade_name ?? company.legal_name ?? "BEAM";
  const image = page.coverMediaId && data.media[page.coverMediaId] ? absoluteUrl(origin, data.media[page.coverMediaId]!.url) : null;
  const facts: JsonLdFacts = { locale: page.locale };
  if (page.kind === "home") {
    facts.business = {
      name,
      legalName: company.legal_name,
      vatId: company.vat_number,
      url,
      telephone: company.phone || null,
      email: company.support_email || null,
      address: company.address ?? null,
      sameAs: Object.values(site.social_links).filter((v): v is string => !!v),
      weeklyHours: data.openingHours?.weekly
        ? Object.fromEntries(data.openingHours.weekly.map((d) => [String(d.weekday), d.opensAt && d.closesAt ? { opens_at: d.opensAt, closes_at: d.closesAt } : null]))
        : null,
      specialHours: data.openingHours?.exceptions.map((e) => ({ onDate: e.onDate, opensAt: e.opensAt, closesAt: e.closesAt, name: e.name })) ?? [],
    };
  }
  if (page.kind === "event" && data.event) {
    const e = data.event;
    facts.event = {
      name: page.title || e.title,
      description: page.excerpt,
      url,
      startsAt: new Date(e.startsAt),
      endsAt: new Date(e.endsAt),
      status: e.status,
      location: e.location,
      image,
      organizer: { name, url: origin },
      offer: e.priceCents !== null && e.band ? { priceCents: e.priceCents, band: e.band } : null,
    };
  }
  if (page.kind === "post") {
    facts.post = {
      headline: page.title,
      description: page.excerpt,
      url,
      datePublished: new Date(page.firstPublishedAt ?? page.publishedAt ?? Date.now()),
      dateModified: page.publishedAt ? new Date(page.publishedAt) : null,
      image,
      publisher: { name },
    };
  }
  const faq = page.blocks.flatMap((b) => (b.type === "faq" ? b.items.map((i) => ({ question: i.question, answer: richDocToPlainText(i.answer) })) : []));
  if (faq.length) facts.faq = faq;
  const crumbs = await breadcrumbs(page, origin, homeLabel);
  if (crumbs.length) facts.breadcrumbs = crumbs;
  return buildJsonLd(page.kind, facts);
}
