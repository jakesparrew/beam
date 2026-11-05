import { notFound } from "next/navigation";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { formatMoney, formatNumber, formatPercent, type Locale } from "@beam/core/i18n";
import { flag } from "@/lib/flags";
import { translator } from "@/lib/i18n";
import { getManagementDashboard } from "@/modules/ops/marketing/queries";
import { CUSTOMER_TILES, RETENTION_TILES, type Rate } from "@/modules/ops/marketing/management";
import { staffReadCtx } from "@/modules/ops/reports/queries";
import { brusselsDate, parsePeriod, parseReportAt, parseVat, TILE_PERIODS, type Comparison } from "@/modules/ops/reports/revenue";
import { KpiTile } from "@/modules/ops/ui/KpiTile";
import { PeriodPicker } from "@/modules/ops/ui/PeriodPicker";

/**
 * `/admin/dashboard/management` (ops spec 5, rules 34-38; `reports.read`, behind
 * `ff_ops_marketing`): the revenue, customers, sales mix, retention and B2B tile groups for the
 * `?period=` (day, week, month to date, YTD) around `?at=`, each against the previous period,
 * with `?vat=incl|excl` for the revenue figures. Tiles show 0 with "no data" when empty; the
 * CSV has every tile.
 */
export const dynamic = "force-dynamic";

const pct = (r: Rate, locale: Locale) => (r.rate === null ? "-" : formatPercent(r.rate * 100, locale));

