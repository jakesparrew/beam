import { EmptyState, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { formatDate, formatMoney } from "@beam/core/i18n";
import { softTranslator, translator } from "@/lib/i18n";
import { getCreditLiabilityForPeriod, getRevenueReport, staffReadCtx } from "@/modules/ops/reports/queries";
import { brusselsDate, parsePeriod, parseReportAt, parseVat, TILE_PERIODS, type Comparison } from "@/modules/ops/reports/revenue";
import { KpiTile } from "@/modules/ops/ui/KpiTile";
import { PeriodPicker } from "@/modules/ops/ui/PeriodPicker";

/**
 * `/admin/reports/revenue` (ops spec 5, rules 34, 35, 35a; `reports.read`): net revenue for the
 * day, week, month to date and year to date with the previous-period change, the daily line of
 * the last 90 days (with "Show as table"), the sales mix by product kind and channel for the
 * selected period, and the prepaid credits outstanding. `?period=`, `?at=YYYY-MM-DD` and
 * `?vat=incl|excl` drive the report and its CSV.
 */
export const dynamic = "force-dynamic";

const CHART_W = 720;
const CHART_H = 160;

export default async function RevenueReportPage({ searchParams }: { searchParams: Promise<{ period?: string; at?: string; vat?: string }> }) {
  const ctx = await staffReadCtx({ permission: "reports.read" });
  const sp = await searchParams;
  const period = parsePeriod(sp.period);
  const vat = parseVat(sp.vat);
  const at = parseReportAt(sp.at, ctx.now);
  const tr = translator(ctx.locale);
  const soft = softTranslator(ctx.locale);
  const label = (key: string, fallback: string) => {
    const s = soft(key);
    return s === key ? fallback : s;
  };
  const [report, liability] = await Promise.all([getRevenueReport(ctx, { period, at, vat }), getCreditLiabilityForPeriod(ctx, { period, at })]);
  const money = (c: number) => formatMoney(c, ctx.locale);
  const changeProps = (c: Comparison) => ({
    change: c.change,
    changePct: c.changePct,
    formattedChange: money(Math.abs(c.change)),
    blankLabel: tr("ops.period.change_blank"),
    label: tr("ops.period.change"),
  });
  const query = new URLSearchParams({ period, vat, ...(sp.at ? { at: brusselsDate(at) } : {}) }).toString();
  const isEmpty = report.sales.current === 0 && report.refunds.current === 0;
  const max = Math.max(1, ...report.daily.map((d) => Math.abs(d.netCents)));
  const barW = CHART_W / Math.max(1, report.daily.length);
  const total90 = report.daily.reduce((a, d) => a + d.netCents, 0);

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{tr("ops.reports.revenue.title")}</h1>
        <a href={`/admin/reports/revenue/csv?${query}`} className="text-sm font-medium underline-offset-4 hover:underline" data-testid="revenue-csv" download>
          {tr("ops.common.download_csv")}
        </a>
      </div>

      <PeriodPicker
        pathname="/admin/reports/revenue"
        periods={TILE_PERIODS.map((p) => ({ value: p, label: tr(`ops.period.${p}`) }))}
        current={{ period: period as (typeof TILE_PERIODS)[number], vat, ...(sp.at ? { at: brusselsDate(at) } : {}) }}
        vatLabels={{ incl: tr("ops.reports.vat.incl"), excl: tr("ops.reports.vat.excl"), legend: tr("ops.reports.revenue.filter.vat") }}
        periodLegend={tr("ops.reports.revenue.filter.period")}
      />

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label={tr("ops.reports.revenue.net")}>
        {TILE_PERIODS.map((p) => (
          <KpiTile
            key={p}
            testId={`revenue-tile-${p}`}
            label={`${tr("ops.reports.revenue.net")}: ${tr(`ops.period.${p}`)}`}
            value={report.tiles[p].current}
            formattedValue={money(report.tiles[p].current)}
            previousLabel={`${tr("ops.period.previous")}: ${money(report.tiles[p].previous)}`}
            change={changeProps(report.tiles[p])}
            locale={ctx.locale}
          />
        ))}
      </section>
      <p className="sr-only">
        {tr("ops.reports.revenue.summary", {
          amount: money(report.net.current),
          change: report.net.changePct === null ? tr("ops.period.change_blank") : `${report.net.changePct > 0 ? "+" : ""}${report.net.changePct} %`,
        })}
      </p>

      <section className="grid gap-2">
        <h2 className="text-lg font-semibold">{tr("ops.reports.revenue.daily")}</h2>
        <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} className="h-40 w-full rounded-md border" role="img" aria-label={`${tr("ops.reports.revenue.daily")}: ${money(total90)}`}>
          {report.daily.map((d, i) => {
            const h = (Math.abs(d.netCents) / max) * (CHART_H - 8);
            return <rect key={d.day} x={i * barW + 1} y={CHART_H - h} width={Math.max(1, barW - 2)} height={h} className={d.netCents < 0 ? "fill-destructive" : "fill-primary"} />;
          })}
        </svg>
        <details>
          <summary className="cursor-pointer text-sm">{tr("ops.reports.show_as_table")}</summary>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tr("ops.reports.revenue.column.day")}</TableHead>
                <TableHead className="text-right">{tr("ops.reports.revenue.column.net")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.daily.map((d) => (
                <TableRow key={d.day}>
                  <TableCell>{formatDate(d.day, ctx.locale)}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(d.netCents)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </details>
      </section>

      {isEmpty ? (
        <EmptyState title={tr("ops.reports.revenue.empty")} />
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          <section className="grid gap-2" data-testid="revenue-by-kind">
            <h2 className="text-lg font-semibold">{tr("ops.reports.revenue.by_kind")}</h2>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{tr("ops.reports.revenue.column.product_kind")}</TableHead>
                  <TableHead className="text-right">{tr("ops.reports.revenue.column.orders")}</TableHead>
                  <TableHead className="text-right">{tr("ops.reports.revenue.column.gross")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.byKind.map((k) => (
                  <TableRow key={k.kind} data-kind={k.kind} data-value={k.amountCents}>
                    <TableCell>{tr(`ops.reports.product_kind.${k.kind}`)}</TableCell>
                    <TableCell className="text-right tabular-nums">{k.orders}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(k.amountCents)}</TableCell>
                  </TableRow>
                ))}
                <TableRow data-kind="refund" data-value={report.refunds.current}>
                  <TableCell>{tr("ops.reports.product_kind.refund")}</TableCell>
                  <TableCell />
                  <TableCell className="text-right tabular-nums">{money(-report.refunds.current)}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </section>
          <section className="grid gap-2" data-testid="revenue-by-channel">
            <h2 className="text-lg font-semibold">{tr("ops.reports.revenue.by_channel")}</h2>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{tr("ops.reports.revenue.column.channel")}</TableHead>
                  <TableHead className="text-right">{tr("ops.reports.revenue.column.orders")}</TableHead>
                  <TableHead className="text-right">{tr("ops.reports.revenue.column.gross")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.byChannel.map((c) => (
                  <TableRow key={c.channel} data-channel={c.channel} data-value={c.amountCents}>
                    <TableCell>{tr(`ops.reports.channel.${c.channel}`)}</TableCell>
                    <TableCell className="text-right tabular-nums">{c.orders}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(c.amountCents)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </section>
        </div>
      )}

      <section className="grid gap-2" data-testid="credit-liability">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">{tr("ops.reports.liability.title")}</h2>
          <a href={`/admin/reports/liability/csv?${liability.source === "as_of" ? `at=${brusselsDate(liability.asOf)}` : ""}`} className="text-sm underline-offset-4 hover:underline" download>
            {tr("ops.common.download_csv")}
          </a>
        </div>
        <p className="text-sm text-muted-foreground">
          {tr("ops.reports.liability.intro")} {tr("ops.reports.liability.as_of", { date: formatDate(liability.asOf, ctx.locale) })}
        </p>
        {liability.rows.length === 0 ? (
          <EmptyState title={tr("ops.reports.liability.empty")} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tr("ops.reports.liability.credit_kind")}</TableHead>
                <TableHead>{tr("ops.reports.liability.vat_treatment")}</TableHead>
                <TableHead className="text-right">{tr("ops.reports.liability.remaining_units")}</TableHead>
                <TableHead className="text-right">{tr("ops.reports.liability.value")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {liability.rows.map((r) => (
                <TableRow key={`${r.kind}:${r.vatTreatment}:${r.vatRatePct ?? ""}`}>
                  <TableCell>{label(`ops.reports.liability.kind.${r.kind}`, r.kind)}</TableCell>
                  <TableCell>
                    {label(`ops.reports.liability.vat.${r.vatTreatment}`, r.vatTreatment)}
                    {r.vatRatePct !== null ? ` (${r.vatRatePct} %)` : ""}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{r.kind === "euro" ? money(r.remainingUnits) : r.remainingUnits}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(r.remainingValueCents)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
    </div>
  );
}
