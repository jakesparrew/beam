/**
 * The report table by lead, customer, member and total (rule 39; webinar-P6): the conversion
 * table (registrations, booked, purchased, converted, conversion rate, revenue in the period),
 * then one table per watch mode with the funnel metrics (registered, started, attended, 15 min,
 * 30 min, 50 %, end, average watch minutes, poll responses, CTA shown and clicked). A server
 * component; the page passes the labels and the locale.
 */
import { formatMoney, formatNumber, formatPercent, type Locale } from "@beam/core/i18n";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { WATCH_MODES, type WatchMode } from "@beam/core/webinar";
import type { ModeRow, ReportSegment, SegmentRow } from "../../server/report";

const MODE_METRICS = ["registered", "started", "attended", "watched15m", "watched30m", "watchedHalf", "watchedEnd", "avgWatchMinutes", "pollResponses", "ctaShown", "ctaClicked"] as const;
const CONVERSION = ["registrations", "booked", "purchased", "converted", "conversionRate", "revenue"] as const;
const COLUMNS = ["lead", "customer", "member", "total"] as const;

export type SegmentTableLabels = {
  metric: string;
  segments: Record<(typeof COLUMNS)[number], string>;
  modes: Record<WatchMode, string>;
  /** Contains `{mode}`. */
  modeCaption: string;
  conversionCaption: string;
  metrics: Record<(typeof MODE_METRICS)[number], string>;
  conversion: Record<(typeof CONVERSION)[number], string>;
};

export function SegmentTable({
  bySegment,
  totals,
  labels,
  locale,
}: {
  bySegment: Record<ReportSegment, SegmentRow>;
  totals: SegmentRow;
  labels: SegmentTableLabels;
  locale: Locale;
}) {
  const col = (c: (typeof COLUMNS)[number]): SegmentRow => (c === "total" ? totals : bySegment[c]);
  const modeValue = (row: ModeRow, k: (typeof MODE_METRICS)[number]) =>
    k === "avgWatchMinutes" ? formatNumber(row[k], locale, { maximumFractionDigits: 1 }) : formatNumber(row[k], locale);
  const conversionValue = (s: SegmentRow, k: (typeof CONVERSION)[number]) =>
    k === "conversionRate" ? formatPercent(s.conversionRate, locale) : k === "revenue" ? formatMoney(s.revenueCents, locale) : formatNumber(s[k], locale);

  const head = (
    <TableHeader>
      <TableRow>
        <TableHead scope="col">{labels.metric}</TableHead>
        {COLUMNS.map((c) => (
          <TableHead key={c} scope="col" className="text-right">
            {labels.segments[c]}
          </TableHead>
        ))}
      </TableRow>
    </TableHeader>
  );

  return (
    <div className="grid gap-6">
      <div className="overflow-x-auto">
        <Table data-testid="report-conversion">
          <TableCaption className="caption-top text-left font-medium text-foreground">{labels.conversionCaption}</TableCaption>
          {head}
          <TableBody>
            {CONVERSION.map((k) => (
              <TableRow key={k}>
                <TableHead scope="row" className="font-normal">
                  {labels.conversion[k]}
                </TableHead>
                {COLUMNS.map((c) => (
                  <TableCell key={c} className="text-right tabular-nums">
                    {conversionValue(col(c), k)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {WATCH_MODES.map((m) => (
        <div key={m} className="overflow-x-auto">
          <Table data-testid={`report-mode-${m}`}>
            <TableCaption className="caption-top text-left font-medium text-foreground">{labels.modeCaption.replace("{mode}", labels.modes[m])}</TableCaption>
            {head}
            <TableBody>
              {MODE_METRICS.map((k) => (
                <TableRow key={k} data-metric={k}>
                  <TableHead scope="row" className="font-normal">
                    {labels.metrics[k]}
                  </TableHead>
                  {COLUMNS.map((c) => (
                    <TableCell key={c} className="text-right tabular-nums" data-segment={c}>
                      {modeValue(col(c).modes[m], k)}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ))}
    </div>
  );
}
