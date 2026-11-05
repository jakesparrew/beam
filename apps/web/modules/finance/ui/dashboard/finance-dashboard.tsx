/**
 * The finance dashboard screen (finance spec section 5, blueprint 43, finance-P8): period
 * selector, KPI tiles with previous-period and last-year comparison, the revenue trend, revenue
 * by category and payment method, VAT by rate and quarter, cash in and out, and the tables of
 * open invoices, failed payments and recurring revenue, each with its CSV. A server component:
 * it gets the data of `getFinanceDashboard` and the flattened labels, and renders no client code.
 */
import type { Route } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import {
  Alert,
  AlertDescription,
  Badge,
  buttonVariants,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@beam/ui";
import { formatDate, formatDateTime, formatMoney, formatNumber, formatPercent, type Locale } from "@beam/core/i18n";
import type { FinanceDashboard } from "../../queries";
import { BreakdownTable } from "./breakdown-table";
import { ColumnChart } from "./column-chart";
import { bucketLabel, categoryLabel, csvHref, euros, methodLabel, type DashboardLabel } from "./format";
import { KpiTile } from "./kpi-tile";
import { PeriodPicker } from "./period-picker";

export type FinanceDashboardViewProps = {
  data: FinanceDashboard;
  labels: Record<string, string>;
  locale: Locale;
  /** The custom range was refused; the page fell back to this month. */
  invalidCustom?: boolean;
};

function CsvLink({ href, file, label, text }: { href: string; file: string; label: string; text: string }) {
  return (
    <a href={href} download={file} className={buttonVariants({ variant: "outline", size: "sm" })} aria-label={label}>
      {text}
    </a>
  );
}

function Section({ title, description, actions, children }: { title: string; description?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
        <div className="grid gap-1">
          <CardTitle className="text-base">
            <h2>{title}</h2>
          </CardTitle>
          {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </CardHeader>
      <CardContent className="grid gap-3">{children}</CardContent>
    </Card>
  );
}

export function FinanceDashboardView({ data, labels, locale, invalidCustom = false }: FinanceDashboardViewProps) {
  const l: DashboardLabel = (key, params) => {
    const template = labels[`dashboard.${key}`] ?? key;
    return params ? template.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m)) : template;
  };
  const money = (cents: number) => formatMoney(cents, locale);
  const count = (n: number) => formatNumber(n, locale);
  const { period, tiles } = data;
  const range = (r: { from: string; to: string }) => (r.from === r.to ? formatDate(r.from, locale) : l("range", { from: formatDate(r.from, locale), to: formatDate(r.to, locale) }));
  const file = (name: string) => `beam-dashboard-${name}-${period.from}-${period.to}.csv`;
  const periodQuery = { from: period.from, to: period.to };
  const invoicesOfPeriod = { pathname: "/admin/finance/invoices" as Route, query: periodQuery };
  const cols = { current: l("col_current"), previous: l("col_previous"), lastYear: l("col_last_year") };
  const buckets = data.revenueTrend.points.map((p) => ({ key: p.bucket, label: bucketLabel(p.bucket, data.revenueTrend.granularity, locale) }));
  const bucketHeader = data.revenueTrend.granularity === "day" ? l("col_day") : l("col_month");
  const summary = (title: string) => l("chart_summary", { title, count: buckets.length, from: formatDate(period.from, locale), to: formatDate(period.to, locale) });

  const categoryRows = data.byCategory.map((r) => ({
    key: r.category,
    label: categoryLabel(labels, r.category),
    current: r.current,
    previous: r.previous,
    lastYear: r.lastYear,
    ...(r.liability ? { badge: l("liability") } : {}),
  }));
  const methodRows = data.byMethod.map((r) => ({ key: r.method, label: methodLabel(labels, r.method), current: r.current, previous: r.previous, lastYear: r.lastYear }));
  const figureCsv = (header: string, rows: { key: string; current: number; previous: number; lastYear: number }[]) =>
    csvHref([header, "current_eur", "previous_eur", "last_year_eur"], rows.map((r) => [r.key, euros(r.current), euros(r.previous), euros(r.lastYear)]));

  return (
    <div className="grid gap-6" data-testid="finance-dashboard" data-period={period.period} data-from={period.from} data-to={period.to}>
      <header className="grid gap-2">
        <h1 className="text-2xl font-semibold">{l("title")}</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">{l("intro")}</p>
        <Link href={invoicesOfPeriod} className="w-fit text-sm underline underline-offset-4">
          {l("period_invoices")}
        </Link>
      </header>
      <PeriodPicker current={period.period} from={period.from} to={period.to} l={l} />
      {invalidCustom ? (
        <Alert variant="destructive">
          <AlertDescription>{l("custom_invalid")}</AlertDescription>
        </Alert>
      ) : null}
      <p className="text-sm" data-testid="dashboard-range">
        <span className="font-medium">{range(period)}</span>{" "}
        <span className="text-muted-foreground">{l("compared_with", { previous: range(period.previous), last_year: range(period.lastYear) })}</span>
      </p>
      {data.hasData ? null : (
        <Alert data-testid="dashboard-no-data">
          <AlertDescription>{l("no_data")}</AlertDescription>
        </Alert>
      )}

      <section aria-label={l("title")} className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile id="net-revenue" title={l("tile_net_revenue")} figure={tiles.netRevenue} format={money} l={l} locale={locale} href={invoicesOfPeriod} />
        <KpiTile id="vat" title={l("tile_vat")} figure={tiles.vatCollected} format={money} l={l} locale={locale} />
        <KpiTile id="cash-inflow" title={l("tile_cash_inflow")} figure={tiles.cashInflow} format={money} l={l} locale={locale} />
        <KpiTile
          id="refunds"
          title={l("tile_refunds")}
          figure={tiles.refunds}
          format={money}
          l={l}
          locale={locale}
          inverse
          href={{ pathname: "/admin/finance/invoices" as Route, query: { ...periodQuery, kind: "credit_note" } }}
        />
        <Card data-testid="tile-open-invoices" data-value={tiles.openInvoices.amountCents} data-count={tiles.openInvoices.count}>
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground">{l("tile_open_invoices")}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2">
            <Link href="/admin/finance/invoices?status=open" className="w-fit text-2xl font-semibold tabular-nums underline-offset-4 hover:underline">
              {money(tiles.openInvoices.amountCents)}
            </Link>
            <span className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              {l("tile_open_detail", { count: count(tiles.openInvoices.count), overdue_count: count(tiles.openInvoices.overdueCount), overdue: money(tiles.openInvoices.overdueCents) })}
              {tiles.openInvoices.overdueCount > 0 ? <Badge variant="warning">{count(tiles.openInvoices.overdueCount)}</Badge> : null}
            </span>
            <span className="text-xs text-muted-foreground">{l("tile_open_now")}</span>
          </CardContent>
        </Card>
        <KpiTile id="failed-payments" title={l("tile_failed_payments")} figure={tiles.failedPayments} format={count} l={l} locale={locale} inverse note={l("past_due", { count: count(data.failedPayments.pastDueMemberships) })} />
        <KpiTile id="recurring" title={l("tile_recurring")} figure={tiles.recurringRevenue} format={money} l={l} locale={locale} />
        <KpiTile id="memberships" title={l("tile_memberships")} figure={tiles.activeMemberships} format={count} l={l} locale={locale} href="/admin/memberships" />
        <KpiTile id="vouchers" title={l("tile_vouchers")} figure={tiles.voucherSales} format={money} l={l} locale={locale} note={l("liability")} />
      </section>

      <Section
        title={l("chart_trend")}
        description={data.revenueTrend.granularity === "day" ? l("chart_trend_day") : l("chart_trend_month")}
        actions={
          <CsvLink
            text={l("csv")}
            href={csvHref(
              ["bucket", "current_eur", "previous_eur", "last_year_eur"],
              data.revenueTrend.points.map((p) => [p.bucket, euros(p.currentCents), euros(p.previousCents), euros(p.lastYearCents)]),
            )}
            file={file("revenue-trend")}
            label={l("csv_label", { table: l("chart_trend") })}
          />
        }
      >
        <ColumnChart
          id="revenue-trend"
          title={l("chart_trend")}
          summary={summary(l("chart_trend"))}
          showTableLabel={l("show_table")}
          bucketHeader={bucketHeader}
          buckets={buckets}
          columns={[{ key: "current", label: l("legend_current"), values: data.revenueTrend.points.map((p) => p.currentCents), className: "fill-primary" }]}
          line={{ key: "previous", label: l("legend_previous"), values: data.revenueTrend.points.map((p) => p.previousCents), className: "stroke-muted-foreground" }}
          extra={[{ key: "last-year", label: l("legend_last_year"), values: data.revenueTrend.points.map((p) => p.lastYearCents), className: "" }]}
          format={money}
        />
      </Section>

      <div className="grid gap-6 xl:grid-cols-2">
        <Section
          title={l("chart_category")}
          actions={<CsvLink text={l("csv")} href={figureCsv("category", data.byCategory.map((r) => ({ ...r, key: r.category })))} file={file("by-category")} label={l("csv_label", { table: l("chart_category") })} />}
        >
          <BreakdownTable id="category" caption={l("chart_category")} labelHeader={l("col_category")} headers={cols} rows={categoryRows} emptyLabel={l("empty_table")} format={money} />
        </Section>
        <Section
          title={l("chart_method")}
          actions={<CsvLink text={l("csv")} href={figureCsv("method", data.byMethod.map((r) => ({ ...r, key: r.method })))} file={file("by-method")} label={l("csv_label", { table: l("chart_method") })} />}
        >
          <BreakdownTable id="method" caption={l("chart_method")} labelHeader={l("col_method")} headers={cols} rows={methodRows} emptyLabel={l("empty_table")} format={money} />
        </Section>
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <Section
          title={l("chart_vat")}
          actions={
            <CsvLink
              text={l("csv")}
              href={csvHref(
                ["quarter", "vat_rate_pct", "net_eur", "vat_eur", "gross_eur"],
                data.vatByRate.map((r) => [r.quarter, r.ratePct, euros(r.netCents), euros(r.vatCents), euros(r.grossCents)]),
              )}
              file={file("vat")}
              label={l("csv_label", { table: l("chart_vat") })}
            />
          }
        >
          <Table data-testid="table-vat">
            <TableCaption className="sr-only">{l("chart_vat")}</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">{l("col_quarter")}</TableHead>
                <TableHead scope="col">{l("col_rate")}</TableHead>
                <TableHead scope="col" className="text-right">{l("col_net")}</TableHead>
                <TableHead scope="col" className="text-right">{l("col_vat")}</TableHead>
                <TableHead scope="col" className="text-right">{l("col_gross")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.vatByRate.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-muted-foreground">{l("empty_table")}</TableCell>
                </TableRow>
              ) : (
                data.vatByRate.map((r) => (
                  <TableRow key={`${r.quarter}-${r.ratePct}`}>
                    <TableCell>{r.quarter}</TableCell>
                    <TableCell>{formatPercent(r.ratePct, locale)}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(r.netCents)}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(r.vatCents)}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(r.grossCents)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </Section>
        <Section
          title={l("chart_cash")}
          description={l("cash_net", { value: money(data.cashFlow.totals.netCents) })}
          actions={
            <CsvLink
              text={l("csv")}
              href={csvHref(["bucket", "inflow_eur", "outflow_eur"], data.cashFlow.points.map((p) => [p.bucket, euros(p.inflowCents), euros(p.outflowCents)]))}
              file={file("cash-flow")}
              label={l("csv_label", { table: l("chart_cash") })}
            />
          }
        >
          <ColumnChart
            id="cash-flow"
            title={l("chart_cash")}
            summary={summary(l("chart_cash"))}
            showTableLabel={l("show_table")}
            bucketHeader={bucketHeader}
            buckets={buckets}
            columns={[
              { key: "inflow", label: l("legend_inflow"), values: data.cashFlow.points.map((p) => p.inflowCents), className: "fill-success" },
              { key: "outflow", label: l("legend_outflow"), values: data.cashFlow.points.map((p) => p.outflowCents), className: "fill-destructive" },
            ]}
            format={money}
          />
        </Section>
      </div>

      <Section
        title={l("table_open")}
        actions={
          <>
            <Link href="/admin/finance/invoices?status=open" className={buttonVariants({ variant: "ghost", size: "sm" })}>
              {l("all_open")}
            </Link>
            <CsvLink
              text={l("csv")}
              href={csvHref(
                ["number", "customer", "issued_on", "due_on", "amount_due_eur", "days_overdue"],
                data.openInvoices.rows.map((r) => [r.number, r.customerName, r.issuedOn, r.dueOn, euros(r.amountDueCents), r.daysOverdue]),
              )}
              file={file("open-invoices")}
              label={l("csv_label", { table: l("table_open") })}
            />
          </>
        }
      >
        <Table data-testid="table-open-invoices">
          <TableCaption>{l("table_open_caption")}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{l("col_number")}</TableHead>
              <TableHead scope="col">{l("col_customer")}</TableHead>
              <TableHead scope="col">{l("col_issued")}</TableHead>
              <TableHead scope="col">{l("col_due")}</TableHead>
              <TableHead scope="col" className="text-right">{l("col_amount_due")}</TableHead>
              <TableHead scope="col" className="text-right">{l("col_days_overdue")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.openInvoices.rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-muted-foreground">{l("empty_open")}</TableCell>
              </TableRow>
            ) : (
              data.openInvoices.rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    <Link href={`/admin/finance/invoices/${r.id}`} className="font-mono font-medium underline-offset-4 hover:underline">
                      {r.number}
                    </Link>
                  </TableCell>
                  <TableCell>{r.customerName ?? "—"}</TableCell>
                  <TableCell>{formatDate(r.issuedOn, locale)}</TableCell>
                  <TableCell>{r.dueOn ? formatDate(r.dueOn, locale) : "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(r.amountDueCents)}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.daysOverdue > 0 ? <Badge variant="warning">{count(r.daysOverdue)}</Badge> : count(0)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Section>

      <Section
        title={l("table_failed")}
        description={l("past_due", { count: count(data.failedPayments.pastDueMemberships) })}
        actions={
          <CsvLink
            text={l("csv")}
            href={csvHref(
              ["failed_at", "provider", "method", "status", "amount_eur", "reason", "order_id"],
              data.failedPayments.rows.map((r) => [r.failedAt.toISOString(), r.provider, r.method, r.status, euros(r.amountCents), r.reason, r.orderId]),
            )}
            file={file("failed-payments")}
            label={l("csv_label", { table: l("table_failed") })}
          />
        }
      >
        <Table data-testid="table-failed-payments">
          <TableCaption>{l("table_failed_caption")}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{l("col_failed_at")}</TableHead>
              <TableHead scope="col">{l("col_provider")}</TableHead>
              <TableHead scope="col">{l("col_method")}</TableHead>
              <TableHead scope="col">{l("col_status")}</TableHead>
              <TableHead scope="col" className="text-right">{l("col_amount")}</TableHead>
              <TableHead scope="col">{l("col_reason")}</TableHead>
              <TableHead scope="col">{l("col_order")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.failedPayments.rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-muted-foreground">{l("empty_table")}</TableCell>
              </TableRow>
            ) : (
              data.failedPayments.rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>{formatDateTime(r.failedAt, locale)}</TableCell>
                  <TableCell>{r.provider}</TableCell>
                  <TableCell>{r.method ? methodLabel(labels, r.method) : "—"}</TableCell>
                  <TableCell>
                    <Badge variant={r.status === "failed" ? "destructive" : "secondary"}>{l(`status_${r.status}`)}</Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{money(r.amountCents)}</TableCell>
                  <TableCell>{r.reason ?? "—"}</TableCell>
                  <TableCell>
                    <Link href={`/admin/orders/${r.orderId}`} className="underline-offset-4 hover:underline">
                      {l("open_order")}
                    </Link>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Section>

      <Section
        title={l("table_recurring")}
        actions={
          <CsvLink
            text={l("csv")}
            href={csvHref(["month", "invoices", "net_eur", "gross_eur"], data.recurring.months.map((m) => [m.month, m.invoiceCount, euros(m.netCents), euros(m.grossCents)]))}
            file={file("recurring")}
            label={l("csv_label", { table: l("table_recurring") })}
          />
        }
      >
        <Table data-testid="table-recurring">
          <TableCaption>{l("table_recurring_caption")}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{l("col_month")}</TableHead>
              <TableHead scope="col" className="text-right">{l("col_invoices")}</TableHead>
              <TableHead scope="col" className="text-right">{l("col_net")}</TableHead>
              <TableHead scope="col" className="text-right">{l("col_gross")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.recurring.months.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="text-muted-foreground">{l("empty_table")}</TableCell>
              </TableRow>
            ) : (
              data.recurring.months.map((m) => (
                <TableRow key={m.month}>
                  <TableCell>{bucketLabel(m.month, "month", locale)}</TableCell>
                  <TableCell className="text-right tabular-nums">{count(m.invoiceCount)}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(m.netCents)}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(m.grossCents)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Section>
    </div>
  );
}
