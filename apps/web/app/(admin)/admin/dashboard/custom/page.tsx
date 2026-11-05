import type { Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Card, CardContent, CardHeader, CardTitle, EmptyState } from "@beam/ui";
import { formatDate } from "@beam/core/i18n";
import { flag } from "@/lib/flags";
import { translator } from "@/lib/i18n";
import { getDashboardEditor, listDashboards } from "@/modules/ops/insights/queries";
import { staffReadCtx } from "@/modules/ops/reports/queries";
import { WidgetPicker } from "@/modules/ops/ui/WidgetPicker";

/**
 * `/admin/dashboard/custom` (ops spec 5, rule 79; `reports.read`, behind `ff_ops_ai`): the
 * user's own dashboards and the shared ones of colleagues, and "New dashboard" (the widget
 * picker over `KPI_REGISTRY`). Empty state "Create your first dashboard".
 */
export const dynamic = "force-dynamic";

export default async function CustomDashboardsPage() {
  const ctx = await staffReadCtx({ permission: "reports.read" });
  if (!(await flag("ff_ops_ai", ctx.actor))) notFound();
  const tr = translator(ctx.locale);
  const [list, editor] = await Promise.all([listDashboards(ctx), getDashboardEditor(ctx)]);
  const first = editor.catalogue.find((k) => k.key === "revenue_net") ?? editor.catalogue[0];

  return (
    <div className="grid gap-6" data-testid="custom-dashboards">
      <div className="grid gap-2">
        <h1 className="text-2xl font-semibold">{tr("ops.custom.title")}</h1>
        <p className="text-sm text-muted-foreground">{tr("ops.custom.intro")}</p>
      </div>

      <WidgetPicker
        mode="create"
        initial={{ name: tr("ops.custom.default_name"), isShared: false, widgets: first ? [{ id: "w1", kpi: first.key, period: "month", compare: true, viz: "number" }] : [] }}
        catalogue={editor.catalogue}
        periods={editor.periods}
        vizLabels={editor.vizLabels}
        segments={editor.segments}
        labels={editor.labels}
      />

      {list.length === 0 ? (
        <EmptyState title={tr("ops.custom.empty")} description={tr("ops.custom.intro")} />
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" data-testid="dashboard-list">
          {list.map((d) => (
            <li key={d.id}>
              <Card data-testid={`dashboard-${d.id}`}>
                <CardHeader>
                  <CardTitle className="text-base">
                    <Link href={`/admin/dashboard/custom/${d.id}` as Route} className="underline-offset-4 hover:underline">
                      {d.name}
                    </Link>
                  </CardTitle>
                </CardHeader>
                <CardContent className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                  {d.isOwn ? <Badge variant="secondary">{tr("ops.custom.badge_own")}</Badge> : null}
                  {d.isShared ? <Badge variant="outline">{tr("ops.custom.badge_shared")}</Badge> : null}
                  <span>{tr("ops.custom.widget_count", { count: d.widgetCount })}</span>
                  <span>{tr("ops.custom.updated", { date: formatDate(d.updatedAt, ctx.locale) })}</span>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
