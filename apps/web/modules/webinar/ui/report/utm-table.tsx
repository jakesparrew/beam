/**
 * The UTM table of the report (section 5.1; webinar-P6): registrations, attended (any mode) and
 * converted per UTM source and campaign. webinar-P7 adds cost per registration and the
 * click-to-registration rate from `ad_spend_daily`. A server component.
 */
import { formatNumber, type Locale } from "@beam/core/i18n";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import type { UtmRow } from "../../server/report";

export type UtmTableLabels = { title: string; empty: string; source: string; campaign: string; none: string; registrations: string; attended: string; converted: string };

export function UtmTable({ rows, labels, locale }: { rows: readonly UtmRow[]; labels: UtmTableLabels; locale: Locale }) {
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
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
