import type { Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Button, EmptyState, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { formatDateTime, formatMoney, formatPercent, type Locale } from "@beam/core/i18n";
import { flag } from "@/lib/flags";
import { translator } from "@/lib/i18n";
import { staffReadCtx } from "@/modules/ops/reports/queries";
import { getAbandonedCheckoutReport } from "@/modules/ops/retention/queries";

/**
 * `/admin/reports/abandoned-checkouts` (ops spec 5, rule 40; `reports.read`, behind
 * `ff_ops_retention`): abandoned, recovered, recovery rate, recovery revenue and failure share of
 * the `?from=&to=` dates (default the last 30 days), and the table of checkouts with items, value,
 * the recovery reminder's status and the outcome. Guests show as "Guest", never by address.
 */
export const dynamic = "force-dynamic";

const BASE = "/admin/reports/abandoned-checkouts";

const pct = (v: number | null, locale: Locale) => (v === null ? "-" : formatPercent(v * 100, locale));

export default async function AbandonedCheckoutsPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const ctx = await staffReadCtx({ permission: "reports.read" });
  if (!(await flag("ff_ops_retention", ctx.actor))) notFound();
  const sp = await searchParams;
  const tr = translator(ctx.locale);
  const r = await getAbandonedCheckoutReport(ctx, { from: sp.from, to: sp.to });
  const money = (c: number) => formatMoney(c, ctx.locale);
  const query = new URLSearchParams(r.range).toString();

  return (
    <div className="grid gap-6" data-testid="abandoned-report">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{tr("ops.reports.abandoned.title")}</h1>
        <a href={`${BASE}/csv?${query}`} className="text-sm font-medium underline-offset-4 hover:underline" download>
          {tr("ops.common.download_csv")}
        </a>
      </div>
      <form method="get" action={BASE} className="flex flex-wrap items-end gap-3">
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

      {r.abandoned === 0 ? (
        <EmptyState title={tr("ops.reports.abandoned.empty")} />
      ) : (
        <>
          <section className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6" aria-label={tr("ops.reports.abandoned.title")}>
            <Tile label={tr("ops.reports.abandoned.abandoned")} value={String(r.abandoned)} />
            <Tile label={tr("ops.reports.abandoned.abandoned_value")} value={money(r.abandonedValueCents)} />
            <Tile label={tr("ops.reports.abandoned.recovered")} value={String(r.recovered)} />
            <Tile label={tr("ops.reports.abandoned.rate")} value={pct(r.recoveryRate, ctx.locale)} />
            <Tile label={tr("ops.reports.abandoned.revenue")} value={money(r.recoveryRevenueCents)} />
            <Tile label={tr("ops.reports.abandoned.failure_share")} value={pct(r.failureShare, ctx.locale)} />
          </section>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tr("ops.reports.abandoned.column.abandoned_at")}</TableHead>
                <TableHead>{tr("ops.reports.abandoned.column.person")}</TableHead>
                <TableHead>{tr("ops.reports.abandoned.column.reason")}</TableHead>
                <TableHead className="text-right">{tr("ops.reports.abandoned.column.items")}</TableHead>
                <TableHead className="text-right">{tr("ops.reports.abandoned.column.value")}</TableHead>
                <TableHead>{tr("ops.reports.abandoned.column.recovery")}</TableHead>
                <TableHead>{tr("ops.reports.abandoned.column.outcome")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {r.rows.map((c) => (
                <TableRow key={c.checkoutId}>
                  <TableCell>{formatDateTime(c.abandonedAt, ctx.locale)}</TableCell>
                  <TableCell>
                    {c.personId ? (
                      <Link href={`/admin/persons/${c.personId}` as Route} className="font-medium underline-offset-4 hover:underline">
                        {c.name ?? "-"}
                      </Link>
                    ) : (
                      tr("ops.reports.abandoned.guest")
                    )}
                  </TableCell>
                  <TableCell>{c.abandonedReason ? tr(`ops.reports.abandoned.reason.${c.abandonedReason}`) : "-"}</TableCell>
                  <TableCell className="text-right tabular-nums">{c.itemCount}</TableCell>
                  <TableCell className="text-right tabular-nums">{c.valueCents === null ? "-" : money(c.valueCents)}</TableCell>
                  <TableCell>{c.recoveryStatus ?? tr("ops.reports.abandoned.no_reminder")}</TableCell>
                  <TableCell>
                    {c.outcome === "recovered"
                      ? tr("ops.reports.abandoned.outcome.recovered", { amount: money(c.recoveredRevenueCents ?? 0) })
                      : tr("ops.reports.abandoned.outcome.open")}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1 rounded-lg border p-3">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-xl font-semibold tabular-nums">{value}</span>
    </div>
  );
}
