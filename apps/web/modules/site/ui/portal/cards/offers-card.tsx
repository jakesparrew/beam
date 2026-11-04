/**
 * Account home card "A place is free for you" (site rule 47, section 5; site-P6): the person's
 * open waitlist offers with their expiry ("Claim before 14:30") and a Claim button that opens
 * booking's waitlist page, where the offer is claimed. Hidden without offers; a failing booking
 * api shows "Temporarily unavailable" on this card only (rule 48).
 */
import Link from "next/link";
import type { Route } from "next";
import { formatDateTime, formatTime, type Locale } from "@beam/core/i18n";
import { portalPath } from "@beam/core/site";
import { buttonVariants, Card, CardContent, CardHeader } from "@beam/ui";
import type { Result, WaitlistOffer } from "../../../queries/portal";
import { CardUnavailable, type Tr } from "./bookings-card";

export function OffersCard({ locale, offers, tr }: { locale: Locale; offers: Result<WaitlistOffer[]>; tr: Tr }) {
  if (offers.ok && offers.data.length === 0) return null;
  return (
    <Card data-home-card="offers" role="region" aria-labelledby="home-offers-title" className="border-primary">
      <CardHeader>
        <h2 id="home-offers-title" className="text-lg font-semibold">
          {tr("site.portal.home.offers")}
        </h2>
      </CardHeader>
      <CardContent>
        {!offers.ok ? (
          <CardUnavailable tr={tr} />
        ) : (
          <ul className="divide-y">
            {offers.data.map((o) => (
              <li key={o.entryId} className="flex flex-wrap items-center justify-between gap-2 py-3" data-offer-id={o.entryId}>
                <div className="min-w-0">
                  <p className="font-medium">{o.title[locale] ?? ""}</p>
                  <p className="text-sm text-muted-foreground">
                    <time dateTime={o.startsAt.toISOString()}>{formatDateTime(o.startsAt, locale)}</time>
                  </p>
                  <p className="text-sm">
                    <time dateTime={o.offerExpiresAt.toISOString()}>{tr("site.portal.home.offerExpires", { time: formatTime(o.offerExpiresAt, locale) })}</time>
                  </p>
                </div>
                <Link href={portalPath(locale, "waitlist") as Route} className={buttonVariants({ size: "sm" })}>
                  {tr("site.portal.home.claim")}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
