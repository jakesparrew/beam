/**
 * `CreditsSummaryCard` (credits spec section 5): the portal home's card with the customer's
 * remaining units per kind in words (rule 36), the store-credit balance and the membership status,
 * linking to `/account/packages` and `/account/membership`. The portal home (site) renders it for
 * the signed-in customer's own `personId`; a host that already loaded the summary passes it in.
 * When the read fails the card renders nothing, so the home page still answers.
 */
import { Badge, Card, CardContent, CardHeader, CardTitle } from "@beam/ui";
import { formatDate, formatMoney, URL_SEGMENT, type Locale } from "@beam/core/i18n";
import type { CreditKind } from "@beam/core/credits";
import { getAppDb } from "@/lib/ctx";
import { translator } from "@/lib/i18n";
import { getPersonCreditSummary } from "../server/ledger";
import { unitsText } from "./package-card";

export type CreditsSummary = {
  byKind: { kind: CreditKind; remainingUnits: number; nextExpiresAt: Date | null }[];
  membership: { id: string; status: string; periodEndAt: Date; cancelAt?: Date | null } | null;
};

export function CreditsSummaryView({ summary, locale }: { summary: CreditsSummary; locale: Locale }) {
  const tr = translator(locale);
  const seg = URL_SEGMENT[locale];
  const kinds = summary.byKind.filter((k) => k.remainingUnits > 0);
  const m = summary.membership;
  return (
    <Card data-testid="credits-summary-card">
      <CardHeader>
        <CardTitle className="text-base">{tr("credits.portal.summary.title")}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        {kinds.length === 0 ? (
          <p className="text-sm text-muted-foreground">{tr("credits.portal.summary.nothing")}</p>
        ) : (
          <ul className="grid gap-1">
            {kinds.map((k) => (
              <li key={k.kind} className="text-sm font-medium">
                {k.kind === "euro" ? tr("credits.portal.packages.store_credit", { amount: formatMoney(k.remainingUnits, locale) }) : unitsText(k.kind, k.remainingUnits, locale, tr)}
              </li>
            ))}
          </ul>
        )}
        {m ? (
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <Badge variant="secondary">{tr("credits.portal.membership.member_badge")}</Badge>
            <span>
              {m.cancelAt
                ? tr("credits.portal.summary.member_ends", { date: formatDate(m.cancelAt, locale) })
                : tr("credits.portal.summary.member_until", { date: formatDate(m.periodEndAt, locale) })}
            </span>
            {m.status === "past_due" ? (
              <Badge variant="warning">
                <span aria-hidden="true">!</span>
                {tr("credits.portal.summary.past_due")}
              </Badge>
            ) : null}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-4">
          <a href={`/${seg}/account/packages`} className="inline-flex min-h-11 items-center text-sm font-medium underline">
            {tr("credits.portal.summary.link")}
          </a>
          {m ? (
            <a href={`/${seg}/account/membership`} className="inline-flex min-h-11 items-center text-sm font-medium underline">
              {tr("credits.portal.summary.membership_link")}
            </a>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

export async function CreditsSummaryCard({ personId, locale, summary }: { personId: string; locale: Locale; summary?: CreditsSummary }) {
  const data = summary ?? (await getPersonCreditSummary(await getAppDb(), personId).catch(() => null));
  if (!data) return null;
  return <CreditsSummaryView summary={data} locale={locale} />;
}
