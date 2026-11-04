/**
 * `events_list` block (rules 28, 30, 32): upcoming events from `booking.listPublicEvents` with
 * their seat band (never a count), a "Members only" badge, a link to the event page (or the
 * portal booking page) and paging with `?page=n`.
 */
import { formatDate, formatTime } from "@beam/core/i18n";
import type { AvailabilityBand } from "@beam/core/site";
import type { BlockContext, BlockOf, Tr } from "../block-renderer";

export function bandLabel(band: AvailabilityBand, tr: Tr): string {
  return band === "full" ? tr("site.blocks.events.full") : band === "few" ? tr("site.blocks.events.fewLeft") : tr("site.blocks.events.available");
}

export function EventsListBlockView({ block, ctx }: { block: BlockOf<"events_list">; ctx: BlockContext }) {
  const { tr, locale } = ctx;
  const list = ctx.data.events[block.id];
  const items = list?.items ?? [];
  const page = list?.page ?? 1;
  return (
    <div className="space-y-6">
      {block.heading ? <h2 className="text-2xl font-semibold">{block.heading}</h2> : null}
      {items.length === 0 ? (
        <p className="text-muted-foreground">{tr("site.blocks.events.empty")}</p>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border">
          {items.map((e) => (
            <li key={e.sessionId} className="flex flex-col gap-2 p-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="space-y-1">
                <h3 className="text-lg font-semibold">
                  <a href={e.href} className="hover:underline">
                    {e.title}
                  </a>
                </h3>
                <p className="text-sm text-muted-foreground">
                  <time dateTime={e.startsAt}>
                    {formatDate(e.startsAt, locale, "full")}, {formatTime(e.startsAt, locale)}
                  </time>
                  {e.location ? <span> · {e.location}</span> : null}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                {e.isMemberOnly ? <span className="rounded-full bg-muted px-2.5 py-0.5 font-medium">{tr("site.blocks.events.membersOnly")}</span> : null}
                <span data-band={e.band} className="rounded-full border border-border px-2.5 py-0.5">
                  {bandLabel(e.band, tr)}
                </span>
              </div>
            </li>
          ))}
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
