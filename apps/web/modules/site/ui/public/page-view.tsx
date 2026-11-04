/**
 * One public page (site-P2): the single `h1` (the version title unless the first block is a
 * hero, rule 18), the event facts of an event page (date, place, price, band, "Get tickets" or
 * "Join the waitlist", the past and cancelled banners of rule 29), the cover and date of a post,
 * the blocks, the JSON-LD and the alternates the locale switch reads.
 */
import { LOCALES, formatDate, formatMoney, formatTime, type Locale } from "@beam/core/i18n";
import { localePath, prefixFromLocale } from "@beam/core/site";
import type { ResolvedPage } from "../../queries/public";
import type { RenderData } from "../../server/render-data";
import { BlockRenderer, buttonClass, heroIsH1, type Tr } from "./block-renderer";
import { bandLabel } from "./blocks/events-list";
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

function EventFactsView({ data, tr, locale, now }: { data: RenderData; tr: Tr; locale: Locale; now: Date }) {
  const e = data.event;
  if (!e) return null;
  const past = new Date(e.endsAt).getTime() < now.getTime();
  const cancelled = e.status === "cancelled";
  const full = e.band === "full" || e.status === "closed";
  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 px-4 sm:px-6" data-event={e.sessionId}>
      {cancelled ? (
        <p role="status" className="rounded-lg bg-destructive/10 p-4 font-medium">
          {tr("site.blocks.events.cancelled")}
        </p>
      ) : past ? (
        <p role="status" className="rounded-lg bg-muted p-4 font-medium">
          {tr("site.blocks.events.past")}
        </p>
      ) : null}
      <ul className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
        <li>
          <time dateTime={e.startsAt}>
            {formatDate(e.startsAt, locale, "full")}, {formatTime(e.startsAt, locale)}-{formatTime(e.endsAt, locale)}
          </time>
        </li>
        {e.location ? <li>{e.location}</li> : null}
        {e.priceCents !== null ? <li className="font-semibold">{formatMoney(e.priceCents, locale)}</li> : null}
        {e.band && !past && !cancelled ? <li data-band={e.band}>{bandLabel(e.band, tr)}</li> : null}
        {e.isMemberOnly ? <li className="rounded-full bg-muted px-2.5 py-0.5 font-medium">{tr("site.blocks.events.membersOnly")}</li> : null}
      </ul>
      {!past && !cancelled ? (
        <a href={e.bookHref} className={buttonClass} data-action={full ? "waitlist" : "tickets"}>
          {full ? tr("site.blocks.events.joinWaitlist") : tr("site.blocks.events.getTickets")}
        </a>
      ) : null}
    </div>
  );
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
      {page.kind === "event" ? <EventFactsView data={data} tr={tr} locale={locale} now={now} /> : null}
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
