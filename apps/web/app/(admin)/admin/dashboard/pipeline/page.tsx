import type { Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Button } from "@beam/ui";
import { formatDate, formatMoney } from "@beam/core/i18n";
import { B2C_STAGES } from "@beam/core/ops";
import { flag } from "@/lib/flags";
import { translator } from "@/lib/i18n";
import { staffReadCtx } from "@/modules/ops/reports/queries";
import { getPipelineBoard } from "@/modules/ops/retention/queries";

/**
 * `/admin/dashboard/pipeline` (ops spec 5, rule 14a; `reports.read`, behind `ff_ops_retention`):
 * the B2C board, one column per `b2c_stage` with its count and the 50 most recent changes; the
 * `member` column reads "Member / high value" and high-value people of other stages carry a
 * badge. Filters: source, campaign and high value (`?source=&campaign=&hv=1`); `?stage=` with
 * `?page=` pages through one stage.
 */
export const dynamic = "force-dynamic";

const BASE = "/admin/dashboard/pipeline";

export default async function PipelinePage({ searchParams }: { searchParams: Promise<{ stage?: string; page?: string; source?: string; campaign?: string; hv?: string }> }) {
  const ctx = await staffReadCtx({ permission: "reports.read" });
  if (!(await flag("ff_ops_retention", ctx.actor))) notFound();
  const sp = await searchParams;
  const tr = translator(ctx.locale);
  const stage = B2C_STAGES.find((s) => s === sp.stage);
  const page = Math.max(1, Number(sp.page ?? 1) || 1);
  const board = await getPipelineBoard(ctx, {
    ...(stage ? { stage } : {}),
    page,
    ...(sp.source ? { source: sp.source } : {}),
    ...(sp.campaign ? { campaign: sp.campaign } : {}),
    ...(sp.hv === "1" ? { highValue: true } : {}),
  });
  const keep = { ...(sp.source ? { source: sp.source } : {}), ...(sp.campaign ? { campaign: sp.campaign } : {}), ...(sp.hv === "1" ? { hv: "1" } : {}) };
  const columns = stage ? board.columns.filter((c) => c.stage === stage) : board.columns;

  return (
    <div className="grid gap-6" data-testid="pipeline-page">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold">{tr("ops.pipeline.title")}</h1>
        <p className="text-sm text-muted-foreground">{tr("ops.pipeline.intro")}</p>
      </div>

      <form method="get" action={BASE} className="flex flex-wrap items-end gap-3">
        {stage ? <input type="hidden" name="stage" value={stage} /> : null}
        <label className="grid gap-1 text-sm">
          {tr("ops.pipeline.filter.source")}
          <input name="source" defaultValue={sp.source ?? ""} maxLength={80} className="rounded-md border bg-background px-2 py-1" />
        </label>
        <label className="grid gap-1 text-sm">
          {tr("ops.pipeline.filter.campaign")}
          <input name="campaign" defaultValue={sp.campaign ?? ""} maxLength={120} className="rounded-md border bg-background px-2 py-1" />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="hv" value="1" defaultChecked={sp.hv === "1"} />
          {tr("ops.pipeline.filter.high_value")}
        </label>
        <Button type="submit" variant="outline" size="sm">
          {tr("ops.common.apply")}
        </Button>
        <Link href={stage ? { pathname: BASE, query: { stage } } : BASE} className="text-sm underline-offset-4 hover:underline">
          {tr("ops.common.clear")}
        </Link>
      </form>

      {stage ? (
        <Link href={{ pathname: BASE, query: keep }} className="text-sm underline-offset-4 hover:underline">
          {tr("ops.pipeline.back")}
        </Link>
      ) : null}

      <div className={stage ? "grid gap-4" : "grid gap-4 md:grid-cols-2 xl:grid-cols-5"}>
        {columns.map((col) => (
          <section key={col.stage} className="grid content-start gap-2 rounded-lg border p-3" data-testid={`pipeline-stage-${col.stage}`} aria-labelledby={`stage-${col.stage}`}>
            <header className="grid gap-0.5">
              <h2 id={`stage-${col.stage}`} className="font-semibold">
                {tr(`ops.stage.${col.stage}`)}
              </h2>
              <p className="text-sm text-muted-foreground">
                {tr("ops.dashboard.count", { count: col.count })}
                {col.highValueCount ? ` · ${tr("ops.pipeline.high_value_count", { count: col.highValueCount })}` : null}
              </p>
            </header>
            {col.people.length === 0 ? (
              <p className="text-sm text-muted-foreground">{tr("ops.pipeline.empty")}</p>
            ) : (
              <ul className="grid gap-1.5">
                {col.people.map((p) => (
                  <li key={p.personId} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                    <Link href={`/admin/persons/${p.personId}` as Route} className="font-medium underline-offset-4 hover:underline">
                      {p.name ?? "-"}
                    </Link>
                    <span className="flex items-center gap-1.5 text-muted-foreground">
                      {p.isHighValue && col.stage !== "member" ? <Badge variant="warning">{tr("ops.pipeline.high_value")}</Badge> : null}
                      {p.revenueCents ? <span className="tabular-nums">{formatMoney(p.revenueCents, ctx.locale)}</span> : null}
                      {p.stageChangedAt ? <span>{tr("ops.pipeline.changed", { date: formatDate(p.stageChangedAt, ctx.locale) })}</span> : null}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {!stage && col.count > col.people.length ? (
              <Link href={{ pathname: BASE, query: { ...keep, stage: col.stage } }} className="text-sm underline-offset-4 hover:underline">
                {tr("ops.pipeline.show_all")}
              </Link>
            ) : null}
            {stage && col.count > board.pageSize ? (
              <nav className="flex items-center gap-3 text-sm" aria-label={tr("ops.common.page", { page })}>
                {page > 1 ? <Link href={{ pathname: BASE, query: { ...keep, stage, page: String(page - 1) } }}>{tr("ops.common.previous_page")}</Link> : null}
                <span>{tr("ops.common.page", { page })}</span>
                {page * board.pageSize < col.count ? <Link href={{ pathname: BASE, query: { ...keep, stage, page: String(page + 1) } }}>{tr("ops.common.next_page")}</Link> : null}
              </nav>
            ) : null}
          </section>
        ))}
      </div>
    </div>
  );
}
