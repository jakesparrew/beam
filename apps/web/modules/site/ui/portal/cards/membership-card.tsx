/**
 * Account home card "Your membership" (site rule 47, section 5; site-P6), from
 * `credits.getMembershipSummary()`: plan, status, current period end, the included credits left
 * and a "Renew" link while the renewal payment is overdue (`past_due`). Without a membership the
 * card is not shown; a failing credits api shows "Temporarily unavailable" (rule 48).
 */
import Link from "next/link";
import type { Route } from "next";
import { formatDate, type Locale } from "@beam/core/i18n";
import { portalPath } from "@beam/core/site";
import { buttonVariants, Card, CardContent, CardHeader } from "@beam/ui";
import type { MembershipSummary, Result } from "../../../queries/portal";
import { remainingText } from "./balance-card";
import { CardUnavailable, type Tr } from "./bookings-card";

export function MembershipCard({ locale, membership, tr }: { locale: Locale; membership: Result<MembershipSummary | null>; tr: Tr }) {
  if (membership.ok && !membership.data) return null;
  const m = membership.ok ? membership.data : null;
  return (
    <Card data-home-card="membership" role="region" aria-labelledby="home-membership-title">
      <CardHeader>
        <h2 id="home-membership-title" className="text-lg font-semibold">
          {tr("site.portal.home.membership")}
        </h2>
      </CardHeader>
      <CardContent>
        {!m ? (
          <CardUnavailable tr={tr} />
        ) : (
          <div className="grid gap-2" data-membership-status={m.status}>
            <p className="font-medium">{m.productName[locale] ?? ""}</p>
            {m.status === "past_due" ? (
              <div className="flex flex-col items-start gap-2">
                <p className="text-sm text-destructive">{tr("site.portal.home.membershipPastDue")}</p>
                <Link href={portalPath(locale, "membership") as Route} className={buttonVariants({ size: "sm" })}>
                  {tr("site.portal.home.renew")}
                </Link>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{tr("site.portal.home.membershipActive", { date: formatDate(m.currentPeriodEndAt, locale) })}</p>
            )}
            {m.includedCredits.length > 0 ? (
              <ul className="grid gap-1 text-sm">
                {m.includedCredits.map((c) => (
                  <li key={c.kind}>{remainingText(tr, locale, c)}</li>
                ))}
              </ul>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
