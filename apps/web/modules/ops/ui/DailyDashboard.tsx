/**
 * The day view at the top of `/admin/dashboard` (owner requirements 6), in the back-office's
 * data-first style: one line of suggestions with actions, a compact KPI strip (against the same
 * weekday last week), the week as an occupancy grid with status colours (free, almost full,
 * full, no session) next to today's sessions, then who is coming as a filterable table with the
 * follow-up per client, the day's revenue per kind and the sessions to fill. Each part shows
 * only when the viewer may see it (`dailyAccess`): Front Desk sees no revenue and no campaign
 * button, client names need `persons.read`.
 */
import type { Route } from "next";
import Link from "next/link";
import { Fragment } from "react";
import { NavIcon, cn } from "@beam/ui";
import { comparePeriods } from "@beam/core/ops";
import { formatDate, formatMoney, formatTime, type Locale } from "@beam/core/i18n";
import {
  clientOpportunities,
  getDailyCapacity,
  getRevenuePeriods,
  getWeekOccupancy,
  listDayClients,
  listSessionsToFill,
  shiftDay,
  type CapacitySlot,
  type DailyAccess,
  type DailyCapacity,
  type RevenuePeriod,
  type DayClient,
  type Opportunity,
  type WeekOccupancy,
} from "../dashboard/daily";
import { FILL_REASONS } from "../dashboard/fill-session";
import type { OpsReadCtx } from "../reports/registry";
import { brusselsDate } from "../reports/revenue";
import { FillSessionButton, type FillSessionLabels } from "./FillSessionButton";

type Tr = (key: string, params?: Record<string, string | number>) => string;
const K = "ops.dashboard.daily";
/** Sessions listed in "sessions to fill" before the "more" link. */
const FILL_SHOWN = 5;
export type ClientFilter = "all" | "members" | "new" | "action";
export const CLIENT_FILTERS: readonly ClientFilter[] = ["all", "members", "new", "action"];

const surface = "rounded-xl border border-border bg-card";
const sectionTitle = "text-[0.9375rem] font-semibold tracking-[-0.005em]";

function kindLabel(tr: Tr, kind: string) {
  return tr(`ops.dashboard.overview.kind_${kind}`);
}

function opportunityText(o: Opportunity, tr: Tr, locale: Locale): string {
  const kind = o.kind ? tr(`${K}.credit_${o.kind}`) : "";
  const date = o.date ? formatDate(o.date, locale) : "";
  if (o.key === "package_low") return tr(o.units ? `${K}.opp.package_low` : `${K}.opp.package_used_up`, { kind, units: o.units ?? 0 });
  return tr(`${K}.opp.${o.key}`, { kind, units: o.units ?? 0, date });
}

function membershipText(m: NonNullable<DayClient["membership"]>, tr: Tr, locale: Locale): string {
  const date = formatDate(m.endsAt, locale);
  if (m.status === "past_due") return tr(`${K}.member_past_due`);
  return tr(m.renews ? `${K}.member_renews` : `${K}.member_ends`, { date });
}

const pctOf = (s: { booked: number; held: number; capacity: number }) => (s.capacity ? Math.min(100, Math.round(((s.booked + s.held) / s.capacity) * 100)) : 0);
const shortDay = (d: Date, locale: Locale) => new Intl.DateTimeFormat(locale, { timeZone: "Europe/Brussels", weekday: "short", day: "numeric", month: "short" }).format(d);

/** Free, almost full (75% or more), full, or over. */
type SlotState = "free" | "almost" | "full" | "past";
function slotState(s: { booked: number; held: number; capacity: number; available: number; endsAt: Date }, now: Date): SlotState {
  if (s.endsAt.getTime() < now.getTime()) return "past";
  if (s.available <= 0) return "full";
  return pctOf(s) >= 75 ? "almost" : "free";
}
const STATE_CELL: Record<SlotState, string> = {
  free: "bg-[var(--status-ok-soft)] text-[var(--status-ok)]",
  almost: "bg-[var(--status-warn-soft)] text-[var(--status-warn)]",
  full: "bg-[var(--status-full)] text-white",
  past: "bg-muted text-muted-foreground",
};
const STATE_PILL: Record<SlotState | "running", string> = {
  free: "bg-[var(--status-ok-soft)] text-[var(--status-ok)]",
  almost: "bg-[var(--status-warn-soft)] text-[var(--status-warn)]",
  full: "bg-[var(--status-full)] text-white",
  past: "bg-muted text-muted-foreground",
  running: "bg-[var(--status-info-soft)] text-[var(--status-info)]",
};

