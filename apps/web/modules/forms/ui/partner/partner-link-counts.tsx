/**
 * `PartnerLinkCounts({ actor, locale })` (forms spec section 7 "Partner counts per tracked link",
 * R3, forms-P9): the server component crm's partner area renders through `forms/api.ts`. It shows
 * the views, starts and completions of the signed-in partner's own tracked links (those carrying
 * their `partner_company_id`, scoped by platform's `requirePartnerOrPermission`), counts only: no
 * person, email, answer or referrer ever reaches it. A caller without a partner scope gets nothing
 * rendered, so the host page never breaks on it.
 */
import { ForbiddenError } from "@beam/core/errors";
import { formatNumber, formatPercent, type Locale } from "@beam/core/i18n";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { createCtx, getAppDb, type Actor, type Tx } from "@/lib/ctx";
import { translator } from "@/lib/i18n";
import { partnerLinkCounts, type DayRange, type PartnerLinkCount } from "../../queries";

export type PartnerLinkCountsProps = { actor: Actor; locale: Locale; range?: DayRange };

/** The rows for an actor; null when the actor has no partner scope (not a partner, no company). */
export async function loadPartnerLinkCounts(actor: Actor, range?: DayRange): Promise<PartnerLinkCount[] | null> {
  const db = await getAppDb();
  try {
    return await partnerLinkCounts(createCtx({ tx: db as unknown as Tx, actor }), range);
  } catch (error) {
    if (error instanceof ForbiddenError) return null;
    throw error;
  }
}

export async function PartnerLinkCounts({ actor, locale, range }: PartnerLinkCountsProps) {
  const rows = await loadPartnerLinkCounts(actor, range);
  if (rows === null) return null;
  return <PartnerLinkCountsTable rows={rows} locale={locale} />;
}

/** The table itself (also used by tests and previews with ready rows). */
export function PartnerLinkCountsTable({ rows, locale }: { rows: PartnerLinkCount[]; locale: Locale }) {
  const tr = translator(locale);
  const t = (k: string) => tr(`forms.attribution.partner.${k}`);
  const num = (n: number) => formatNumber(n, locale);
  return (
    <section aria-labelledby="partner-link-counts" className="grid gap-2">
      <h2 id="partner-link-counts" className="text-lg font-semibold">
        {t("title")}
      </h2>
      <p className="max-w-prose text-sm text-muted-foreground">{t("intro")}</p>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <Table>
          <caption className="sr-only">{t("caption")}</caption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{t("col_link")}</TableHead>
              <TableHead scope="col">{t("col_form")}</TableHead>
              <TableHead scope="col" className="text-right">
                {t("col_views")}
              </TableHead>
              <TableHead scope="col" className="text-right">
                {t("col_starts")}
              </TableHead>
              <TableHead scope="col" className="text-right">
                {t("col_completions")}
              </TableHead>
              <TableHead scope="col" className="text-right">
                {t("col_rate")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.linkId}>
                <TableCell>
                  {r.name}
                  {r.isActive ? null : <span className="ml-2 text-xs text-muted-foreground">({t("inactive")})</span>}
                </TableCell>
                <TableCell>{r.formName[locale]?.trim() || r.formSlug}</TableCell>
                <TableCell className="text-right tabular-nums">{num(r.views)}</TableCell>
                <TableCell className="text-right tabular-nums">{num(r.starts)}</TableCell>
                <TableCell className="text-right tabular-nums">{num(r.completions)}</TableCell>
                <TableCell className="text-right tabular-nums">{r.starts > 0 ? formatPercent((r.completions / r.starts) * 100, locale) : "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
