import { notFound } from "next/navigation";
import { Button, EmptyState, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { formatMoney, formatNumber, formatPercent, type Locale } from "@beam/core/i18n";
import { flag } from "@/lib/flags";
import { translator } from "@/lib/i18n";
import { emailRates } from "@/modules/ops/marketing/email-summary";
import { CONVERSION_WINDOWS, kpiRowsOf, REGISTRANT_SEGMENTS, type KpiTileRow } from "@/modules/ops/marketing/kpis-marketing";
import { getMarketingDashboard } from "@/modules/ops/marketing/queries";
import { staffReadCtx } from "@/modules/ops/reports/queries";

/**
 * `/admin/reports/marketing` (ops spec 5, rule 75; `reports.read`, behind `ff_ops_marketing`):
 * the marketing KPIs of the `?from=&to=` dates (default the last 30 days) against the same
 * number of days before, the leads by source and campaign, webinar conversion by registrant
 * status, the email performance per campaign and the webinar performance per webinar. The CSV
 * has every table on the page.
 */
export const dynamic = "force-dynamic";

const BASE = "/admin/reports/marketing";

export default async function MarketingReportPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const ctx = await staffReadCtx({ permission: "reports.read" });
  if (!(await flag("ff_ops_marketing", ctx.actor))) notFound();
  const sp = await searchParams;
  const tr = translator(ctx.locale);
  const d = await getMarketingDashboard(ctx, { from: sp.from, to: sp.to });
  const query = new URLSearchParams(d.range).toString();
  const pct = (v: number | null) => (v === null ? "-" : formatPercent(v * 100, ctx.locale));
  const fmt = (r: KpiTileRow, v: number | null) => (v === null ? "-" : r.unit === "pct" ? pct(v) : r.unit === "cents" ? formatMoney(Math.round(v), ctx.locale) : formatNumber(v, ctx.locale));
  const c = d.kpis.current;

  return (
    <div className="grid gap-6" data-testid="marketing-report">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{tr("ops.marketing.title")}</h1>
        <a href={`${BASE}/csv?${query}`} className="text-sm font-medium underline-offset-4 hover:underline" download>
          {tr("ops.common.download_csv")}
        </a>
      </div>
      <p className="text-sm text-muted-foreground">{tr("ops.marketing.intro")}</p>
      <RangeForm action={BASE} from={d.range.from} to={d.range.to} tr={tr} />

      {d.empty ? (
        <EmptyState title={tr("ops.marketing.empty")} />
      ) : (
        <>
          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label={tr("ops.marketing.title")} data-testid="marketing-kpis">
            {kpiRowsOf(d.kpis).map((r) => (
              <div key={r.key} className="grid gap-1 rounded-lg border p-3" data-testid={`marketing-kpi-${r.key}`} data-value={r.current ?? ""}>
                <span className="text-sm text-muted-foreground">{tr(`ops.marketing.kpi.${r.key}`)}</span>
                <span className="text-xl font-semibold tabular-nums">{fmt(r, r.current)}</span>
                <span className="text-sm text-muted-foreground">{tr("ops.marketing.previous", { value: fmt(r, r.previous) })}</span>
              </div>
            ))}
          </section>
          {c.attendance.nativeRate === null ? <p className="text-sm text-muted-foreground">{tr("ops.marketing.attendance_native_unavailable")}</p> : null}

          <section className="grid gap-2">
            <h2 className="text-lg font-semibold">{tr("ops.marketing.leads_by_source")}</h2>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{tr("ops.marketing.column.source")}</TableHead>
                  <TableHead>{tr("ops.marketing.column.campaign")}</TableHead>
                  <TableHead className="text-right">{tr("ops.marketing.column.leads")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {c.leadsBySource.slice(0, 50).map((l) => (
                  <TableRow key={`${l.source}|${l.campaign ?? ""}`}>
                    <TableCell>{l.source}</TableCell>
                    <TableCell>{l.campaign ?? tr("ops.marketing.no_campaign")}</TableCell>
                    <TableCell className="text-right tabular-nums">{l.leads}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </section>

          <section className="grid gap-2">
            <h2 className="text-lg font-semibold">{tr("ops.marketing.conversion.title")}</h2>
            <p className="text-sm text-muted-foreground">{tr("ops.marketing.conversion.help")}</p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{tr("ops.marketing.conversion.segment")}</TableHead>
                  {CONVERSION_WINDOWS.map((w) => (
                    <TableHead key={w} className="text-right">
                      {tr("ops.marketing.conversion.window", { days: w })}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {REGISTRANT_SEGMENTS.map((s) => (
                  <TableRow key={s}>
                    <TableCell>{tr(`ops.marketing.segment.${s}`)}</TableCell>
                    {CONVERSION_WINDOWS.map((w) => {
                      const r = c.webinarConversion[s][`d${w}`];
                      return (
                        <TableCell key={w} className="text-right tabular-nums">
                          {pct(r.rate)} {r.denominator > 0 ? `(${r.numerator}/${r.denominator})` : ""}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </section>

          <EmailTable d={d} tr={tr} pct={pct} />
          <WebinarTable d={d} tr={tr} locale={ctx.locale} />
        </>
      )}
    </div>
  );
}

type Tr = ReturnType<typeof translator>;
type Dashboard = Awaited<ReturnType<typeof getMarketingDashboard>>;

function EmailTable({ d, tr, pct }: { d: Dashboard; tr: Tr; pct: (v: number | null) => string }) {
  const rows = [...d.email.campaigns.map((c) => ({ ...c, key: c.campaignId })), { key: "total", name: tr("ops.marketing.email.total"), ...d.email.total, ...emailRates(d.email.total) }];
  return (
    <section className="grid gap-2" data-testid="marketing-email">
      <h2 className="text-lg font-semibold">{tr("ops.marketing.email.title")}</h2>
      {d.email.total.sent === 0 ? (
        <p className="text-sm text-muted-foreground">{tr("ops.marketing.email.empty")}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{tr("ops.marketing.email.column.campaign")}</TableHead>
              <TableHead className="text-right">{tr("ops.marketing.email.column.sent")}</TableHead>
              <TableHead className="text-right">{tr("ops.marketing.email.column.delivered")}</TableHead>
              <TableHead className="text-right">{tr("ops.marketing.email.column.open_rate")}</TableHead>
              <TableHead className="text-right">{tr("ops.marketing.email.column.click_rate")}</TableHead>
              <TableHead className="text-right">{tr("ops.marketing.email.column.bounce_rate")}</TableHead>
              <TableHead className="text-right">{tr("ops.marketing.email.column.complaint_rate")}</TableHead>
              <TableHead className="text-right">{tr("ops.marketing.email.column.unsubscribe_rate")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.key} className={r.key === "total" ? "font-semibold" : undefined}>
                <TableCell>{r.name}</TableCell>
                <TableCell className="text-right tabular-nums">{r.sent}</TableCell>
                <TableCell className="text-right tabular-nums">{r.delivered}</TableCell>
                <TableCell className="text-right tabular-nums">{pct(r.openRate)}</TableCell>
                <TableCell className="text-right tabular-nums">{pct(r.clickRate)}</TableCell>
                <TableCell className="text-right tabular-nums">{pct(r.bounceRate)}</TableCell>
                <TableCell className="text-right tabular-nums">{pct(r.complaintRate)}</TableCell>
                <TableCell className="text-right tabular-nums">{pct(r.unsubscribeRate)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

function WebinarTable({ d, tr, locale }: { d: Dashboard; tr: Tr; locale: Locale }) {
  const minutes = (sec: number | null) => (sec === null ? "-" : tr("ops.marketing.minutes", { minutes: Math.round(sec / 60) }));
  const rows = [...d.webinars.webinars.map((w) => ({ key: w.webinarId, name: w.title[locale] ?? w.title.en ?? w.slug, ...w })), { key: "total", name: tr("ops.marketing.webinar.total"), ...d.webinars.total }];
  return (
    <section className="grid gap-2" data-testid="marketing-webinars">
      <h2 className="text-lg font-semibold">{tr("ops.marketing.webinar.title")}</h2>
      {d.webinars.total.registered === 0 ? (
        <p className="text-sm text-muted-foreground">{tr("ops.marketing.webinar.empty")}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{tr("ops.marketing.webinar.column.webinar")}</TableHead>
              <TableHead className="text-right">{tr("ops.marketing.webinar.column.registered")}</TableHead>
              <TableHead className="text-right">{tr("ops.marketing.webinar.column.attended_live")}</TableHead>
              <TableHead className="text-right">{tr("ops.marketing.webinar.column.avg_watch")}</TableHead>
              <TableHead className="text-right">{tr("ops.marketing.webinar.column.replay_views")}</TableHead>
              <TableHead className="text-right">{tr("ops.marketing.webinar.column.on_demand_views")}</TableHead>
              <TableHead className="text-right">{tr("ops.marketing.webinar.column.poll_answers")}</TableHead>
              <TableHead className="text-right">{tr("ops.marketing.webinar.column.cta_clicks")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.key} className={r.key === "total" ? "font-semibold" : undefined}>
                <TableCell>{r.name}</TableCell>
                <TableCell className="text-right tabular-nums">{r.registered}</TableCell>
                <TableCell className="text-right tabular-nums">{r.attendedLive}</TableCell>
                <TableCell className="text-right tabular-nums">{minutes(r.avgWatchSec)}</TableCell>
                <TableCell className="text-right tabular-nums">{r.replayViews}</TableCell>
                <TableCell className="text-right tabular-nums">{r.onDemandViews}</TableCell>
                <TableCell className="text-right tabular-nums">{r.pollAnswers}</TableCell>
                <TableCell className="text-right tabular-nums">{r.ctaClicks}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

function RangeForm({ action, from, to, tr }: { action: string; from: string; to: string; tr: Tr }) {
  return (
    <form method="get" action={action} className="flex flex-wrap items-end gap-3">
      <label className="grid gap-1 text-sm">
        {tr("ops.common.from")}
        <input type="date" name="from" defaultValue={from} className="rounded-md border bg-background px-2 py-1" />
      </label>
      <label className="grid gap-1 text-sm">
        {tr("ops.common.to")}
        <input type="date" name="to" defaultValue={to} className="rounded-md border bg-background px-2 py-1" />
      </label>
      <Button type="submit" variant="outline" size="sm">
        {tr("ops.common.apply")}
      </Button>
    </form>
  );
}