function Pill({ className, children }: { className?: string; children: React.ReactNode }) {
  return <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[0.6875rem] leading-4 font-semibold whitespace-nowrap", className)}>{children}</span>;
}

function fillLabels(tr: Tr, errors: Record<string, string>): FillSessionLabels {
  return {
    button: tr(`${K}.fill_button`),
    counting: tr(`${K}.fill_counting`),
    total: tr(`${K}.fill_total`),
    reasons: Object.fromEntries(FILL_REASONS.map((r) => [r, tr(`${K}.fill_reason_${r}`)])) as FillSessionLabels["reasons"],
    consentNote: tr(`${K}.fill_consent_note`),
    none: tr(`${K}.fill_none`),
    create: tr(`${K}.fill_create`),
    cancel: tr(`${K}.fill_cancel`),
    error: tr("platform.errors.internal", { requestId: "-" }),
    errors: { ...errors, validation: tr(`${K}.fill_not_possible`) },
  };
}

// ---------------------------------------------------------------------------------------------
// Suggestions: one calm line of chips, each with its action
// ---------------------------------------------------------------------------------------------

type Suggestion = { key: string; text: React.ReactNode; action: React.ReactNode };

function buildSuggestions(input: { toFill: CapacitySlot[]; clients: DayClient[] | null; access: DailyAccess; tr: Tr; locale: Locale; now: Date; errors: Record<string, string> }): Suggestion[] {
  const { toFill, clients, access, tr, locale, now, errors } = input;
  const out: Suggestion[] = [];
  const emptiest = [...toFill].sort((a, b) => pctOf(a) - pctOf(b) || a.startsAt.getTime() - b.startsAt.getTime()).slice(0, 2);
  for (const s of emptiest) {
    out.push({
      key: `fill:${s.sessionId}`,
      text: (
        <>
          <b className="font-semibold text-foreground">
            {shortDay(s.startsAt, locale)} {formatTime(s.startsAt, locale)}
          </b>{" "}
          {tr(`${K}.free_of`, { count: s.available, capacity: s.capacity })}
        </>
      ),
      action: access.fill ? (
        <FillSessionButton sessionId={s.sessionId} labels={fillLabels(tr, errors)} />
      ) : (
        <Link href={`/admin/sessions/${s.sessionId}` as Route} className="font-semibold text-[#8a5a14] hover:underline">
          {tr(`${K}.sugg_open_session`)} →
        </Link>
      ),
    });
  }
  if (clients) {
    const opps = clients.map((c) => clientOpportunities(c, now));
    const count = (key: Opportunity["key"]) => opps.filter((list) => list.some((o) => o.key === key)).length;
    const groups: [Opportunity["key"], string][] = [
      ["package_low", "package"],
      ["membership_renewal", "renewal"],
      ["first_visit", "first"],
      ["free_session_unused", "free"],
    ];
    for (const [key, name] of groups) {
      const n = count(key);
      if (!n) continue;
      out.push({
        key,
        text: tr(`${K}.sugg_${name}_text`, { count: n }),
        action: (
          <Link href={{ pathname: "/admin/dashboard", query: { who: "action" }, hash: "daily-clients-title" }} className="font-semibold text-[#8a5a14] hover:underline">
            {tr(`${K}.see`)} →
          </Link>
        ),
      });
    }
  }
  return out;
}

