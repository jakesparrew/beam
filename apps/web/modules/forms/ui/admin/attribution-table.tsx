/**
 * Campaign attribution (forms spec section 1 Release 3, forms-P9; `/admin/forms/attribution`): one
 * row per `utm_campaign` with leads, completions, bookings and revenue within 30 days, ad spend
 * from ops' `ad_spend_daily` and cost per lead, a totals row, and "CSV of the table" as a `data:`
 * download built on the server with the CSV injection guard. Server-rendered markup.
 */
import { formatMoney, formatNumber, type Locale } from "@beam/core/i18n";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import type { CampaignAttribution, CampaignAttributionCounts } from "../../queries";
import { toCsvText } from "../../service/export-csv";

export type AttributionTableLabels = {
  title: string;
  campaign: string;
  leads: string;
  completions: string;
  bookings: string;
  revenue: string;
  spend: string;
  costPerLead: string;
  noCampaign: string;
  total: string;
  downloadCsv: string;
  empty: string;
};

export type AttributionTableProps = { data: CampaignAttribution; locale: Locale; labels: AttributionTableLabels; fileName: string };

const euros = (cents: number | null): number | null => (cents === null ? null : cents / 100);

export function AttributionTable({ data, locale, labels, fileName }: AttributionTableProps) {
  const money = (c: number | null) => (c === null ? "—" : formatMoney(c, locale));
  const num = (n: number) => formatNumber(n, locale);
  const header = [labels.campaign, labels.leads, labels.completions, labels.bookings, labels.revenue, labels.spend, labels.costPerLead];
  const csvLine = (name: string, r: CampaignAttributionCounts) => [name, r.leads, r.completions, r.bookings, euros(r.revenue30dCents), euros(r.spendCents), euros(r.costPerLeadCents)];
  const csvRows = [...data.rows.map((r) => csvLine(r.utmCampaign ?? labels.noCampaign, r)), csvLine(labels.total, data.totals)];
  const href = `data:text/csv;charset=utf-8,${encodeURIComponent(toCsvText(header, csvRows))}`;
  const cells = (r: CampaignAttributionCounts) => (
    <>
      <TableCell className="text-right tabular-nums">{num(r.leads)}</TableCell>
      <TableCell className="text-right tabular-nums">{num(r.completions)}</TableCell>
      <TableCell className="text-right tabular-nums">{num(r.bookings)}</TableCell>
      <TableCell className="text-right tabular-nums">{money(r.revenue30dCents)}</TableCell>
      <TableCell className="text-right tabular-nums">{money(r.spendCents)}</TableCell>
      <TableCell className="text-right tabular-nums">{money(r.costPerLeadCents)}</TableCell>
    </>
  );
  return (
    <section className="grid gap-3" aria-labelledby="attribution-table-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="attribution-table-title" className="text-lg font-semibold">
          {labels.title}
        </h2>
        {data.rows.length ? (
          <a className="text-sm underline" href={href} download={fileName}>
            {labels.downloadCsv}
          </a>
        ) : null}
      </div>
      {data.rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{labels.empty}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              {header.map((h, i) => (
                <TableHead key={h} scope="col" className={i ? "text-right" : undefined}>
                  {h}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.rows.map((r) => (
              <TableRow key={r.utmCampaign ?? "__none"}>
                <TableCell className="font-medium">{r.utmCampaign ?? <span className="text-muted-foreground">{labels.noCampaign}</span>}</TableCell>
                {cells(r)}
              </TableRow>
            ))}
            <TableRow className="border-t-2 font-semibold">
              <TableCell>{labels.total}</TableCell>
              {cells(data.totals)}
            </TableRow>
          </TableBody>
        </Table>
      )}
    </section>
  );
}
