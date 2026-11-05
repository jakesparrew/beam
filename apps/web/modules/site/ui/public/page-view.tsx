/**
 * One public page (site-P2): the single `h1` (the version title unless the first block is a
 * hero, rule 18), the event facts of an event page (`EventFactsView` of `./event-facts`: date,
 * place, price, band, ticket types, the lead window, "Get tickets", "Join the waitlist", "Check
 * your access" or the webinar link, the past and cancelled banners of rule 29), the cover and date
 * of a post, the blocks, the JSON-LD and the alternates the locale switch reads.
 */
import { LOCALES, formatDate, type Locale } from "@beam/core/i18n";
import { localePath, prefixFromLocale } from "@beam/core/site";
import type { ResolvedPage } from "../../queries/public";
import type { RenderData } from "../../server/render-data";
import { BlockRenderer, heroIsH1, type Tr } from "./block-renderer";
import { EventFactsView } from "./event-facts";
import { JsonLd } from "./json-ld";
import { MediaImage } from "./media-image";

/** Where the locale switch sends a visitor of this page: its route there, or `unavailable`. */
export function pageAlternates(page: Pick<ResolvedPage, "pageId" | "routes">): Record<Locale, string> {
  const out = {} as Record<Locale, string>;
  for (const l of LOCALES) {
    const path = page.routes[l];
    out[l] = path !== undefined ? localePath(l, path) : `/${prefixFromLocale(l)}/unavailable?page=${page.pageId}`;
  }
  return out;
}

export function PageView({ page, data, tr, now = new Date() }: { page: ResolvedPage; data: RenderData; tr: Tr; now?: Date }) {
  const locale = page.locale;
  const cover = page.coverMediaId ? data.media[page.coverMediaId] : undefined;
  return (
    <article data-page={page.slug} data-kind={page.kind} className="pb-12">
      {heroIsH1(page.blocks) ? null : (
        <header className="mx-auto w-full max-w-5xl space-y-3 px-4 pt-10 pb-4 sm:px-6">
          <h1 className="text-4xl font-bold tracking-tight">{page.title}</h1>
          {page.kind === "post" && (page.firstPublishedAt ?? page.publishedAt) ? (
            <time dateTime={page.firstPublishedAt ?? page.publishedAt!} className="block text-sm text-muted-foreground">
              {formatDate(page.firstPublishedAt ?? page.publishedAt!, locale, "long")}
            </time>
          ) : null}
        </header>
      )}
      {page.kind === "event" ? <EventFactsView facts={data.event} tr={tr} locale={locale} now={now} /> : null}
      {cover && (page.kind === "post" || page.kind === "event") ? (
        <div className="mx-auto w-full max-w-5xl px-4 py-4 sm:px-6">
          <MediaImage media={cover} priority />
        </div>
      ) : null}
      <BlockRenderer blocks={page.blocks} ctx={{ locale, tr, data }} />
      <JsonLd items={data.jsonLd} />
      <div hidden data-beam-alternates={JSON.stringify(pageAlternates(page))} />
    </article>
  );
}