function SuggestionsLine({ items, tr }: { items: Suggestion[]; tr: Tr }) {
  if (!items.length) return null;
  return (
    <section aria-labelledby="daily-suggestions" className={cn(surface, "flex flex-wrap items-center gap-2 p-1.5 pl-3")} data-testid="daily-suggestions">
      <h2 id="daily-suggestions" className="flex shrink-0 items-center gap-1.5 text-[0.8125rem] font-semibold">
        <NavIcon icon="sparkles" className="size-3.5 text-[#c9973a]" />
        {tr(`${K}.suggestions_count`, { count: items.length })}
      </h2>
      <span aria-hidden="true" className="mx-1 h-5 w-px shrink-0 bg-border" />
      <ul className="flex flex-wrap gap-1.5">
        {items.map((s) => (
          <li key={s.key} className="flex shrink-0 items-center gap-2.5 rounded-lg bg-muted px-2.5 py-1 text-[0.8125rem] text-muted-foreground" data-suggestion={s.key}>
            <span>{s.text}</span>
            {s.action}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// KPI strip: four figures in one bordered row, no empty space
// ---------------------------------------------------------------------------------------------

function Delta({ change, changePct, formatted, locale }: { change: number; changePct: number | null; formatted: string; locale: Locale }) {
  const tone = change > 0 ? "bg-[var(--status-ok-soft)] text-[var(--status-ok)]" : change < 0 ? "bg-[var(--status-bad-soft)] text-[var(--status-bad)]" : "bg-muted text-muted-foreground";
  const sign = change > 0 ? "+" : change < 0 ? "−" : "±";
  const pct = changePct === null ? "" : ` (${sign}${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(Math.abs(changePct))}%)`;
  return <span className={cn("rounded-md px-1.5 py-px text-[0.6875rem] font-semibold", tone)}>{`${sign}${formatted}${pct}`}</span>;
}

type Kpi = { key: string; label: string; value: string; delta?: React.ReactNode; sub?: string };

function KpiStrip({ items }: { items: Kpi[] }) {
  return (
    <section className={cn(surface, "grid grid-cols-2 lg:grid-flow-col lg:auto-cols-fr lg:grid-cols-none lg:divide-x lg:divide-border")} data-testid="daily-kpis">
      {items.map((k, i) => (
        <div key={k.key} className={cn("grid content-start gap-1 px-5 py-3.5", i < 2 && "border-b border-border lg:border-b-0", i % 2 === 1 && "border-l border-border lg:border-l-0")} data-testid={`daily-kpi-${k.key}`}>
          <span className="text-[0.75rem] font-medium text-muted-foreground">{k.label}</span>
          <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="text-[1.5rem] leading-none font-semibold tracking-[-0.02em]">{k.value}</span>
            {k.delta}
          </span>
          {k.sub ? <span className="text-[0.75rem] text-muted-foreground">{k.sub}</span> : null}
        </div>
      ))}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Week occupancy grid
// ---------------------------------------------------------------------------------------------

type WeekSlot = WeekOccupancy["slots"][number];
type GridRow = { key: string; label: string; cells: Map<string, WeekSlot[]> };

function gridRows(week: WeekOccupancy, tr: Tr): GridRow[] {
  const rows = new Map<string, GridRow>();
  const rank = (k: string) => (k.startsWith("day:") ? `0${k}` : k.startsWith("night:") ? `1${k}` : `2${k}`);
  for (const s of week.slots) {
    const key = s.kind === "event" ? "event" : `${s.kind}:${s.time}`;
    const label = s.kind === "event" ? tr(`${K}.week_events`) : `${s.time} ${kindLabel(tr, s.kind).toLowerCase()}`;
    const row = rows.get(key) ?? { key, label, cells: new Map<string, WeekSlot[]>() };
    const list: WeekSlot[] = row.cells.get(s.day) ?? [];
    row.cells.set(s.day, [...list, s]);
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => rank(a.key).localeCompare(rank(b.key)));
}

function WeekGrid({ week, day, today, now, tr, locale }: { week: WeekOccupancy; day: string; today: string; now: Date; tr: Tr; locale: Locale }) {
  const rows = gridRows(week, tr);
  const head = (d: string) => new Intl.DateTimeFormat(locale, { timeZone: "UTC", weekday: "short" }).format(new Date(`${d}T12:00:00Z`));
  const future = week.slots.filter((s) => s.endsAt.getTime() > now.getTime() && s.kind !== "event");
  const busiest = [...future].sort((a, b) => pctOf(b) - pctOf(a))[0];
  const quietest = [...future].filter((s) => s.available > 0).sort((a, b) => pctOf(a) - pctOf(b))[0];
  const waiting = future.filter((s) => s.waiting > 0).sort((a, b) => b.waiting - a.waiting);
  const when = (s: CapacitySlot) => `${shortDay(s.startsAt, locale)} ${formatTime(s.startsAt, locale)}`;
  const legend: [SlotState | "closed", string][] = [
    ["free", tr(`${K}.legend_free`)],
    ["almost", tr(`${K}.legend_almost`)],
    ["full", tr(`${K}.legend_full`)],
    ["closed", tr(`${K}.legend_closed`)],
  ];
  return (
    <section className={cn(surface, "grid content-start gap-4 p-5")} data-testid="daily-week">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className={sectionTitle}>{tr(`${K}.week_title`)}</h2>
        <span className="flex items-center gap-1 text-[0.8125rem] text-muted-foreground">
          <Link href={{ pathname: "/admin/dashboard", query: { day: shiftDay(day, -7) } }} aria-label={tr(`${K}.week_prev`)} className="rounded-md px-1.5 hover:bg-muted hover:text-foreground">
            ‹
          </Link>
          {formatDate(week.days[0]!, locale)} – {formatDate(week.days[6]!, locale)}
          <Link href={{ pathname: "/admin/dashboard", query: { day: shiftDay(day, 7) } }} aria-label={tr(`${K}.week_next`)} className="rounded-md px-1.5 hover:bg-muted hover:text-foreground">
            ›
          </Link>
        </span>
        <ul className="ml-auto flex flex-wrap gap-1.5 text-[0.75rem] text-muted-foreground">
          {legend.map(([state, label]) => (
            <li key={state} className="flex items-center gap-1.5 rounded-md border border-border px-2 py-0.5">
              <span aria-hidden="true" className={cn("size-2.5 rounded-sm", state === "closed" ? "bg-muted ring-1 ring-border" : STATE_CELL[state].split(" ")[0])} />
              {label}
            </li>
          ))}
        </ul>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{tr(`${K}.no_sessions`)}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[36rem] table-fixed border-separate border-spacing-1 text-[0.75rem]">
            <thead>
              <tr>
                <th scope="col" className="w-[6.5rem]" />
                {week.days.map((d) => (
                  <th key={d} scope="col" className="pb-1 font-normal">
                    <Link
                      href={{ pathname: "/admin/dashboard", query: d === today ? {} : { day: d } }}
                      aria-current={d === day ? "date" : undefined}
                      className={cn(
                        "mx-auto flex w-fit items-baseline gap-1 rounded-md px-2 py-0.5 text-muted-foreground hover:bg-muted",
                        d === today && "bg-foreground text-background hover:bg-foreground",
                        d === day && d !== today && "ring-1 ring-[#c9973a]",
                      )}
                    >
                      <span>{head(d)}</span>
                      <b className={cn("font-semibold", d === today ? "text-background" : "text-foreground")}>{Number(d.slice(8, 10))}</b>
                    </Link>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key}>
                  <th scope="row" className="pr-2 text-left text-[0.8125rem] font-medium whitespace-nowrap text-foreground/80">
                    {row.label}
                  </th>
                  {week.days.map((d) => {
                    const cell = row.cells.get(d) ?? [];
                    if (!cell.length) {
                      return (
                        <td key={d} className="h-9 rounded-md bg-muted text-center text-muted-foreground/50">
                          <span aria-hidden="true">–</span>
                          <span className="sr-only">{tr(`${K}.week_closed`)}</span>
                        </td>
                      );
                    }
                    const agg = cell.reduce(
                      (a, s) => ({ booked: a.booked + s.booked, held: a.held + s.held, capacity: a.capacity + s.capacity, available: a.available + s.available, waiting: a.waiting + s.waiting }),
                      { booked: 0, held: 0, capacity: 0, available: 0, waiting: 0 },
                    );
                    const first = cell[0]!;
                    const state = slotState({ ...agg, endsAt: cell[cell.length - 1]!.endsAt }, now);
                    const label = tr(`${K}.week_cell`, { when: `${shortDay(first.startsAt, locale)} ${row.label}`, booked: agg.booked + agg.held, capacity: agg.capacity });
                    return (
                      <td key={d} className="h-9 p-0">
                        <Link
                          href={`/admin/sessions/${first.sessionId}` as Route}
                          title={label}
                          aria-label={label}
                          className={cn("flex h-9 items-center justify-center gap-1 rounded-md font-semibold transition hover:ring-2 hover:ring-foreground/25", STATE_CELL[state])}
                          data-testid="daily-week-cell"
                          data-pct={pctOf(agg)}
                          data-state={state}
                        >
                          {agg.booked + agg.held}/{agg.capacity}
                          {agg.waiting ? <span className="rounded bg-white/25 px-1 text-[0.625rem]">+{agg.waiting}</span> : null}
                        </Link>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <dl className="grid grid-cols-3 gap-4 border-t border-border pt-3 text-[0.8125rem]">
        <div>
          <dt className="text-muted-foreground">{tr(`${K}.busiest_short`)}</dt>
          <dd className="font-semibold">{busiest ? `${when(busiest)} · ${pctOf(busiest)}%` : "–"}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{tr(`${K}.quietest_short`)}</dt>
          <dd className="font-semibold">{quietest ? `${when(quietest)} · ${tr(`${K}.free_of`, { count: quietest.available, capacity: quietest.capacity })}` : "–"}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{tr(`${K}.waitlist_short`)}</dt>
          <dd className="font-semibold">{waiting.length ? `${tr(`${K}.waiting`, { count: waiting.reduce((n, s) => n + s.waiting, 0) })} · ${when(waiting[0]!)}` : tr(`${K}.waitlist_none`)}</dd>
        </div>
      </dl>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Today's sessions
// ---------------------------------------------------------------------------------------------

function TodayBlock({ capacity, tr, locale, now }: { capacity: DailyCapacity; tr: Tr; locale: Locale; now: Date }) {
  const { slots, total } = capacity;
  return (
    <section className={cn(surface, "grid content-start gap-3 p-5")} data-testid="daily-capacity">
      <div className="flex items-baseline gap-2">
        <h2 className={sectionTitle}>{tr(`${K}.today_title`)}</h2>
        <Link href="/admin/bookings/checkin" className="ml-auto text-[0.8125rem] font-medium text-muted-foreground hover:text-foreground">
          {tr(`${K}.reception`)} →
        </Link>
      </div>
      {slots.length ? (
        <p className="text-[0.8125rem] text-muted-foreground" data-testid="daily-capacity-total" data-capacity={total.capacity} data-booked={total.booked} data-available={total.available}>
          <b className="font-semibold text-foreground">{tr(`${K}.places_left`, { count: total.available })}</b> · {tr("ops.dashboard.overview.booked_of", { booked: total.booked, capacity: total.capacity })}
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">{tr(`${K}.no_sessions`)}</p>
      )}
      <ol className="grid gap-1.5">
        {slots.map((s) => {
          const running = s.startsAt.getTime() <= now.getTime() && s.endsAt.getTime() > now.getTime();
          const state = slotState(s, now);
          const pillKey = running ? "running" : state;
          const pillText = running ? tr(`${K}.now_running`) : state === "past" ? tr(`${K}.status_past`) : state === "full" ? tr(`${K}.full`) : tr(`${K}.places_left`, { count: s.available });
          return (
            <li key={s.sessionId}>
              <Link
                href={`/admin/sessions/${s.sessionId}` as Route}
                className={cn("grid grid-cols-[3rem_1fr_auto] items-center gap-3 rounded-lg border px-3 py-2.5 transition hover:bg-muted/60", running ? "border-[#c9973a] ring-1 ring-[#c9973a]" : "border-border", state === "past" && !running && "opacity-60")}
                data-testid="daily-slot"
              >
                <span className="text-[0.8125rem] font-semibold">{formatTime(s.startsAt, locale)}</span>
                <span className="grid min-w-0 leading-tight">
                  <span className="truncate text-[0.8125rem] font-medium">{s.title}</span>
                  <span className="text-[0.75rem] text-muted-foreground">
                    {s.booked + s.held}/{s.capacity} · {formatTime(s.startsAt, locale)}–{formatTime(s.endsAt, locale)}
                    {s.waiting ? ` · ${tr(`${K}.waiting`, { count: s.waiting })}` : ""}
                  </span>
                </span>
                <Pill className={STATE_PILL[pillKey]}>{pillText}</Pill>
              </Link>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Who is coming: a table with the follow-up per client
// ---------------------------------------------------------------------------------------------

const AVATAR_TONES = ["bg-[#fde7d3] text-[#9a3412]", "bg-[#e0e7ff] text-[#3730a3]", "bg-[#dcfce7] text-[#166534]", "bg-[#f7eedc] text-[#8a5a14]", "bg-[#fce7f3] text-[#9d174d]"];
const initials = (name: string | null) =>
  (name ?? "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
const tone = (id: string) => AVATAR_TONES[[...id].reduce((n, c) => n + c.charCodeAt(0), 0) % AVATAR_TONES.length]!;

function matchesFilter(c: DayClient, filter: ClientFilter, now: Date): boolean {
  if (filter === "members") return c.membership !== null;
  if (filter === "new") return c.isFirstVisit;
  if (filter === "action") return clientOpportunities(c, now).length > 0;
  return true;
}

function ClientsTable({ clients, filter, day, today, tr, locale, now }: { clients: DayClient[]; filter: ClientFilter; day: string; today: string; tr: Tr; locale: Locale; now: Date }) {
  const count = (f: ClientFilter) => clients.filter((c) => matchesFilter(c, f, now)).length;
  const shown = clients.filter((c) => matchesFilter(c, filter, now));
  const query = (f: ClientFilter) => ({ ...(day === today ? {} : { day }), ...(f === "all" ? {} : { who: f }) });
  return (
    <section className={cn(surface, "min-w-0 overflow-hidden")} data-testid="daily-clients">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-3">
        <h2 id="daily-clients-title" className={sectionTitle}>
          {tr(`${K}.clients_title`)}
        </h2>
        <nav aria-label={tr(`${K}.clients_title`)} className="flex rounded-lg bg-muted p-0.5 text-[0.75rem] font-medium">
          {CLIENT_FILTERS.map((f) => (
            <Link
              key={f}
              href={{ pathname: "/admin/dashboard", query: query(f), hash: "daily-clients-title" }}
              aria-current={f === filter ? "true" : undefined}
              className={cn("rounded-md px-2.5 py-1 text-muted-foreground hover:text-foreground", f === filter && "bg-card text-foreground shadow-sm")}
            >
              {tr(`${K}.who_${f}`)} <span className="opacity-70">{count(f)}</span>
            </Link>
          ))}
        </nav>
      </div>
      {clients.length === 0 || shown.length === 0 ? (
        <p className="px-5 py-6 text-sm text-muted-foreground">{clients.length === 0 ? tr(`${K}.clients_empty`) : tr(`${K}.who_empty`)}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[44rem] text-[0.8125rem]">
            <thead className="bg-[#faf9f6] text-left text-[0.75rem] text-muted-foreground">
              <tr className="border-b border-border">
                <th scope="col" className="py-2 pr-3 pl-5 font-medium">{tr(`${K}.col_client`)}</th>
                <th scope="col" className="px-3 py-2 font-medium">{tr(`${K}.col_session`)}</th>
                <th scope="col" className="px-3 py-2 font-medium">{tr(`${K}.col_credits`)}</th>
                <th scope="col" className="px-3 py-2 font-medium">{tr(`${K}.col_membership`)}</th>
                <th scope="col" className="py-2 pr-5 pl-3 font-medium">{tr(`${K}.col_followup`)}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((c) => {
                const href = `/admin/persons/${c.personId}` as Route;
                const opps = clientOpportunities(c, now);
                const credits = c.packages.filter((p) => p.total > 0);
                return (
                  <tr key={c.personId} className="border-b border-border align-top last:border-b-0 hover:bg-[#faf9f6]" data-testid="daily-client" data-person-id={c.personId}>
                    <td className="py-2.5 pr-3 pl-5">
                      <Link href={href} className="flex items-center gap-2.5">
                        <span aria-hidden="true" className={cn("grid size-8 shrink-0 place-items-center rounded-full text-[0.6875rem] font-semibold", tone(c.personId))}>
                          {initials(c.name)}
                        </span>
                        <span className="font-semibold whitespace-nowrap hover:underline">{c.name ?? "-"}</span>
                        {c.isFirstVisit ? <Pill className="bg-[var(--status-info-soft)] text-[var(--status-info)]">{tr(`${K}.new_badge`)}</Pill> : null}
                      </Link>
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      {c.sessions.map((s) => (
                        <span key={s.sessionId} className="block leading-8">
                          {formatTime(s.startsAt, locale)} <span className="text-muted-foreground">{kindLabel(tr, s.kind).toLowerCase()}</span>
                        </span>
                      ))}
                    </td>
                    <td className="px-3 py-2.5 leading-8 whitespace-nowrap">
                      {credits.length ? (
                        credits.map((p) => (
                          <span key={p.kind} className="block">
                            <b className={cn("font-semibold", p.remaining === 0 && "text-[var(--status-bad)]")}>{p.remaining}</b>
                            <span className="text-muted-foreground">
                              {" "}
                              / {p.total} {tr(`${K}.credit_${p.kind}`)}
                            </span>
                          </span>
                        ))
                      ) : (
                        <span className="text-muted-foreground">{tr(`${K}.single_session`)}</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 leading-8">
                      {c.membership ? (
                        <Pill className={c.membership.status === "past_due" || !c.membership.renews ? "bg-[var(--status-warn-soft)] text-[var(--status-warn)]" : "bg-[var(--status-ok-soft)] text-[var(--status-ok)]"}>
                          {membershipText(c.membership, tr, locale)}
                        </Pill>
                      ) : (
                        <span className="text-muted-foreground">–</span>
                      )}
                    </td>
                    <td className="py-2.5 pr-5 pl-3">
                      {opps.length ? (
                        <ul className="grid gap-1" data-testid="daily-opportunities">
                          {opps.map((o) => (
                            <li key={`${o.key}:${o.kind ?? ""}`} data-opportunity={o.key}>
                              <Link href={href} className="inline-flex rounded-md border border-border bg-card px-2 py-1 text-[0.75rem] leading-4 font-semibold hover:border-[#c9973a] hover:bg-[#f7eedc]">
                                {opportunityText(o, tr, locale)}
                              </Link>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <span className="leading-8 text-muted-foreground">–</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Revenue and sessions to fill (side column)
// ---------------------------------------------------------------------------------------------

const REVENUE_TONES: Record<string, string> = { sessions: "#c9973a", packages: "#8a5a14", memberships: "#141414", events: "#4f46e5", other: "#b8b2a7" };

function RevenueBlock({ periods, day, tr, locale }: { periods: RevenuePeriod[]; day: string; tr: Tr; locale: Locale }) {
  const money = (c: number) => formatMoney(c, locale);
  const dayNet = periods.find((p) => p.key === "day")?.net.current ?? 0;
  const groups = periods[0]?.groups.map((g) => g.key) ?? [];
  const cell = (c: { current: number; change: number; changePct: number | null }, strong = false) => (
    <td className="py-2 pl-4 text-right align-top">
      <span className={cn("block tabular-nums", strong ? "text-[0.9375rem] font-semibold" : "font-medium")}>{money(c.current)}</span>
      {strong ? (
        <span className="mt-0.5 inline-block">
          <Delta change={c.change} changePct={c.changePct} formatted={money(Math.abs(c.change))} locale={locale} />
        </span>
      ) : null}
    </td>
  );
  return (
    <section className={cn(surface, "grid content-start gap-3 p-5")} data-testid="daily-revenue" data-value={dayNet}>
      <div className="flex items-baseline gap-2">
        <h2 className={sectionTitle}>{tr(`${K}.revenue_periods_title`)}</h2>
        <Link href={{ pathname: "/admin/reports/revenue", query: { period: "day", at: day } }} className="ml-auto text-[0.8125rem] font-medium text-muted-foreground hover:text-foreground">
          {tr("ops.dashboard.overview.more_figures")} →
        </Link>
      </div>
      <table className="w-full text-[0.8125rem]">
        <thead>
          <tr className="border-b border-border text-[0.75rem] text-muted-foreground">
            <th scope="col" className="py-1.5 text-left font-medium">
              <span className="sr-only">{tr(`${K}.revenue_periods_title`)}</span>
            </th>
            {periods.map((p) => (
              <th key={p.key} scope="col" className="py-1.5 pl-4 text-right font-medium">
                {tr(`${K}.period_${p.key}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr className="border-b border-border" data-group="net">
            <th scope="row" className="py-2 text-left align-top font-semibold">
              {tr(`${K}.revenue_net`)}
            </th>
            {periods.map((p) => (
              <Fragment key={p.key}>{cell(p.net, true)}</Fragment>
            ))}
          </tr>
          {groups.map((g) => (
            <tr key={g} className="border-b border-border last:border-b-0" data-group={g}>
              <th scope="row" className="py-2 text-left font-normal text-muted-foreground">
                <span className="flex items-center gap-2">
                  <span aria-hidden="true" className="size-2 rounded-full" style={{ background: REVENUE_TONES[g] }} />
                  {tr(`${K}.revenue_${g}`)}
                </span>
              </th>
              {periods.map((p) => (
                <Fragment key={p.key}>{cell(p.groups.find((x) => x.key === g)!.sales)}</Fragment>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[0.75rem] text-muted-foreground">{tr(`${K}.revenue_compare_note`)}</p>
    </section>
  );
}

function FillBlock({ slots, canFill, tr, locale, errors }: { slots: CapacitySlot[]; canFill: boolean; tr: Tr; locale: Locale; errors: Record<string, string> }) {
  const labels = fillLabels(tr, errors);
  return (
    <section className={cn(surface, "grid content-start gap-2 p-5")} data-testid="daily-fill">
      <h2 className={sectionTitle}>{tr(`${K}.fill_title`)}</h2>
      {slots.length === 0 ? (
        <p className="text-sm text-muted-foreground">{tr(`${K}.fill_empty`)}</p>
      ) : (
        <ul className="grid">
          {slots.slice(0, FILL_SHOWN).map((s) => (
            <li key={s.sessionId} className="flex items-center justify-between gap-3 border-b border-border py-2 last:border-b-0" data-testid="daily-fill-session">
              <Link href={`/admin/sessions/${s.sessionId}` as Route} className="grid min-w-0 leading-tight hover:underline">
                <span className="truncate text-[0.8125rem] font-semibold">
                  {shortDay(s.startsAt, locale)} {formatTime(s.startsAt, locale)} <span className="font-normal text-muted-foreground">· {kindLabel(tr, s.kind).toLowerCase()}</span>
                </span>
                <span className="text-[0.75rem] text-muted-foreground">{tr(`${K}.free_of`, { count: s.available, capacity: s.capacity })}</span>
              </Link>
              {canFill ? <FillSessionButton sessionId={s.sessionId} labels={labels} /> : null}
            </li>
          ))}
        </ul>
      )}
      {slots.length > FILL_SHOWN ? (
        <Link href="/admin/sessions" className="text-[0.8125rem] font-medium text-muted-foreground hover:text-foreground">
          {tr(`${K}.fill_more`, { count: slots.length - FILL_SHOWN })} →
        </Link>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// The page part
// ---------------------------------------------------------------------------------------------

export async function DailyDashboard({ ctx, tr, day, access, errors, who = "all" }: { ctx: OpsReadCtx; tr: Tr; day: string; access: DailyAccess; errors: Record<string, string>; who?: ClientFilter }) {
  const locale = ctx.locale;
  const [capacity, lastWeek, week, clients, toFill, revenue] = await Promise.all([
    getDailyCapacity(ctx.tx, { day, locale }),
    getDailyCapacity(ctx.tx, { day: shiftDay(day, -7), locale }),
    getWeekOccupancy(ctx.tx, { day, locale }),
    access.clients ? listDayClients(ctx.tx, { day, now: ctx.now }) : null,
    listSessionsToFill(ctx.tx, { now: ctx.now, locale }),
    access.revenue ? getRevenuePeriods(ctx.tx, { day }) : null,
  ]);
  const today = brusselsDate(ctx.now);
  const taken = capacity.total.booked + capacity.total.held;
  const booked = comparePeriods(taken, lastWeek.total.booked + lastWeek.total.held);
  const occupancy = capacity.total.capacity ? Math.round((taken / capacity.total.capacity) * 100) : 0;
  const freeAhead = toFill.reduce((n, s) => n + s.available, 0);
  const suggestions = buildSuggestions({ toFill, clients, access, tr, locale, now: ctx.now, errors });
  const kpis: Kpi[] = [
    {
      key: "occupancy",
      label: tr(`${K}.kpi_occupancy`),
      value: `${occupancy}%`,
      delta: <Delta change={booked.change} changePct={booked.changePct} formatted={String(Math.abs(booked.change))} locale={locale} />,
      sub: tr(`${K}.kpi_occupancy_sub`, { booked: taken, capacity: capacity.total.capacity }),
    },
    ...(clients ? [{ key: "clients", label: tr(`${K}.kpi_clients`), value: String(clients.length), sub: tr(`${K}.kpi_clients_sub`, { count: clients.filter((c) => c.isFirstVisit).length }) }] : []),
    ...(revenue
      ? (() => {
          const [d, w, m] = revenue;
          return [
            {
              key: "revenue",
              label: tr(`${K}.kpi_revenue`),
              value: formatMoney(d!.net.current, locale),
              delta: <Delta change={d!.net.change} changePct={d!.net.changePct} formatted={formatMoney(Math.abs(d!.net.change), locale)} locale={locale} />,
              sub: tr(`${K}.kpi_revenue_sub`, { week: formatMoney(w!.net.current, locale), month: formatMoney(m!.net.current, locale) }),
            },
          ];
        })()
      : []),
    { key: "week", label: tr(`${K}.kpi_week`), value: String(freeAhead), sub: tr(`${K}.kpi_week_sub`, { count: toFill.length }) },
  ];

  return (
    <div className="grid gap-4">
      <SuggestionsLine items={suggestions} tr={tr} />
      <KpiStrip items={kpis} />
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <WeekGrid week={week} day={day} today={today} now={ctx.now} tr={tr} locale={locale} />
        <TodayBlock capacity={capacity} tr={tr} locale={locale} now={ctx.now} />
      </div>
      {clients ? <ClientsTable clients={clients} filter={who} day={day} today={today} tr={tr} locale={locale} now={ctx.now} /> : null}
      <div className="grid items-start gap-4 lg:grid-cols-2">
        {revenue ? <RevenueBlock periods={revenue} day={day} tr={tr} locale={locale} /> : null}
        <FillBlock slots={toFill} canFill={access.fill} tr={tr} locale={locale} errors={errors} />
      </div>
    </div>
  );
}
