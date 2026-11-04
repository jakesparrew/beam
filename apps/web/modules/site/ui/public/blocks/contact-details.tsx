/**
 * `contact_details` block (rules 58-60): address, phone and email from `settings.company`, the
 * weekly hours from `settings.business_hours` and, below them, every day of the next 30 days
 * with an exception from `booking.getOpeningHours` ("Closed: <name>" or "<name>: 10:00-16:00").
 * Without business hours the opening-hours part is hidden (rule 59).
 */
import { formatDate } from "@beam/core/i18n";
import type { OpeningHoursView } from "../../../queries/public";
import type { BlockContext, BlockOf, Tr } from "../block-renderer";

export function OpeningHoursList({ hours, tr, locale }: { hours: OpeningHoursView; tr: Tr; locale: BlockContext["locale"] }) {
  if (!hours.weekly) return null;
  return (
    <div className="space-y-3" data-opening-hours>
      <h3 className="font-semibold">{tr("site.blocks.contact.openingHours")}</h3>
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
        {hours.weekly.map((d) => (
          <div key={d.weekday} className="contents">
            <dt>{tr(`site.blocks.contact.weekday.${d.weekday}`)}</dt>
            <dd>{d.opensAt && d.closesAt ? `${d.opensAt}-${d.closesAt}` : tr("site.blocks.contact.closed")}</dd>
          </div>
        ))}
      </dl>
      {hours.note ? <p className="text-sm text-muted-foreground">{hours.note}</p> : null}
      {hours.exceptions.length ? (
        <div className="space-y-1" data-closures>
          <h4 className="text-sm font-semibold">{tr("site.blocks.contact.closures")}</h4>
          <ul className="space-y-1 text-sm">
            {hours.exceptions.map((e) => (
              <li key={e.onDate}>
                <time dateTime={e.onDate}>{formatDate(e.onDate, locale, "full")}</time>:{" "}
                {e.opensAt && e.closesAt
                  ? tr("site.blocks.contact.specialHours", { name: e.name, opens: e.opensAt, closes: e.closesAt })
                  : tr("site.blocks.contact.closedOn", { name: e.name })}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export function ContactDetailsBlockView({ block, ctx }: { block: BlockOf<"contact_details">; ctx: BlockContext }) {
  const { tr, locale } = ctx;
  const c = ctx.data.company;
  const hours = block.showOpeningHours ? ctx.data.openingHours : null;
  return (
    <div className="grid gap-8 md:grid-cols-2">
      <dl className="space-y-3">
        {block.showAddress && c?.addressLines.length ? (
          <div>
            <dt className="font-semibold">{tr("site.blocks.contact.address")}</dt>
            <dd>
              <address className="not-italic">
                {c.legalName ? <span className="block">{c.tradeName ?? c.legalName}</span> : null}
                {c.addressLines.map((l) => (
                  <span key={l} className="block">
                    {l}
                  </span>
                ))}
              </address>
            </dd>
          </div>
        ) : null}
        {block.showPhone && c?.phone ? (
          <div>
            <dt className="font-semibold">{tr("site.blocks.contact.phone")}</dt>
            <dd>
              <a href={`tel:${c.phone.replace(/[^+0-9]/g, "")}`}>{c.phone}</a>
            </dd>
          </div>
        ) : null}
        {block.showEmail && c?.email ? (
          <div>
            <dt className="font-semibold">{tr("site.blocks.contact.email")}</dt>
            <dd>
              <a href={`mailto:${c.email}`}>{c.email}</a>
            </dd>
          </div>
        ) : null}
      </dl>
      {hours ? <OpeningHoursList hours={hours} tr={tr} locale={locale} /> : null}
    </div>
  );
}
