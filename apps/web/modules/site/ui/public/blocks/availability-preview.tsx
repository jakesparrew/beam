/**
 * `availability_preview` block (rule 30): the bands of `booking.getAvailabilityPreview` for the
 * next days, never a number, with a Book link into the portal (rule 31).
 */
import { formatDate, formatTime } from "@beam/core/i18n";
import { portalUrl } from "../../../server/urls";
import { buttonClass, type BlockContext, type BlockOf } from "../block-renderer";
import { bandLabel } from "./events-list";

export function AvailabilityPreviewBlockView({ block, ctx }: { block: BlockOf<"availability_preview">; ctx: BlockContext }) {
  const { tr, locale } = ctx;
  const days = ctx.data.availability[block.id] ?? [];
  const bookHref = portalUrl(locale, block.kind === "night" ? "book_night" : "book_day");
  return (
    <div className="space-y-4">
      <h2 className="text-2xl font-semibold">{tr("site.blocks.availability.title")}</h2>
      {days.length === 0 ? (
        <p className="text-muted-foreground">{tr("site.blocks.availability.none")}</p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {days.map((d) => (
            <li key={d.sessionId} className="flex items-center justify-between rounded-lg border border-border p-3 text-sm">
              <time dateTime={d.startsAt}>
                {formatDate(d.startsAt, locale, "medium")} {formatTime(d.startsAt, locale)}
              </time>
              <span data-band={d.band} className="font-medium">
                {bandLabel(d.band, tr)}
              </span>
            </li>
          ))}
        </ul>
      )}
      <a href={bookHref} className={buttonClass}>
        {tr("site.blocks.availability.book")}
      </a>
    </div>
  );
}
