/**
 * The top of `/admin/dashboard`: this month's figures (from the management dashboard, when the
 * actor holds `reports.read`) and today's sessions with their occupancy, so the first screen says
 * how the business is doing and what happens on the floor today.
 */
import type { Route } from "next";
import Link from "next/link";
import { NavIcon } from "@beam/ui";
import { sessions } from "@beam/db/schema";
import { formatMoney, formatNumber, type Locale } from "@beam/core/i18n";
import { sql } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { getManagementDashboard } from "@/modules/ops/marketing/queries";
import type { OpsReadCtx } from "@/modules/ops/reports/queries";
import { holdsAny } from "@/modules/ops/reports/registry";
import type { Comparison } from "@/modules/ops/reports/revenue";
import { ChangeBadge } from "./ChangeBadge";

type Tr = (key: string, params?: Record<string, string | number>) => string;

type TodaySession = { id: string; title: string; kind: string; startsAt: Date; endsAt: Date; booked: number; capacity: number; status: string };

const SURFACE = "rounded-[1.25rem] bg-card shadow-[0_1px_2px_rgb(33_40_66/0.04),0_12px_32px_-18px_rgb(33_40_66/0.22)]";

async function todaySessions(ctx: OpsReadCtx): Promise<TodaySession[]> {
  const rows = await ctx.tx.execute(sql`
    select s.id, coalesce(s.title->>${ctx.locale}, s.title->>'nl-BE') as title, s.kind, s.starts_at, s.ends_at, s.status,
           coalesce(s.capacity_seats, s.capacity_beds, 0) as capacity,
           coalesce((select sum(b.capacity_units) from bookings b where b.session_id = s.id and b.status in ('reserved','confirmed','attended','no_show')), 0)::int as booked
    from ${sessions} s
    where (s.starts_at at time zone 'Europe/Brussels')::date = (${ctx.now}::timestamptz at time zone 'Europe/Brussels')::date
      and s.status <> 'cancelled' and s.webinar_id is null
    order by s.starts_at`);
  return rowsOf<Record<string, unknown>>(rows).map((r) => ({
    id: String(r.id),
    title: typeof r.title === "string" ? r.title : "",
    kind: String(r.kind),
    startsAt: new Date(r.starts_at as string),
    endsAt: new Date(r.ends_at as string),
    booked: Number(r.booked),
    capacity: Number(r.capacity),
    status: String(r.status),
  }));
}

function Figure({ label, icon, c, fmt, tr, locale, testId }: { label: string; icon: string; c: Comparison; fmt: (n: number) => string; tr: Tr; locale: Locale; testId: string }) {
  return (
    <div className={`${SURFACE} grid gap-3 p-5`} data-testid={testId} data-value={c.current}>
      <div className="flex items-center gap-3">
        <span className="grid size-9 place-items-center rounded-full bg-[#f4ead3] text-[#a0621e]">
          <NavIcon icon={icon} className="size-4" />
        </span>
        <span className="text-sm text-muted-foreground">{label}</span>
      </div>
      <span className="text-3xl leading-none font-semibold tracking-tight tabular-nums">{fmt(c.current)}</span>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <ChangeBadge change={c.change} changePct={c.changePct} formattedChange={fmt(Math.abs(c.change))} blankLabel={tr("ops.period.change_blank")} label={tr("ops.period.change")} locale={locale} />
        <span>{tr("ops.dashboard.overview.vs_last_month")}</span>
      </div>
    </div>
  );
}

