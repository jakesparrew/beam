import type { Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Button, cn, EmptyState, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { formatDate, formatMoney, formatNumber, formatPercent } from "@beam/core/i18n";
import { flag } from "@/lib/flags";
import { translator } from "@/lib/i18n";
import { DIRECT_KEY, type AttributionModel, type AttributionReportRow } from "@/modules/ops/marketing/attribution";
import { FUNNEL_STEPS } from "@/modules/ops/marketing/funnel";
import { getAttributionReport, getCampaignFunnel } from "@/modules/ops/marketing/queries";
import { staffReadCtx } from "@/modules/ops/reports/queries";

/**
 * `/admin/reports/attribution` (ops spec 5, rules 72-73a; `reports.read`, behind
 * `ff_ops_marketing`): per campaign key (source and medium shown) the leads, first purchases,
 * revenue under the chosen model (`?model=linear|first_touch`), LTV, spend, cost per lead, CAC
 * and ROAS (always linear revenue / spend); the campaign funnel of rule 73a; the campaigns with
 * leads or revenue but no spend (edge case 19); and the ads data-as-of date (rule 74).
 */
export const dynamic = "force-dynamic";

const BASE = "/admin/reports/attribution";
const MODELS: readonly AttributionModel[] = ["linear", "first_touch"];

const pill = (active: boolean) =>
  cn("rounded-md border px-3 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring", active ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted");

export default async function AttributionReportPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string; model?: string }> }) {
  const ctx = await staffReadCtx({ permission: "reports.read" });
  if (!(await flag("ff_ops_marketing", ctx.actor))) notFound();
  const sp = await searchParams;
  const tr = translator(ctx.locale);
  const model: AttributionModel = sp.model === "first_touch" ? "first_touch" : "linear";
  const [report, funnel] = [await getAttributionReport(ctx, { from: sp.from, to: sp.to, model }), await getCampaignFunnel(ctx, { from: sp.from, to: sp.to })];
  const money = (c: number | null) => (c === null ? "-" : formatMoney(c, ctx.locale));
  const query = new URLSearchParams({ ...report.range, model }).toString();
  const campaignLabel = (r: { campaignKey: string; campaign: string | null }) => (r.campaignKey === DIRECT_KEY ? tr("ops.attribution.direct") : (r.campaign ?? r.campaignKey));
  const revenue = (r: AttributionReportRow) => (model === "linear" ? r.revenueLinearCents : r.revenueFirstTouchCents);
  const empty = report.rows.every((r) => r.revenueLinearCents === 0 && r.revenueFirstTouchCents === 0 && r.leads === 0 && r.spendCents === 0);

  return (
    <div className="grid gap-6" data-testid="attribution-report">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{tr("ops.attribution.title")}</h1>
        <a href={`${BASE}/csv?${query}`} className="text-sm font-medium underline-offset-4 hover:underline" download>
          {tr("ops.common.download_csv")}
        </a>
      </div>
      <p className="text-sm text-muted-foreground">{tr("ops.attribution.intro")}</p>
      <p className="text-sm" data-testid="attribution-data-as-of">
        {report.dataAsOf ? tr("ops.common.data_as_of", { date: formatDate(report.dataAsOf, ctx.locale) }) : tr("ops.attribution.data_as_of_none")}
      </p>
      <div className="flex flex-wrap items-end gap-6">
        <form method="get" action={BASE} className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="model" value={model} />
          <label className="grid gap-1 text-sm">
            {tr("ops.common.from")}
            <input type="date" name="from" defaultValue={report.range.from} className="rounded-md border bg-background px-2 py-1" />
          </label>
          <label className="grid gap-1 text-sm">
            {tr("ops.common.to")}
            <input type="date" name="to" defaultValue={report.range.to} className="rounded-md border bg-background px-2 py-1" />
          </label>
          <Button type="submit" variant="outline" size="sm">
            {tr("ops.common.apply")}
          </Button>
        </form>
        <nav aria-label={tr("ops.attribution.model.legend")} className="flex gap-2">
          {MODELS.map((m) => (
            <Link key={m} href={`${BASE}?${new URLSearchParams({ ...report.range, model: m }).toString()}` as Route} className={pill(m === model)} aria-current={m === model ? "page" : undefined}>
              {tr(`ops.attribution.model.${m}`)}
            </Link>
          ))}
        </nav>
      </div>

      {empty ? (
        <EmptyState title={tr("ops.attribution.empty")} />
      ) : (
        <>
          <section className="grid gap-2">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{tr("ops.attribution.column.campaign")}</TableHead>
                  <TableHead>{tr("ops.attribution.column.source")}</TableHead>
                  <TableHead>{tr("ops.attribution.column.medium")}</TableHead>
                  <TableHead className="text-right">{tr("ops.attribution.column.leads")}</TableHead>
                  <TableHead className="text-right">{tr("ops.attribution.column.first_purchases")}</TableHead>
                  <TableHead className="text-right">{tr(model === "linear" ? "ops.attribution.column.revenue_linear" : "ops.attribution.column.revenue_first_touch")}</TableHead>
                  <TableHead className="text-right">{tr("ops.attribution.column.ltv")}</TableHead>
                  <TableHead className="text-right">{tr("ops.attribution.column.spend")}</TableHead>
                  <TableHead className="text-right">{tr("ops.attribution.column.cpl")}</TableHead>
                  <TableHead className="text-right">{tr("ops.attribution.column.cac")}</TableHead>
                  <TableHead className="text-right">{tr("ops.attribution.column.roas")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.rows.slice(0, 50).map((r) => (
                  <TableRow key={r.campaignKey} data-testid="attribution-row" data-campaign-key={r.campaignKey}>
                    <TableCell>
                      <span className="font-medium">{campaignLabel(r)}</span>
                      {r.adName ? <span className="block text-xs text-muted-foreground">{r.adName}</span> : null}
                    </TableCell>
                    <TableCell>{r.source ?? "-"}</TableCell>
                    <TableCell>{r.medium ?? "-"}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.leads}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.firstPurchases}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(revenue(r))}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(r.ltvCents)}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(r.spendCents)}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(r.cplCents)}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(r.cacCents)}</TableCell>
                    <TableCell className="text-right tabular-nums" data-testid="attribution-roas" data-value={r.roas ?? ""}>
                      {r.roas === null ? "-" : `${formatNumber(r.roas, ctx.locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}×`}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </section>

          <section className="grid gap-2" data-testid="attribution-funnel">
            <h2 className="text-lg font-semibold">{tr("ops.attribution.funnel.title")}</h2>
            <p className="text-sm text-muted-foreground">{tr("ops.attribution.funnel.help")}</p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{tr("ops.attribution.column.campaign")}</TableHead>
                  <TableHead>{tr("ops.attribution.column.source")}</TableHead>
                  <TableHead>{tr("ops.attribution.column.medium")}</TableHead>
                  {FUNNEL_STEPS.map((s) => (
                    <TableHead key={s} className="text-right">
                      {tr(`ops.attribution.funnel.step.${s}`)}
                    </TableHead>
                  ))}
                  <TableHead className="text-right">{tr("ops.attribution.funnel.lead_cost")}</TableHead>
                  <TableHead className="text-right">{tr("ops.attribution.column.first_purchases")}</TableHead>
                  <TableHead className="text-right">{tr("ops.attribution.funnel.total_revenue")}</TableHead>
                  <TableHead className="text-right">{tr("ops.attribution.column.ltv")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {funnel.map((f) => (
                  <TableRow key={f.campaignKey} data-campaign-key={f.campaignKey}>
                    <TableCell>{campaignLabel(f)}</TableCell>
                    <TableCell>{f.source}</TableCell>
                    <TableCell>{f.medium ?? "-"}</TableCell>
                    {f.steps.map((s) => (
                      <TableCell key={s.step} className="text-right tabular-nums">
                        {s.count}
                        {s.step !== "lead" && s.share !== null ? ` (${formatPercent(s.share * 100, ctx.locale, 0)})` : ""}
                        {s.step !== "lead" && s.medianDays !== null ? <span className="block text-xs text-muted-foreground">{tr("ops.attribution.funnel.median", { days: s.medianDays })}</span> : null}
                      </TableCell>
                    ))}
                    <TableCell className="text-right tabular-nums">{money(f.leadCostCents)}</TableCell>
                    <TableCell className="text-right tabular-nums">{f.firstPurchases}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(f.revenueCents)}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(f.ltvCents)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </section>

          {report.withoutSpend.length > 0 ? (
            <section className="grid gap-2" data-testid="attribution-without-spend">
              <h2 className="text-lg font-semibold">{tr("ops.attribution.without_spend.title")}</h2>
              <p className="text-sm text-muted-foreground">{tr("ops.attribution.without_spend.help")}</p>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{tr("ops.attribution.column.campaign")}</TableHead>
                    <TableHead>{tr("ops.attribution.column.source")}</TableHead>
                    <TableHead className="text-right">{tr("ops.attribution.column.leads")}</TableHead>
                    <TableHead className="text-right">{tr("ops.attribution.column.revenue_linear")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.withoutSpend.slice(0, 50).map((r) => (
                    <TableRow key={r.campaignKey}>
                      <TableCell>{campaignLabel(r)}</TableCell>
                      <TableCell>{r.source ?? "-"}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.leads}</TableCell>
                      <TableCell className="text-right tabular-nums">{money(r.revenueLinearCents)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
