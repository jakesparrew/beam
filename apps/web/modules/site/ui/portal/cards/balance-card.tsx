/**
 * Account home card "Your balance" (site rule 47, section 5; site-P6): the remaining credits per
 * kind from `credits.getPersonCreditSummary().byKind` ("4 day sessions remaining") with the
 * nearest expiry. Empty: "No active package" with a Buy button. A failing credits api shows
 * "Temporarily unavailable" on this card only (rule 48).
 */
import Link from "next/link";
import type { Route } from "next";
import { formatDate, formatMoney, type Locale } from "@beam/core/i18n";
import { portalPath } from "@beam/core/site";
import { buttonVariants, Card, CardContent, CardHeader } from "@beam/ui";
import type { PortalBalanceRow, Result } from "../../../queries/portal";
import { CardUnavailable, type Tr } from "./bookings-card";

/** "4 day sessions remaining"; euro credit as an amount (integer cents). */
export function remainingText(tr: Tr, locale: Locale, row: { kind: string; remainingUnits: number }): string {
  return tr("site.portal.home.remaining", {
    kind: row.kind,
    count: row.remainingUnits,
    amount: row.kind === "euro" ? formatMoney(Math.trunc(row.remainingUnits), locale) : String(row.remainingUnits),
  });
}

export function BalanceCard({ locale, balances, tr }: { locale: Locale; balances: Result<PortalBalanceRow[]>; tr: Tr }) {
  return (
    <Card data-home-card="balance" role="region" aria-labelledby="home-balance-title">
      <CardHeader>
        <h2 id="home-balance-title" className="font-display text-2xl">
          {tr("site.portal.home.balance")}
        </h2>
      </CardHeader>
      <CardContent>
        {!balances.ok ? (
          <CardUnavailable tr={tr} />
        ) : balances.data.length === 0 ? (
          <div className="flex flex-col items-start gap-3">
            <p className="text-sm text-muted-foreground">{tr("site.portal.home.noPackage")}</p>
            <Link href={portalPath(locale, "shop") as Route} className={buttonVariants({ size: "sm" })}>
              {tr("site.portal.home.buyPackage")}
            </Link>
          </div>
        ) : (
          <ul className="grid gap-4">
            {balances.data.map((b) => (
              <li key={b.kind} data-credit-kind={b.kind} className="flex items-center gap-4">
                <span className="grid size-14 shrink-0 place-items-center rounded-2xl bg-[#f4ead3] text-2xl font-semibold text-[#212842] tabular-nums">
                  {b.kind === "euro" ? "€" : b.remainingUnits}
                </span>
                <span>
                  <span className="block font-medium">{remainingText(tr, locale, b)}</span>
                  {b.nextExpiresAt ? (
                    <span className="block text-sm text-muted-foreground">{tr("site.portal.home.expires", { date: formatDate(b.nextExpiresAt, locale) })}</span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