export async function DashboardOverview({ ctx, tr }: { ctx: OpsReadCtx; tr: Tr }) {
  const time = (d: Date) => new Intl.DateTimeFormat(ctx.locale, { timeZone: "Europe/Brussels", hour: "2-digit", minute: "2-digit" }).format(d);
  const [figures, today] = await Promise.all([
    holdsAny(ctx.actor, "reports.read") ? getManagementDashboard(ctx, { period: "month", at: ctx.now }).catch(() => null) : null,
    todaySessions(ctx).catch(() => []),
  ]);
  const booked = today.reduce((n, s) => n + s.booked, 0);
  const capacity = today.reduce((n, s) => n + s.capacity, 0);
  const occupancy = capacity ? Math.round((booked / capacity) * 100) : 0;
  const money = (c: number) => formatMoney(c, ctx.locale);
  const count = (n: number) => formatNumber(n, ctx.locale);

  return (
    <div className="grid gap-6">
      {figures ? (
        <section aria-labelledby="overview-month" className="grid gap-3">
          <div className="flex items-baseline justify-between gap-3">
            <h2 id="overview-month" className="text-sm font-semibold tracking-[0.12em] text-muted-foreground uppercase">
              {tr("ops.dashboard.overview.this_month")}
            </h2>
            <Link href="/admin/dashboard/management" className="text-sm font-medium underline-offset-4 hover:underline">
              {tr("ops.dashboard.overview.more_figures")} →
            </Link>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Figure testId="overview-revenue" icon="euro" label={tr("ops.management.revenue.net")} c={figures.revenue.net} fmt={money} tr={tr} locale={ctx.locale} />
            <Figure testId="overview-orders" icon="shopping-cart" label={tr("ops.management.revenue.orders")} c={figures.revenue.orders} fmt={count} tr={tr} locale={ctx.locale} />
            <Figure testId="overview-new" icon="user" label={tr("ops.management.customers.new")} c={figures.customers.new} fmt={count} tr={tr} locale={ctx.locale} />
            <Figure testId="overview-active" icon="users" label={tr("ops.management.customers.active")} c={figures.customers.active} fmt={count} tr={tr} locale={ctx.locale} />
          </div>
        </section>
      ) : null}

      <section aria-labelledby="overview-today" className="relative grid gap-4 overflow-hidden rounded-[1.25rem] bg-[#212842] p-5 text-[#fffaef] sm:p-6">
        <div aria-hidden="true" className="pointer-events-none absolute -top-24 -right-16 size-64 rounded-full bg-[radial-gradient(circle,rgba(232,194,106,0.35),transparent_65%)]" />
        <div className="relative flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-xs font-semibold tracking-[0.25em] text-[#e8c26a] uppercase">{tr("ops.dashboard.overview.today_sessions")}</p>
            <p className="mt-1 text-3xl font-semibold tracking-tight tabular-nums">
              {today.length ? `${occupancy}%` : "—"}
              <span className="ml-2 text-sm font-normal tracking-normal text-[#fffaef]/70">{today.length ? tr("ops.dashboard.overview.booked_of", { booked, capacity }) : tr("ops.dashboard.overview.no_sessions")}</span>
            </p>
          </div>
          <Link href="/admin/bookings" className="rounded-full bg-[#fffaef]/10 px-4 py-2 text-sm font-medium hover:bg-[#fffaef]/20">
            {tr("ops.dashboard.overview.open_bookings")} →
          </Link>
        </div>
        {today.length ? (
          <ul className="relative grid gap-3 sm:grid-cols-2 xl:grid-cols-4" data-testid="overview-today-sessions">
            {today.map((s) => {
              const pct = s.capacity ? Math.min(100, Math.round((s.booked / s.capacity) * 100)) : 0;
              const past = s.endsAt.getTime() < ctx.now.getTime();
              return (
                <li key={s.id}>
                  <Link href={`/admin/sessions/${s.id}` as Route} className={`grid gap-3 rounded-2xl bg-[#fffaef]/[0.06] p-4 ring-1 ring-[#fffaef]/10 transition hover:bg-[#fffaef]/10 ${past ? "opacity-55" : ""}`}>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-xl font-semibold tabular-nums">
                        {time(s.startsAt)}
                        <span className="text-sm font-normal text-[#fffaef]/60"> – {time(s.endsAt)}</span>
                      </span>
                      <span className="rounded-full bg-[#e8c26a]/15 px-2.5 py-0.5 text-xs text-[#e8c26a]">{tr(`ops.dashboard.overview.kind_${s.kind}`)}</span>
                    </div>
                    <span className="truncate text-sm text-[#fffaef]/80">{s.title}</span>
                    <div className="h-1.5 overflow-hidden rounded-full bg-[#fffaef]/10" aria-hidden="true">
                      <div className={`h-full rounded-full ${pct >= 100 ? "bg-[#e07a5f]" : "bg-[linear-gradient(90deg,#b57627,#f7cc78)]"}`} style={{ width: `${Math.max(pct, 2)}%` }} />
                    </div>
                    <span className="text-xs text-[#fffaef]/65 tabular-nums">{tr("ops.dashboard.overview.booked_of", { booked: s.booked, capacity: s.capacity })}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : null}
      </section>
    </div>
  );
}
