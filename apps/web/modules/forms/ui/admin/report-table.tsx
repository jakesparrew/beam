/**
 * The report breakdown (forms spec section 5 `/admin/forms/[formId]/report`; forms-P6): one row
 * per group (day, version, source, campaign, funnel or link) with views, the funnel, completion
 * rate, conversions to booking and purchase within 30 days and revenue, plus "CSV of the table"
 * as a `data:` download built on the server with the CSV injection guard. Server-rendered markup.
 */
import { formatMoney, formatNumber, formatPercent, type Locale } from "@beam/core/i18n";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import type { FormReport } from "../../queries";
import { toCsvText } from "../../service/export-csv";
import { lbl, type Labels } from "./submission-table";

export type ReportTableProps = { report: FormReport; locale: Locale; labels: Labels; fileName: string };

const COLUMNS = ["views", "started", "engaged", "completed", "abandoned", "completion_rate", "booked", "purchased", "revenue"] as const;

/** The display label of a group row ("(none)" for an empty campaign or link, "Version n"). */
export function groupLabel(g: FormReport["groups"][number], labels: Labels): string {
  if (g.version !== undefined) return lbl(labels, "report.version_n", { n: g.version });
  return g.label || lbl(labels, "report.none");
}

export function ReportTable({ report, locale, labels, fileName }: ReportTableProps) {
  const pct = (v: number | null) => (v === null ? "—" : formatPercent(v * 100, locale));
  const header = [lbl(labels, "report.group"), ...COLUMNS.map((c) => lbl(labels, `report.${c}`))];
  const csvRows = report.groups.map((g) => [
    groupLabel(g, labels),
    g.views,
    g.started,
    g.engaged,
    g.completed,
    g.abandoned,
    g.completionRate === null ? null : Math.round(g.completionRate * 1000) / 10,
    g.booked,
    g.purchased,
    g.revenueCents / 100,
  ]);
  const href = `data:text/csv;charset=utf-8,${encodeURIComponent(toCsvText(header, csvRows))}`;
  return (
    <section className="grid gap-3" aria-labelledby="report-table-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="report-table-title" className="text-lg font-semibold">
          {lbl(labels, "report.table_title")}
        </h2>
        <a className="text-sm underline" href={href} download={fileName}>
          {lbl(labels, "report.download_csv")}
        </a>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            {header.map((h, i) => (
              <TableHead key={h} className={i ? "text-right" : undefined}>
                {h}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {report.groups.map((g) => (
            <TableRow key={g.key || "none"}>
              <TableCell className="font-medium">{groupLabel(g, labels)}</TableCell>
              <TableCell className="text-right tabular-nums">{g.views === null ? "—" : formatNumber(g.views, locale)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatNumber(g.started, locale)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatNumber(g.engaged, locale)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatNumber(g.completed, locale)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatNumber(g.abandoned, locale)}</TableCell>
              <TableCell className="text-right tabular-nums">{pct(g.completionRate)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatNumber(g.booked, locale)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatNumber(g.purchased, locale)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatMoney(g.revenueCents, locale)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}
