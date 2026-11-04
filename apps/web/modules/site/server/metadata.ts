/**
 * Per-page metadata (site spec section 4 route table, rule 29, edge case 30; site-P2):
 * title and description from `seo[locale]`, canonical, hreflang for every live locale plus
 * `x-default` (nl-BE, else the first live locale), Open Graph, and `noindex` for pages marked
 * noindex, legal `guardian_consent`, cancelled events, events 30 days after `ends_at` and every
 * page outside production.
 */
import type { Metadata } from "next";
import { LOCALES, type Locale } from "@beam/core/i18n";
import { defaultHreflangLocale, localePath, type PageKind, type PageSeo } from "@beam/core/site";
import { absoluteUrl } from "./urls";

/** Days after an event's end before its page gets `noindex` (rule 29). */
export const PAST_EVENT_NOINDEX_DAYS = 30;

export type MetadataPage = {
  kind: PageKind;
  legalKey?: string | null;
  title: string;
  seo: PageSeo | null;
  excerpt?: string | null;
  /** Live path per locale (`''` = home). */
  routes: Partial<Record<Locale, string>>;
  isPreview?: boolean;
};

export type MetadataContext = {
  /** `settings.site.canonical_origin`. */
  origin: string;
  /** Defaults to `VERCEL_ENV === 'production'`. */
  isProduction?: boolean;
  now?: Date;
  /** The event session of an event page. */
  event?: { endsAt: string | Date; status: string } | null;
  /** Absolute URL of the OG image (the page's or the site default). */
  ogImageUrl?: string | null;
  siteName?: string | null;
};

/** Whether a page must not be indexed. */
export function isNoindex(page: MetadataPage, ctx: Pick<MetadataContext, "isProduction" | "now" | "event">): boolean {
  const production = ctx.isProduction ?? process.env.VERCEL_ENV === "production";
  if (!production || page.isPreview) return true;
  if (page.seo?.noindex) return true;
  if (page.kind === "legal" && page.legalKey === "guardian_consent") return true;
  if (page.kind === "event" && ctx.event) {
    if (ctx.event.status === "cancelled") return true;
    const end = new Date(ctx.event.endsAt).getTime();
    const now = (ctx.now ?? new Date()).getTime();
    if (now - end > PAST_EVENT_NOINDEX_DAYS * 86_400_000) return true;
  }
  return false;
}

/** The Next.js `Metadata` of a public page in `locale`. */
export function buildPageMetadata(page: MetadataPage, locale: Locale, ctx: MetadataContext): Metadata {
  const url = (l: Locale) => absoluteUrl(ctx.origin, localePath(l, page.routes[l] ?? ""));
  const live = LOCALES.filter((l) => page.routes[l] !== undefined);
  const languages: Record<string, string> = {};
  for (const l of live) languages[l] = url(l);
  const xDefault = defaultHreflangLocale(live);
  if (xDefault) languages["x-default"] = url(xDefault);
  const title = page.seo?.title?.trim() || page.title;
  const description = page.seo?.description?.trim() || page.excerpt || undefined;
  const canonical = page.routes[locale] !== undefined ? url(locale) : undefined;
  const noindex = isNoindex(page, ctx);
  return {
    title,
    description,
    alternates: { canonical, languages },
    robots: noindex ? { index: false, follow: false } : { index: true, follow: true },
    openGraph: {
      type: page.kind === "post" ? "article" : "website",
      title,
      description,
      url: canonical,
      locale: locale.replace("-", "_"),
      siteName: ctx.siteName ?? undefined,
      images: ctx.ogImageUrl ? [{ url: ctx.ogImageUrl }] : undefined,
    },
  };
}

/** Metadata of system pages (unavailable, preview, 404, 410): never indexed. */
export function noindexMetadata(title: string): Metadata {
  return { title, robots: { index: false, follow: false } };
}
