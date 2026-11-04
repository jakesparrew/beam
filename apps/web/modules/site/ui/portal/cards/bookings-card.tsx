/**
 * Account home card "Your upcoming visits" (site rule 47, section 5; site-P6): the next five
 * bookings of the person and the guest bookings the person made, with date and time, a guest
 * marker and a link to booking's detail page. Empty: "No upcoming bookings" with a Book button.
 * A failing booking api shows "Temporarily unavailable" on this card only (rule 48).
 */
import Link from "next/link";
import type { Route } from "next";
import { formatDateTime, type Locale, type MessageParams } from "@beam/core/i18n";
import { portalPath } from "@beam/core/site";
import { Badge, buttonVariants, Card, CardContent, CardHeader } from "@beam/ui";
import type { PortalBookingRow, Result } from "../../../queries/portal";

export type Tr = (key: string, params?: MessageParams) => string;

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
        <h2 id="home-bookings-title" className="text-lg font-semibold">
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
          <ul className="divide-y">
            {bookings.data.map((b) => (
              <li key={b.bookingId} className="flex flex-wrap items-center justify-between gap-2 py-3" data-booking-id={b.bookingId}>
                <div className="min-w-0">
                  <Link href={`${bookingsPath}/${b.bookingId}` as Route} className="font-medium underline-offset-4 hover:underline">
                    {b.title[locale] ?? ""}
                  </Link>
                  <p className="text-sm text-muted-foreground">
                    <time dateTime={b.startsAt.toISOString()}>{formatDateTime(b.startsAt, locale)}</time>
                  </p>
                </div>
                {b.isGuest ? (
                  <Badge variant="secondary" data-guest-marker>
                    {tr("site.portal.home.guest")}
                    {b.guestFirstName ? `: ${b.guestFirstName}` : ""}
                  </Badge>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
