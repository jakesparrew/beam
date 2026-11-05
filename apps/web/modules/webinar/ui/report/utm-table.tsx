/**
 * The UTM table of the report (section 5.1; webinar-P6): registrations, attended (any mode) and
 * converted per UTM source and campaign. webinar-P7 adds the campaign's ad spend, cost per
 * registration and click-to-registration rate from ops' `ad_spend_daily`; the three columns show
 * only when at least one campaign of the webinar has ad rows, and a row without spend reads
 * "No ad spend" (never a zero cost). A server component.
 */
import { formatMoney, formatNumber, formatPercent, type Locale } from "@beam/core/i18n";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { translator } from "@/lib/i18n";
import type { UtmRow } from "../../server/report";

export type UtmTableLabels = {
  title: string;
  empty: string;
  source: string;
  campaign: string;
  none: string;
  registrations: string;
  attended: string;
  converted: string;
  /** webinar-P7 labels; default to the `webinar.admin.report.utm.*` catalogue keys of `locale`. */
  spend?: string;
  costPerRegistration?: string;
  clickToRegistration?: string;
  noSpend?: string;
  spendHint?: string;
};

export function UtmTable({ rows, labels, locale }: { rows: readonly UtmRow[]; labels: UtmTableLabels; locale: Locale }) {
  const tr = translator(locale);
  const u = (k: string) => tr(`webinar.admin.report.utm.${k}`);
  const spend = {
    spend: labels.spend ?? u("spend"),
    costPerRegistration: labels.costPerRegistration ?? u("cost_per_registration"),
    clickToRegistration: labels.clickToRegistration ?? u("click_to_registration"),
    noSpend: labels.noSpend ?? u("no_spend"),
    spendHint: labels.spendHint ?? u("spend_hint"),
  };
  const withSpend = rows.some((r) => r.spendCents !== null);
  const money = (cents: number | null) => (cents === null ? null : formatMoney(cents, locale));
  return (
    <section aria-labelledby="report-utm" className="grid gap-3">
      <h2 id="report-utm" className="text-lg font-semibold">
        {labels.title}
      </h2>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{labels.empty}</p>
      ) : (
        <div className="overflow-x-auto">
          <Table data-testid="report-utm">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">{labels.source}</TableHead>
                <TableHead scope="col">{labels.campaign}</TableHead>
                <TableHead scope="col" className="text-right">
                  {labels.registrations}
                </TableHead>
                <TableHead scope="col" className="text-right">
                  {labels.attended}
                </TableHead>
                <TableHead scope="col" className="text-right">
                  {labels.converted}
                </TableHead>
                {withSpend ? (
                  <>
                    <TableHead scope="col" className="text-right">
                      {spend.spend}
                    </TableHead>
                    <TableHead scope="col" className="text-right">
                      {spend.costPerRegistration}
                    </TableHead>
                    <TableHead scope="col" className="text-right">
                      {spend.clickToRegistration}
                    </TableHead>
                  </>
                ) : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={`${r.source ?? ""}|${r.campaign ?? ""}`}>
                  <TableCell>{r.source ?? labels.none}</TableCell>
                  <TableCell>{r.campaign ?? labels.none}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(r.registrations, locale)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(r.attended, locale)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(r.converted, locale)}</TableCell>
                  {withSpend ? (
                    r.spendCents === null ? (
                      <TableCell colSpan={3} className="text-right text-sm text-muted-foreground">
                        {spend.noSpend}
                      </TableCell>
                    ) : (
                      <>
                        <TableCell className="text-right tabular-nums">{money(r.spendCents)}</TableCell>
                        <TableCell className="text-right tabular-nums">{money(r.costPerRegistrationCents) ?? "–"}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {r.clickToRegistrationRate === null ? "–" : formatPercent(r.clickToRegistrationRate * 100, locale)}
                        </TableCell>
                      </>
                    )
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {withSpend ? <p className="mt-2 text-xs text-muted-foreground">{spend.spendHint}</p> : null}
        </div>
      )}
    </section>
  );
}
