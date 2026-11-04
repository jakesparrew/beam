import type { Metadata } from "next";
import { notFound, permanentRedirect, redirect } from "next/navigation";
import { cache } from "react";
import { localeFromSegment, type Locale } from "@beam/core/i18n";
import { translator } from "@/lib/i18n";
import { reportError } from "@/lib/logger";
import { getEventFacts, getMediaByIds, getPublicSettings } from "@/modules/site/queries";
import { buildPageMetadata, noindexMetadata } from "@/modules/site/server/metadata";
import { loadRenderData } from "@/modules/site/server/render-data";
import { markGone, resolveRequest } from "@/modules/site/server/resolve";
import { absoluteUrl } from "@/modules/site/server/urls";
import { PageView } from "@/modules/site/ui/public/page-view";

/**
 * Every public page (site-P2): the resolver decides between the live page, a redirect (308
 * permanent, 307 otherwise), 404 and gone; metadata comes from `seo[locale]` with canonical,
 * hreflang for each live locale and `x-default`.
 */
export const revalidate = 3600;

type SearchParams = Record<string, string | string[] | undefined>;
type Props = { params: Promise<{ locale: string; path?: string[] }>; searchParams: Promise<SearchParams> };

const WP_PARAMS = ["p", "page_id"] as const;

/** One resolver run per request, shared by `generateMetadata` and the page. */
const resolveOnce = cache((locale: Locale, path: string, wpQuery: string) => resolveRequest(locale, path ? path.split("/") : [], new URLSearchParams(wpQuery)));

async function resolveFromProps(props: Props) {
  const [{ locale: segment, path }, searchParams] = await Promise.all([props.params, props.searchParams]);
  const locale = localeFromSegment(segment);
  if (!locale) notFound();
  const wp = new URLSearchParams();
  for (const k of WP_PARAMS) {
    const v = searchParams[k];
    const value = Array.isArray(v) ? v[0] : v;
    if (value) wp.set(k, value);
  }
  const result = await resolveOnce(locale, (path ?? []).join("/"), wp.toString());
  return { locale, result, searchParams };
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  const { locale, result } = await resolveFromProps(props);
  const tr = translator(locale);
  if (result.kind === "gone") return noindexMetadata(tr("site.public.gone.title"));
  if (result.kind !== "page") return noindexMetadata(tr("site.public.notFound.title"));
  const page = result.page;
  try {
    const { site, company } = await getPublicSettings();
    const origin = site.canonical_origin.replace(/\/+$/, "");
    const event = page.kind === "event" && page.sessionId ? await getEventFacts(page.sessionId, locale).catch(() => null) : null;
    const ogId = page.seo?.ogImageMediaId ?? page.coverMediaId ?? site.default_og_image_media_id;
    const og = ogId ? (await getMediaByIds([ogId], locale))[ogId] : undefined;
    return buildPageMetadata(page, locale, { origin, event, ogImageUrl: og ? absoluteUrl(origin, og.url) : null, siteName: company.trade_name ?? null });
  } catch (error) {
    reportError(error, { tags: { module: "site", step: "metadata" } });
    return { title: page.seo?.title || page.title };
  }
}

export default async function SitePage(props: Props) {
  const { locale, result, searchParams } = await resolveFromProps(props);
  switch (result.kind) {
    case "redirect":
      if (result.permanent) permanentRedirect(result.to as never);
      redirect(result.to as never);
    case "gone":
      markGone();
      notFound();
    case "not_found":
      notFound();
    case "page": {
      const data = await loadRenderData(result.page, searchParams);
      return <PageView page={result.page} data={data} tr={translator(locale)} />;
    }
  }
}
