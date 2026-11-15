/**
 * `events_list` block (rules 28, 30, 32): upcoming events from `booking.listPublicEvents` with
 * their seat band (never a count), a "Members only" badge, a link to the event page (or the
 * portal booking page) and paging with `?page=n`. R2 (scenario 3): a Lead Magnet event in its
 * lead window shows "Priority access for new guests until <date>" (Europe/Brussels), never a
 * count or a rank.
 */
import { formatDate, formatDateTime, formatTime } from "@beam/core/i18n";
import type { AvailabilityBand } from "@beam/core/site";
import type { Locale } from "@beam/core/i18n";
import { goldButtonClass, secondaryButtonClass, sectionHeadingClass, type BlockContext, type BlockOf, type Tr } from "../block-renderer";

/** One part of an instant in Europe/Brussels (month, day or weekday) for the calendar tile. */
const dateBit = (iso: string, locale: Locale, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, { timeZone: "Europe/Brussels", ...opts }).format(new Date(iso));

export function bandLabel(band: AvailabilityBand, tr: Tr): string {
  return band === "full" ? tr("site.blocks.events.full") : band === "few" ? tr("site.blocks.events.fewLeft") : tr("site.blocks.events.available");
}

export function EventsListBlockView({ block, ctx }: { block: BlockOf<"events_list">; ctx: BlockContext }) {
  const { tr, locale } = ctx;
  const list = ctx.data.events[block.id];
  const items = list?.items ?? [];
  const page = list?.page ?? 1;
  return (
    <div className="space-y-8">
      {block.heading ? <h2 className={sectionHeadingClass}>{block.heading}</h2> : null}
      {items.length === 0 ? (
        <p className="text-muted-foreground">{tr("site.blocks.events.empty")}</p>
      ) : (
        <ul className="space-y-3">
          {items.map((e) => {
            const full = e.band === "full";
            return (
              <li key={e.sessionId} className="group relative flex flex-col gap-5 rounded-[1.75rem] border border-border bg-card p-4 transition hover:-translate-y-0.5 hover:shadow-md sm:flex-row sm:items-center sm:p-5">
                <time dateTime={e.startsAt} className="flex w-20 shrink-0 flex-col overflow-hidden rounded-2xl border border-border text-center shadow-sm" aria-hidden="true">
                  <span className="bg-[#212842] py-1 text-[0.7rem] font-semibold tracking-[0.2em] text-[#ffd76a] uppercase">{dateBit(e.startsAt, locale, { month: "short" })}</span>
                  <span className="font-display bg-[#fffaef] pt-1 text-4xl leading-none">{dateBit(e.startsAt, locale, { day: "numeric" })}</span>
                  <span className="bg-[#fffaef] pb-2 text-[0.7rem] text-muted-foreground uppercase">{dateBit(e.startsAt, locale, { weekday: "short" })}</span>
                </time>
                <div className="min-w-0 flex-1 space-y-1">
                  <h3 className="text-lg font-semibold sm:text-xl">
                    <a href={e.href} className="after:absolute after:inset-0 focus-visible:outline-2 focus-visible:outline-ring">
                      {e.title}
                    </a>
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    <span className="sr-only">{formatDate(e.startsAt, locale, "full")}, </span>
                    {formatTime(e.startsAt, locale)}
                    {e.location ? <span> · {e.location}</span> : null}
                    {e.band === "few" ? <span className="font-medium text-[#a0621e]"> · {bandLabel(e.band, tr)}</span> : null}
                  </p>
                  {e.priorityUntil ? (
                    <p className="text-sm" data-lead-window>
                      {tr("site.blocks.events.priorityUntil", { date: formatDateTime(e.priorityUntil, locale, "long") })}
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  {e.isMemberOnly ? <span className="rounded-full bg-[#f4ead3] px-3 py-1 font-medium">{tr("site.blocks.events.membersOnly")}</span> : null}
                  <span data-band={e.band} className={full ? `${secondaryButtonClass} py-2` : `${goldButtonClass} py-2`}>
                    {full ? tr("site.blocks.events.joinWaitlist") : tr("site.blocks.events.register")}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {page > 1 || list?.hasMore ? (
        <nav className="flex justify-between text-sm" aria-label={block.heading ?? tr("site.blocks.events.more")}>
          {page > 1 ? <a href={`${ctx.data.pagePath}?page=${page - 1}`}>{tr("site.blocks.posts.newer")}</a> : <span />}
          {list?.hasMore ? <a href={`${ctx.data.pagePath}?page=${page + 1}`}>{tr("site.blocks.events.more")}</a> : null}
        </nav>
      ) : null}
    </div>
  );
}
