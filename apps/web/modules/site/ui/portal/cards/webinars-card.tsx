/**
 * Account home card "Your upcoming webinars" (site rule 47, R2; site-P8): the person's upcoming
 * webinar registrations from `webinar.listUpcomingRegistrationsForPerson` with their start in
 * Brussels time (or "On demand") and a link to webinar's portal page `/[locale]/account/webinars`.
 * Not rendered while `ff_webinar_portal` is off for the person (no `webinars` result) or when there
 * is no upcoming registration; a failing webinar api shows "Temporarily unavailable" on this card
 * only (rule 48).
 */
import Link from "next/link";
import type { Route } from "next";
import { formatDateTime, LOCALES, type Locale } from "@beam/core/i18n";
import { prefixFromLocale } from "@beam/core/site";
import { Card, CardContent, CardHeader } from "@beam/ui";
import type { PortalWebinarRow, Result } from "../../../queries/portal";
import { CardUnavailable, type Tr } from "./bookings-card";

/** Webinar's portal page of the person's registrations. */
export function accountWebinarsPath(locale: Locale): string {
  return `/${prefixFromLocale(locale)}/account/webinars`;
}

function titleOf(title: PortalWebinarRow["title"], locale: Locale): string {
  const own = title[locale]?.trim();
  if (own) return own;
  for (const l of LOCALES) {
    const text = title[l]?.trim();
    if (text) return text;
  }
  return "";
}

export function WebinarsCard({ locale, webinars, tr }: { locale: Locale; webinars: Result<PortalWebinarRow[]> | undefined; tr: Tr }) {
  if (!webinars) return null;
  if (webinars.ok && webinars.data.length === 0) return null;
  const href = accountWebinarsPath(locale) as Route;
  return (
    <Card data-home-card="webinars" role="region" aria-labelledby="home-webinars-title">
      <CardHeader>
        <h2 id="home-webinars-title" className="text-lg font-semibold">
          {tr("site.portal.home.webinars")}
        </h2>
      </CardHeader>
      <CardContent className="grid gap-3">
        {!webinars.ok ? (
          <CardUnavailable tr={tr} />
        ) : (
          <ul className="divide-y">
            {webinars.data.map((w) => (
              <li key={w.webinarId} className="py-3" data-webinar-id={w.webinarId}>
                <p className="font-medium">{titleOf(w.title, locale)}</p>
                <p className="text-sm text-muted-foreground">
                  {w.startsAt ? (
                    <time dateTime={w.startsAt.toISOString()}>{tr("site.portal.home.webinarLive", { date: formatDateTime(w.startsAt, locale, "long") })}</time>
                  ) : (
                    tr("site.portal.home.webinarOnDemand")
                  )}
                </p>
              </li>
            ))}
          </ul>
        )}
        <Link href={href} className="text-sm font-medium underline underline-offset-4">
          {tr("site.portal.home.webinarsAll")}
        </Link>
      </CardContent>
    </Card>
  );
}
