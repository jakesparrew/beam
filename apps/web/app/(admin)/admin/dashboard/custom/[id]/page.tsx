import Link from "next/link";
import { notFound } from "next/navigation";
import { Alert, AlertDescription } from "@beam/ui";
import { formatMoney, formatNumber, formatPercent, type Locale } from "@beam/core/i18n";
import { flag } from "@/lib/flags";
import { translator } from "@/lib/i18n";
import { getSegmentRef } from "@/modules/crm/api";
import { evaluateDashboard, getDashboard, getDashboardEditor, kpiCatalogue, type KpiValue, type WidgetResult } from "@/modules/ops/insights/queries";
import { staffReadCtx } from "@/modules/ops/reports/queries";
import { WidgetGrid, type WidgetView } from "@/modules/ops/ui/WidgetGrid";
import { WidgetPicker } from "@/modules/ops/ui/WidgetPicker";

/**
 * `/admin/dashboard/custom/[id]` (ops spec 5, rule 79; `reports.read`, behind `ff_ops_ai`): the
 * widget grid of one own or shared dashboard, evaluated now. The owner and holders of
 * `dashboards.manage` see "Edit" (the widget picker) and "Delete"; everyone else reads it.
 */
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function formatter(unit: KpiValue["unit"], locale: Locale): (n: number | null) => string {
  if (unit === "cents") return (n) => (n === null ? "-" : formatMoney(n, locale));
  if (unit === "pct") return (n) => (n === null ? "-" : formatPercent(n * 100, locale));
  return (n) => (n === null ? "-" : formatNumber(n, locale));
}

export default async function CustomDashboardPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await staffReadCtx({ permission: "reports.read" });
  if (!(await flag("ff_ops_ai", ctx.actor))) notFound();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const tr = translator(ctx.locale);
  const dashboard = await getDashboard(ctx, id).catch((e: unknown) => {
    if ((e as { code?: string } | null)?.code === "not_found") notFound();
    throw e;
  });
  const results = await evaluateDashboard(ctx, dashboard.definition, ctx.now);
  const editor = dashboard.canEdit ? await getDashboardEditor(ctx) : null;
  const segmentNames = new Map<string, string>();
  for (const w of dashboard.definition.widgets) {
    if (w.segmentId && !segmentNames.has(w.segmentId)) segmentNames.set(w.segmentId, (await getSegmentRef(ctx.tx, w.segmentId))?.name ?? "-");
  }

  const byId = new Map<string, WidgetResult>(results.map((r) => [r.widgetId, r]));
  const snapshots = new Set(kpiCatalogue(ctx.actor).filter((k) => k.snapshot).map((k) => k.key as string));
  const views: WidgetView[] = dashboard.definition.widgets.map((w) => {
    const r = byId.get(w.id);
    const v = r?.value ?? null;
    const note = [snapshots.has(w.kpi) ? tr("ops.custom.snapshot") : tr(`ops.period.${w.period}`), w.segmentId ? segmentNames.get(w.segmentId) : null].filter(Boolean).join(" · ");
    const title = tr(`ops.kpi.${w.kpi}`);
    if (!v) {
      return { id: w.id, title, viz: w.viz, note, error: tr(r?.error === "forbidden" ? "ops.custom.widget.forbidden" : "ops.custom.widget.error"), value: null, raw: null, previous: null, previousRaw: null, change: null };
    }
    const fmt = formatter(v.unit, ctx.locale);
    return {
      id: w.id,
      title,
      viz: w.viz,
      note,
      error: null,
      value: fmt(v.current),
      raw: v.current,
      previous: v.previous === null ? null : `${tr("ops.period.previous")}: ${fmt(v.previous)}`,
      previousRaw: v.previous,
      change:
        v.change === null
          ? null
          : { change: v.change, changePct: v.changePct, formattedChange: fmt(Math.abs(v.change)), blankLabel: tr("ops.period.change_blank"), label: tr("ops.period.change") },
      ...(v.breakdown
        ? {
            rows: v.breakdown.map((b) => ({
              key: b.key,
              label: b.label.startsWith("ops.") || b.label.startsWith("forms.") ? tr(b.label) : b.label,
              value: fmt(b.current),
              raw: b.current,
              previous: b.previous === null ? null : fmt(b.previous),
            })),
          }
        : {}),
      ...(v.series ? { series: v.series } : {}),
    };
  });

  return (
    <div className="grid gap-6" data-testid="custom-dashboard">
      <div className="grid gap-2">
        <Link href="/admin/dashboard/custom" className="text-sm underline-offset-4 hover:underline">
          {tr("ops.custom.back")}
        </Link>
        <h1 className="text-2xl font-semibold">{dashboard.name}</h1>
      </div>
      {editor ? (
        <WidgetPicker
          mode="edit"
          dashboardId={dashboard.id}
          initial={{ name: dashboard.name, isShared: dashboard.isShared, widgets: dashboard.definition.widgets }}
          catalogue={editor.catalogue}
          periods={editor.periods}
          vizLabels={editor.vizLabels}
          segments={editor.segments}
          labels={editor.labels}
          canDelete
        />
      ) : (
        <Alert data-testid="dashboard-read-only">
          <AlertDescription>{tr("ops.custom.read_only")}</AlertDescription>
        </Alert>
      )}
      <WidgetGrid
        widgets={views}
        locale={ctx.locale}
        labels={{
          item: tr("ops.custom.column_item"),
          value: tr("ops.custom.column_value"),
          previous: tr("ops.custom.column_previous"),
          current: tr("ops.custom.column_value"),
          empty: tr("ops.custom.no_widgets"),
        }}
      />
    </div>
  );
}
