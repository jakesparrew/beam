import Link from "next/link";
import { notFound } from "next/navigation";
import { Button, cn, EmptyState, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { formatPercent } from "@beam/core/i18n";
import { flag } from "@/lib/flags";
import { translator } from "@/lib/i18n";
import { CAPACITY_GROUPS, parseGroupBy, type CapacityRow } from "@/modules/ops/reports/capacity";
import { staffReadCtx } from "@/modules/ops/reports/queries";
import { getCapacityReport } from "@/modules/ops/retention/queries";

/**
 * `/admin/reports/capacity` (ops spec 5; `reports.read`, behind `ff_ops_retention`): utilisation
 * and attendance from booking's `v_session_utilisation`, grouped by session type, weekday, start
 * hour or month (`?groupBy=`), for the `?from=&to=` dates (default the past 90 and next 90 days).
 */
export const dynamic = "force-dynamic";

const BASE = "/admin/reports/capacity";

export default async function CapacityReportPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string; groupBy?: string }> }) {
  const ctx = await staffReadCtx({ permission: "reports.read" });
  if (!(await flag("ff_ops_retention", ctx.actor))) notFound();
  const sp = await searchParams;
  const tr = translator(ctx.locale);
  const groupBy = parseGroupBy(sp.groupBy);
  const r = await getCapacityReport(ctx, { from: sp.from, to: sp.to, groupBy });
  const query = new URLSearchParams({ ...r.range, groupBy }).toString();

  const label = (row: CapacityRow): string => {
    if (groupBy === "template") return row.name ? (row.name[ctx.locale] ?? row.name.en ?? row.key) : tr("ops.reports.capacity.no_template");
    if (groupBy === "weekday") return tr(`ops.common.weekday.${row.key}`);
    if (groupBy === "hour") return tr("ops.reports.capacity.hour", { hour: row.key });
    return row.key;
  };
  const pct = (v: number | null) => (v === null ? "-" : formatPercent(v, ctx.locale));

  return (
    <div className="grid gap-6" data-testid="capacity-report">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{tr("ops.reports.capacity.title")}</h1>
        <a href={`${BASE}/csv?${query}`} className="text-sm font-medium underline-offset-4 hover:underline" download>
          {tr("ops.common.download_csv")}
        </a>
      </div>
      <p className="text-sm text-muted-foreground">{tr("ops.reports.capacity.intro")}</p>

      <form method="get" action={BASE} className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="groupBy" value={groupBy} />
        <label className="grid gap-1 text-sm">
          {tr("ops.common.from")}
          <input type="date" name="from" defaultValue={r.range.from} className="rounded-md border bg-background px-2 py-1" />
        </label>
        <label className="grid gap-1 text-sm">
          {tr("ops.common.to")}
          <input type="date" name="to" defaultValue={r.range.to} className="rounded-md border bg-background px-2 py-1" />
        </label>
        <Button type="submit" variant="outline" size="sm">
          {tr("ops.common.apply")}
        </Button>
      </form>

      <nav aria-label={tr("ops.reports.capacity.group_by")} className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">{tr("ops.reports.capacity.group_by")}</span>
        {CAPACITY_GROUPS.map((g) => (
          <Link
            key={g}
            href={{ pathname: BASE, query: { ...r.range, groupBy: g } }}
            aria-current={g === groupBy ? "page" : undefined}
            className={cn(
              "rounded-md border px-3 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
              g === groupBy ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted",
            )}
          >
            {tr(`ops.reports.capacity.group.${g}`)}
          </Link>
        ))}
      </nav>

      {r.rows.length === 0 ? (
        <EmptyState title={tr("ops.reports.capacity.empty")} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{tr(`ops.reports.capacity.group.${groupBy}`)}</TableHead>
              <TableHead className="text-right">{tr("ops.reports.capacity.column.sessions")}</TableHead>
              <TableHead className="text-right">{tr("ops.reports.capacity.column.capacity")}</TableHead>
              <TableHead className="text-right">{tr("ops.reports.capacity.column.booked")}</TableHead>
              <TableHead className="text-right">{tr("ops.reports.capacity.column.attended")}</TableHead>
              <TableHead className="text-right">{tr("ops.reports.capacity.column.no_shows")}</TableHead>
              <TableHead className="text-right">{tr("ops.reports.capacity.column.cancellations")}</TableHead>
              <TableHead className="text-right">{tr("ops.reports.capacity.column.waitlist_peak")}</TableHead>
              <TableHead className="text-right">{tr("ops.reports.capacity.column.utilisation")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {[...r.rows.map((row) => ({ key: row.key, label: label(row), f: row })), { key: "__total", label: tr("ops.reports.capacity.total"), f: r.total }].map(({ key, label: text, f }) => (
              <TableRow key={key} className={key === "__total" ? "font-semibold" : undefined}>
                <TableCell>{text}</TableCell>
                <TableCell className="text-right tabular-nums">{f.sessions}</TableCell>
                <TableCell className="text-right tabular-nums">{f.capacity}</TableCell>
                <TableCell className="text-right tabular-nums">{f.bookedTotal}</TableCell>
                <TableCell className="text-right tabular-nums">{f.attended}</TableCell>
                <TableCell className="text-right tabular-nums">{f.noShows}</TableCell>
                <TableCell className="text-right tabular-nums">{f.cancellations + f.lateCancellations}</TableCell>
                <TableCell className="text-right tabular-nums">{f.waitlistPeak}</TableCell>
                <TableCell className="text-right tabular-nums">{pct(f.utilisationPct)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
