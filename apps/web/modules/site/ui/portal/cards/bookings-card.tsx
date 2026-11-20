/**
 * Account home card "Your upcoming visits" (site rule 47, section 5; site-P6): the next five
 * bookings of the person and the guest bookings the person made, with date and time, a guest
 * marker and a link to booking's detail page. Empty: "No upcoming bookings" with a Book button.
 * A failing booking api shows "Temporarily unavailable" on this card only (rule 48).
 */
import Link from "next/link";
import type { Route } from "next";
import type { Locale, MessageParams } from "@beam/core/i18n";
import { portalPath } from "@beam/core/site";
import { Badge, buttonVariants, Card, CardContent, CardHeader } from "@beam/ui";
import type { PortalBookingRow, Result } from "../../../queries/portal";

export type Tr = (key: string, params?: MessageParams) => string;

/** One part of a date in Brussels time ("nov", "28", "zaterdag", "09:00"). */
const part = (d: Date, locale: Locale, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, { timeZone: "Europe/Brussels", ...opts }).format(d);

/** The "Temporarily unavailable" line of a card whose module api failed. */
export function CardUnavailable({ tr }: { tr: Tr }) {
  return (
    <p className="text-sm text-muted-foreground" data-card-unavailable>
      {tr("site.portal.home.unavailableCard")}
    </p>
  );
}

export function BookingsCard({ locale, bookings, tr }: { locale: Locale; bookings: Result<PortalBookingRow[]>; tr: Tr }) {
  const bookingsPath = portalPath(locale, "bookings");
  return (
    <Card data-home-card="bookings" role="region" aria-labelledby="home-bookings-title">
      <CardHeader>
        <h2 id="home-bookings-title" className="font-display text-2xl">
          {tr("site.portal.home.upcoming")}
        </h2>
      </CardHeader>
      <CardContent>
        {!bookings.ok ? (
          <CardUnavailable tr={tr} />
        ) : bookings.data.length === 0 ? (
          <div className="flex flex-col items-start gap-3">
            <p className="text-sm text-muted-foreground">{tr("site.portal.home.noBookings")}</p>
            <Link href={portalPath(locale, "book_day") as Route} className={buttonVariants({ size: "sm" })}>
              {tr("site.portal.home.bookFirst")}
            </Link>
          </div>
        ) : (
          <ul className="grid gap-2">
            {bookings.data.map((b) => (
              <li key={b.bookingId} data-booking-id={b.bookingId}>
                <Link
                  href={`${bookingsPath}/${b.bookingId}` as Route}
                  className="group flex items-center gap-4 rounded-2xl p-2 transition hover:bg-[#f6efdf]"
                >
                  <span className="grid w-14 shrink-0 place-items-center rounded-xl bg-[#212842] py-2 text-[#fffaef]">
                    <span className="text-[0.6rem] font-semibold tracking-widest text-[#e8c26a] uppercase">{part(b.startsAt, locale, { month: "short" })}</span>
                    <span className="text-xl leading-none font-semibold">{part(b.startsAt, locale, { day: "numeric" })}</span>
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{b.title[locale] ?? ""}</span>
                    <span className="block text-sm text-muted-foreground first-letter:uppercase">
                      <time dateTime={b.startsAt.toISOString()}>
                        {part(b.startsAt, locale, { weekday: "long" })} · {part(b.startsAt, locale, { hour: "2-digit", minute: "2-digit" })}
                      </time>
                    </span>
                  </span>
                  {b.isGuest ? (
                    <Badge variant="secondary" data-guest-marker>
                      {tr("site.portal.home.guest")}
                      {b.guestFirstName ? `: ${b.guestFirstName}` : ""}
                    </Badge>
                  ) : null}
                  <span aria-hidden="true" className="text-muted-foreground transition group-hover:translate-x-0.5">
                    →
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