export default async function ManagementDashboardPage({ searchParams }: { searchParams: Promise<{ period?: string; at?: string; vat?: string }> }) {
  const ctx = await staffReadCtx({ permission: "reports.read" });
  if (!(await flag("ff_ops_marketing", ctx.actor))) notFound();
  const sp = await searchParams;
  const period = parsePeriod(sp.period, "month");
  const vat = parseVat(sp.vat);
  const at = parseReportAt(sp.at, ctx.now);
  const tr = translator(ctx.locale);
  const d = await getManagementDashboard(ctx, { period, at, vat });
  const money = (c: number) => formatMoney(c, ctx.locale);
  const count = (n: number) => formatNumber(n, ctx.locale);
  const query = new URLSearchParams({ period, vat, ...(sp.at ? { at: brusselsDate(at) } : {}) }).toString();
  const change = (c: Comparison, fmt: (n: number) => string) => ({
    change: c.change,
    changePct: c.changePct,
    formattedChange: fmt(Math.abs(c.change)),
    blankLabel: tr("ops.period.change_blank"),
    label: tr("ops.period.change"),
  });
  const tile = (id: string, label: string, c: Comparison, fmt: (n: number) => string) => (
    <KpiTile
      key={id}
      testId={`mgmt-tile-${id}`}
      label={label}
      value={c.current}
      formattedValue={c.current === 0 && c.previous === 0 ? `${fmt(0)} (${tr("ops.management.no_data")})` : fmt(c.current)}
      previousLabel={`${tr("ops.period.previous")}: ${fmt(c.previous)}`}
      change={change(c, fmt)}
      locale={ctx.locale}
    />
  );

  return (
    <div className="grid gap-8" data-testid="management-dashboard">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{tr("ops.management.title")}</h1>
        <a href={`/admin/reports/management/csv?${query}`} className="text-sm font-medium underline-offset-4 hover:underline" data-testid="management-csv" download>
          {tr("ops.common.download_csv")}
        </a>
      </div>
      <p className="text-sm text-muted-foreground">{tr("ops.management.intro")}</p>
      <PeriodPicker
        pathname="/admin/dashboard/management"
        periods={TILE_PERIODS.map((p) => ({ value: p, label: tr(`ops.period.${p}`) }))}
        current={{ period: period as (typeof TILE_PERIODS)[number], vat, ...(sp.at ? { at: brusselsDate(at) } : {}) }}
        vatLabels={{ incl: tr("ops.reports.vat.incl"), excl: tr("ops.reports.vat.excl"), legend: tr("ops.reports.revenue.filter.vat") }}
        periodLegend={tr("ops.reports.revenue.filter.period")}
      />

      <section className="grid gap-3" data-testid="mgmt-group-revenue" aria-labelledby="mgmt-revenue">
        <h2 id="mgmt-revenue" className="text-lg font-semibold">{tr("ops.management.group.revenue")}</h2>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {tile("net", tr("ops.management.revenue.net"), d.revenue.net, money)}
          {tile("orders", tr("ops.management.revenue.orders"), d.revenue.orders, count)}
          {TILE_PERIODS.filter((p) => p !== period).map((p) => tile(`net-${p}`, `${tr("ops.management.revenue.net")}: ${tr(`ops.period.${p}`)}`, d.revenue.tiles[p], money))}
        </div>
      </section>

      <section className="grid gap-3" data-testid="mgmt-group-customers" aria-labelledby="mgmt-customers">
        <h2 id="mgmt-customers" className="text-lg font-semibold">{tr("ops.management.group.customers")}</h2>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">{CUSTOMER_TILES.map((k) => tile(`customers-${k}`, tr(`ops.management.customers.${k}`), d.customers[k], count))}</div>
      </section>

      <section className="grid gap-3" data-testid="mgmt-group-sales" aria-labelledby="mgmt-sales">
        <h2 id="mgmt-sales" className="text-lg font-semibold">{tr("ops.management.group.sales")}</h2>
        <div className="grid gap-6 lg:grid-cols-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tr("ops.reports.revenue.column.product_kind")}</TableHead>
                <TableHead className="text-right">{tr("ops.reports.revenue.column.orders")}</TableHead>
                <TableHead className="text-right">{tr("ops.reports.revenue.column.gross")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {d.revenue.byKind.map((k) => (
                <TableRow key={k.kind} data-kind={k.kind} data-value={k.amountCents}>
                  <TableCell>{tr(`ops.reports.product_kind.${k.kind}`)}</TableCell>
                  <TableCell className="text-right tabular-nums">{k.orders}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(k.amountCents)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tr("ops.reports.revenue.column.channel")}</TableHead>
                <TableHead className="text-right">{tr("ops.reports.revenue.column.orders")}</TableHead>
                <TableHead className="text-right">{tr("ops.reports.revenue.column.gross")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {d.revenue.byChannel.map((c) => (
                <TableRow key={c.channel} data-channel={c.channel} data-value={c.amountCents}>
                  <TableCell>{tr(`ops.reports.channel.${c.channel}`)}</TableCell>
                  <TableCell className="text-right tabular-nums">{c.orders}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(c.amountCents)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <section className="grid gap-3" data-testid="mgmt-group-retention" aria-labelledby="mgmt-retention">
        <h2 id="mgmt-retention" className="text-lg font-semibold">{tr("ops.management.group.retention")}</h2>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {RETENTION_TILES.map((k) => {
            const r = d.retention[k];
            return (
              <RateTile
                key={k}
                testId={`mgmt-tile-retention-${k}`}
                label={tr(`ops.management.retention.${k}`)}
                value={pct(r.current, ctx.locale)}
                detail={r.current.denominator > 0 ? tr("ops.management.rate_of", { numerator: r.current.numerator, denominator: r.current.denominator }) : tr("ops.management.no_data")}
                previous={tr("ops.management.previous_rate", { rate: pct(r.previous, ctx.locale) })}
              />
            );
          })}
        </div>
      </section>

      <section className="grid gap-3" data-testid="mgmt-group-b2b" aria-labelledby="mgmt-b2b">
        <h2 id="mgmt-b2b" className="text-lg font-semibold">{tr("ops.management.group.b2b")}</h2>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <RateTile testId="mgmt-tile-b2b-pipeline" label={tr("ops.management.b2b.pipeline_value")} value={money(d.b2b.pipelineValueCents)} detail={tr("ops.management.now")} />
          <RateTile testId="mgmt-tile-b2b-weighted" label={tr("ops.management.b2b.weighted_value")} value={money(d.b2b.weightedValueCents)} detail={tr("ops.management.now")} />
          <RateTile testId="mgmt-tile-b2b-qualified" label={tr("ops.management.b2b.qualified")} value={count(d.b2b.qualifiedCount)} detail={tr("ops.management.now")} />
          <RateTile testId="mgmt-tile-b2b-proposals" label={tr("ops.management.b2b.proposals")} value={count(d.b2b.proposalCount)} detail={tr("ops.management.now")} />
          <RateTile
            testId="mgmt-tile-b2b-conversion"
            label={tr("ops.management.b2b.conversion")}
            value={pct(d.b2b.conversion.current, ctx.locale)}
            detail={d.b2b.conversion.current.denominator > 0 ? tr("ops.management.rate_of", { numerator: d.b2b.conversion.current.numerator, denominator: d.b2b.conversion.current.denominator }) : tr("ops.management.no_data")}
            previous={tr("ops.management.previous_rate", { rate: pct(d.b2b.conversion.previous, ctx.locale) })}
          />
          {tile("b2b-revenue", tr("ops.management.b2b.revenue"), d.b2b.revenueCents, money)}
        </div>
      </section>
    </div>
  );
}

function RateTile({ label, value, detail, previous, testId }: { label: string; value: string; detail: string; previous?: string; testId: string }) {
  return (
    <div className="grid gap-1 rounded-lg border p-4" data-testid={testId}>
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-2xl font-semibold tabular-nums">{value}</span>
      <span className="text-sm text-muted-foreground">{detail}</span>
      {previous ? <span className="text-sm text-muted-foreground">{previous}</span> : null}
    </div>
  );
}
