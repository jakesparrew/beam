import type { Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Button, EmptyState, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { formatMoney, formatPercent, type Locale } from "@beam/core/i18n";
import { flag } from "@/lib/flags";
import { translator } from "@/lib/i18n";
import { staffReadCtx } from "@/modules/ops/reports/queries";
import { getNoShowReport } from "@/modules/ops/retention/queries";

/**
 * `/admin/reports/no-shows` (ops spec 5, rule 39; `reports.read`, behind `ff_ops_retention`):
 * totals per status, the no-show rate, value and credits forfeited, the customers (patterns
 * flagged), the session types and the weekday x hour grid of the `?from=&to=` dates (default
 * the last 30 days). Sessions BEAM cancelled are shown apart. The CSV has the customer table.
 */
export const dynamic = "force-dynamic";

const BASE = "/admin/reports/no-shows";
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

const pct = (v: number | null, locale: Locale) => (v === null ? "-" : formatPercent(v * 100, locale));

export default async function NoShowReportPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const ctx = await staffReadCtx({ permission: "reports.read" });
  if (!(await flag("ff_ops_retention", ctx.actor))) notFound();
  const sp = await searchParams;
  const tr = translator(ctx.locale);
  const r = await getNoShowReport(ctx, { from: sp.from, to: sp.to });
  const money = (c: number) => formatMoney(c, ctx.locale);
  const query = new URLSearchParams(r.range).toString();
  const empty = r.totals.cancelled + r.totals.lateCancelled + r.totals.noShows === 0 && r.sessionCancelled.bookings === 0;
  const hours = [...new Set(r.byWeekdayHour.map((c) => c.hour))].sort((a, b) => a - b);
  const cell = (weekday: number, hour: number) => r.byWeekdayHour.find((c) => c.weekday === weekday && c.hour === hour);
  const maxCell = Math.max(1, ...r.byWeekdayHour.map((c) => c.noShows + c.lateCancelled));

  return (
    <div className="grid gap-6" data-testid="no-show-report">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{tr("ops.reports.no_shows.title")}</h1>
        <a href={`${BASE}/csv?${query}`} className="text-sm font-medium underline-offset-4 hover:underline" download>
          {tr("ops.common.download_csv")}
        </a>
      </div>
      <p className="text-sm text-muted-foreground">{tr("ops.reports.no_shows.intro")}</p>
      <RangeForm action={BASE} from={r.range.from} to={r.range.to} tr={tr} />

      {empty ? (
        <EmptyState title={tr("ops.reports.no_shows.empty")} />
      ) : (
        <>
          <section className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6" aria-label={tr("ops.reports.no_shows.title")}>
            <Tile label={tr("ops.reports.no_shows.status.cancelled")} value={String(r.totals.cancelled)} />
            <Tile label={tr("ops.reports.no_shows.status.late_cancelled")} value={String(r.totals.lateCancelled)} />
            <Tile label={tr("ops.reports.no_shows.status.no_show")} value={String(r.totals.noShows)} />
            <Tile label={tr("ops.reports.no_shows.rate")} value={pct(r.totals.rate, ctx.locale)} />
            <Tile label={tr("ops.reports.no_shows.value_forfeited")} value={money(r.totals.valueForfeitedCents)} />
            <Tile label={tr("ops.reports.no_shows.credits_forfeited")} value={String(r.totals.creditUnitsForfeited)} />
          </section>
          {r.sessionCancelled.bookings > 0 ? (
            <p className="text-sm" data-testid="no-show-session-cancelled">
              {tr("ops.reports.no_shows.session_cancelled", { bookings: r.sessionCancelled.bookings, sessions: r.sessionCancelled.sessions })}
            </p>
          ) : null}

          <section className="grid gap-2">
            <h2 className="text-lg font-semibold">{tr("ops.reports.no_shows.by_customer")}</h2>
            <p className="text-sm text-muted-foreground">{tr("ops.reports.no_shows.pattern_help", { count: r.pattern.count, days: r.pattern.days })}</p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{tr("ops.reports.no_shows.column.person")}</TableHead>
                  <TableHead className="text-right">{tr("ops.reports.no_shows.status.cancelled")}</TableHead>
                  <TableHead className="text-right">{tr("ops.reports.no_shows.status.late_cancelled")}</TableHead>
                  <TableHead className="text-right">{tr("ops.reports.no_shows.status.no_show")}</TableHead>
                  <TableHead className="text-right">{tr("ops.reports.no_shows.column.attended")}</TableHead>
                  <TableHead className="text-right">{tr("ops.reports.no_shows.rate")}</TableHead>
                  <TableHead className="text-right">{tr("ops.reports.no_shows.value_forfeited")}</TableHead>
                  <TableHead className="text-right">{tr("ops.reports.no_shows.column.recent", { days: r.pattern.days })}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {r.customers.map((c) => (
                  <TableRow key={c.personId}>
                    <TableCell>
                      <Link href={`/admin/persons/${c.personId}` as Route} className="font-medium underline-offset-4 hover:underline">
                        {c.name ?? "-"}
                      </Link>{" "}
                      {c.pattern ? <Badge variant="destructive">{tr("ops.reports.no_shows.pattern")}</Badge> : null}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{c.cancelled}</TableCell>
                    <TableCell className="text-right tabular-nums">{c.lateCancelled}</TableCell>
                    <TableCell className="text-right tabular-nums">{c.noShows}</TableCell>
                    <TableCell className="text-right tabular-nums">{c.attended}</TableCell>
                    <TableCell className="text-right tabular-nums">{pct(c.rate, ctx.locale)}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(c.valueForfeitedCents)}</TableCell>
                    <TableCell className="text-right tabular-nums">{c.recentNoShows}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </section>

          <section className="grid gap-2">
            <h2 className="text-lg font-semibold">{tr("ops.reports.no_shows.by_template")}</h2>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{tr("ops.reports.no_shows.column.template")}</TableHead>
                  <TableHead className="text-right">{tr("ops.reports.no_shows.status.cancelled")}</TableHead>
                  <TableHead className="text-right">{tr("ops.reports.no_shows.status.late_cancelled")}</TableHead>
                  <TableHead className="text-right">{tr("ops.reports.no_shows.status.no_show")}</TableHead>
                  <TableHead className="text-right">{tr("ops.reports.no_shows.value_forfeited")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {r.byTemplate.map((t) => (
                  <TableRow key={t.templateId ?? "none"}>
                    <TableCell>{t.name ? (t.name[ctx.locale] ?? t.name.en) : tr("ops.reports.no_shows.no_template")}</TableCell>
                    <TableCell className="text-right tabular-nums">{t.cancelled}</TableCell>
                    <TableCell className="text-right tabular-nums">{t.lateCancelled}</TableCell>
                    <TableCell className="text-right tabular-nums">{t.noShows}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(t.valueForfeitedCents)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </section>

          <section className="grid gap-2">
            <h2 className="text-lg font-semibold">{tr("ops.reports.no_shows.by_weekday_hour")}</h2>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{tr("ops.reports.no_shows.column.weekday")}</TableHead>
                  {hours.map((h) => (
                    <TableHead key={h} className="text-right">
                      {tr("ops.reports.capacity.hour", { hour: h })}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {WEEKDAYS.map((d) => (
                  <TableRow key={d}>
                    <TableCell>{tr(`ops.common.weekday.${d}`)}</TableCell>
                    {hours.map((h) => {
                      const c = cell(d, h);
                      const n = c ? c.noShows + c.lateCancelled : 0;
                      return (
                        <TableCell key={h} className="text-right tabular-nums" style={n ? { backgroundColor: `color-mix(in oklab, var(--color-destructive) ${Math.round((n / maxCell) * 40)}%, transparent)` } : undefined}>
                          {c ? `${c.noShows} / ${c.lateCancelled}` : ""}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </section>
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

function RangeForm({ action, from, to, tr }: { action: string; from: string; to: string; tr: ReturnType<typeof translator> }) {
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
