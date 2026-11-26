/**
 * The day view at the top of `/admin/dashboard` (owner requirements 6), laid out like a modern
 * operations dashboard: smart suggestions with one-click actions, four KPI tiles against the
 * same weekday last week, the week as an occupancy heatmap (day blocks and nights against the
 * seven days) next to the day's sessions, then who is coming (with what to offer them), the
 * revenue of the day per kind and the sessions of the next 7 days to fill. Each part shows only
 * when the viewer may see it (`dailyAccess`): Front Desk sees no revenue and no campaign button,
 * client names need `persons.read`.
 */
import type { Route } from "next";
import Link from "next/link";
import { Badge, Card, CardAction, CardContent, CardHeader, CardTitle, NavIcon, cn } from "@beam/ui";
import { comparePeriods } from "@beam/core/ops";
import { formatDate, formatMoney, formatTime, type Locale } from "@beam/core/i18n";
import {
  clientOpportunities,
  getDailyCapacity,
  getDailyRevenue,
  getWeekOccupancy,
  listDayClients,
  listSessionsToFill,
  shiftDay,
  type CapacitySlot,
  type DailyAccess,
  type DailyCapacity,
  type DailyRevenue,
  type DayClient,
  type Opportunity,
  type WeekOccupancy,
} from "../dashboard/daily";
import { FILL_REASONS } from "../dashboard/fill-session";
import type { OpsReadCtx } from "../reports/registry";
import { brusselsDate } from "../reports/revenue";
import { ChangeBadge } from "./ChangeBadge";
import { FillSessionButton, type FillSessionLabels } from "./FillSessionButton";

type Tr = (key: string, params?: Record<string, string | number>) => string;
const K = "ops.dashboard.daily";
const GOLD = "#d1a64a";
/** Sessions listed in "sessions to fill" before the "more" link. */
const FILL_SHOWN = 6;

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
const shortDay = (d: Date | string, locale: Locale) =>
  new Intl.DateTimeFormat(locale, { timeZone: "Europe/Brussels", weekday: "short", day: "numeric", month: "short" }).format(typeof d === "string" ? new Date(`${d}T12:00:00Z`) : d);

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
// Smart suggestions
// ---------------------------------------------------------------------------------------------

type Suggestion = { key: string; icon: string; title: string; text: string; action: React.ReactNode };

function SuggestionsStrip({ items, tr }: { items: Suggestion[]; tr: Tr }) {
  if (!items.length) return null;
  return (
    <section aria-labelledby="daily-suggestions" className="grid gap-3 rounded-[1.25rem] bg-[linear-gradient(120deg,#f4ead3,#fbf6ea_60%,#f4ead3)] p-4 ring-1 ring-[#d1a64a]/30 sm:p-5" data-testid="daily-suggestions">
      <h2 id="daily-suggestions" className="flex flex-wrap items-center gap-2 text-sm">
        <span className="flex size-7 items-center justify-center rounded-full bg-[#212842] text-[#e8c26a]">
          <NavIcon icon="sparkles" className="size-4" />
        </span>
        <span className="font-semibold">{tr(`${K}.suggestions_title`)}</span>
        <span className="text-muted-foreground">· {tr(`${K}.suggestions_count`, { count: items.length })}</span>
      </h2>
      <ul className="-mx-1 flex snap-x gap-3 overflow-x-auto px-1 pb-1">
        {items.map((s) => (
          <li key={s.key} className="grid min-w-[16rem] flex-1 snap-start content-between gap-3 rounded-2xl bg-card p-4 shadow-sm ring-1 ring-black/5" data-suggestion={s.key}>
            <div className="grid gap-1">
              <span className="flex items-center gap-2 font-semibold">
                <NavIcon icon={s.icon} className="size-4 text-[#a0621e]" />
                {s.title}
              </span>
              <span className="text-sm text-muted-foreground">{s.text}</span>
            </div>
            <div>{s.action}</div>
          </li>
        ))}
      </ul>
    </section>
  );
}

const pillLink = "inline-flex items-center rounded-full border border-[#d1a64a]/60 bg-background px-3.5 py-1.5 text-sm font-medium hover:bg-[#f4ead3] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

function buildSuggestions(input: { toFill: CapacitySlot[]; clients: DayClient[] | null; access: DailyAccess; tr: Tr; locale: Locale; now: Date; errors: Record<string, string> }): Suggestion[] {
  const { toFill, clients, access, tr, locale, now, errors } = input;
  const out: Suggestion[] = [];
  // The two emptiest sessions of the next days: the biggest gains from a targeted mail.
  const emptiest = [...toFill].sort((a, b) => pctOf(a) - pctOf(b) || a.startsAt.getTime() - b.startsAt.getTime()).slice(0, 2);
  for (const s of emptiest) {
    out.push({
      key: `fill:${s.sessionId}`,
      icon: s.kind === "night" ? "moon" : "calendar-days",
      title: tr(`${K}.sugg_fill_title`, { when: `${shortDay(s.startsAt, locale)} ${formatTime(s.startsAt, locale)}` }),
      text: `${tr(`${K}.free_of`, { count: s.available, capacity: s.capacity })}${s.waiting ? ` · ${tr(`${K}.waiting`, { count: s.waiting })}` : ""}`,
      action: access.fill ? (
        <FillSessionButton sessionId={s.sessionId} labels={fillLabels(tr, errors)} />
      ) : (
        <Link href={`/admin/sessions/${s.sessionId}` as Route} className={pillLink}>
          {tr(`${K}.sugg_open_session`)}
        </Link>
      ),
    });
  }
  if (clients) {
    const opps = clients.map((c) => clientOpportunities(c, now));
    const count = (key: Opportunity["key"]) => opps.filter((list) => list.some((o) => o.key === key)).length;
    const clientsLink = (
      <a href="#daily-clients-title" className={pillLink}>
        {tr(`${K}.sugg_see_clients`)}
      </a>
    );
    const groups: [Opportunity["key"], string, string][] = [
      ["package_low", "package", "package"],
      ["membership_renewal", "badge-check", "renewal"],
      ["first_visit", "user-plus", "first"],
      ["free_session_unused", "gift", "free"],
    ];
    for (const [key, icon, name] of groups) {
      const n = count(key);
      if (n) out.push({ key, icon, title: tr(`${K}.sugg_${name}_title`), text: tr(`${K}.sugg_${name}_text`, { count: n }), action: clientsLink });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// KPI tiles
// ---------------------------------------------------------------------------------------------

function Kpi({ icon, label, value, sub, badge, testId }: { icon: string; label: string; value: string; sub?: string; badge?: React.ReactNode; testId?: string }) {
  return (
    <div className="grid content-between gap-3 rounded-[1.25rem] bg-card p-5 shadow-sm ring-1 ring-black/5" data-testid={testId}>
      <span className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
        {label}
        <span className="flex size-8 items-center justify-center rounded-full bg-[#f4ead3] text-[#a0621e]">
          <NavIcon icon={icon} className="size-4" />
        </span>
      </span>
      <span className="text-3xl leading-none font-semibold tracking-tight tabular-nums">{value}</span>
      <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {badge}
        {sub}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Week heatmap
// ---------------------------------------------------------------------------------------------

/** Gold scale from free (light sand) to full (deep amber, white figures). */
function heatClass(pct: number, full: boolean): string {
  if (full) return "bg-[#8a5a14] text-white";
  if (pct >= 75) return "bg-[#b9832d] text-white";
  if (pct >= 50) return "bg-[#d1a64a] text-[#1c1c1c]";
  if (pct >= 25) return "bg-[#e6c886] text-[#1c1c1c]";
  if (pct > 0) return "bg-[#f1e0b6] text-[#1c1c1c]";
  return "bg-[#f8f0dd] text-muted-foreground";
}

type HeatRow = { key: string; label: string; icon: string; cells: Map<string, (CapacitySlot & { day: string; time: string })[]> };

function heatRows(week: WeekOccupancy, tr: Tr): HeatRow[] {
  const rows = new Map<string, HeatRow>();
  const order = (k: string) => (k.startsWith("day:") ? `0${k}` : k.startsWith("night:") ? `1${k}` : `2${k}`);
  for (const s of week.slots) {
    const key = s.kind === "event" ? "event" : `${s.kind}:${s.time}`;
    const label = s.kind === "event" ? tr(`${K}.week_events`) : s.kind === "night" ? `${tr(`${K}.week_night`)} ${s.time}` : s.time;
    const row = rows.get(key) ?? { key, label, icon: s.kind === "night" ? "moon" : s.kind === "event" ? "ticket" : "sun", cells: new Map() };
    const list: (CapacitySlot & { day: string; time: string })[] = row.cells.get(s.day) ?? [];
    row.cells.set(s.day, [...list, s]);
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => order(a.key).localeCompare(order(b.key)));
}

function WeekHeatmap({ week, day, today, now, tr, locale }: { week: WeekOccupancy; day: string; today: string; now: Date; tr: Tr; locale: Locale }) {
  const rows = heatRows(week, tr);
  const dayHead = (d: string) => new Intl.DateTimeFormat(locale, { timeZone: "UTC", weekday: "short" }).format(new Date(`${d}T12:00:00Z`));
  const dayNum = (d: string) => Number(d.slice(8, 10));
  const future = week.slots.filter((s) => s.endsAt.getTime() > now.getTime() && s.kind !== "event");
  const busiest = [...future].sort((a, b) => pctOf(b) - pctOf(a)).slice(0, 3);
  const quietest = [...future].filter((s) => s.available > 0).sort((a, b) => pctOf(a) - pctOf(b)).slice(0, 3);
  const when = (s: CapacitySlot) => `${shortDay(s.startsAt, locale)} ${formatTime(s.startsAt, locale)}`;
  const weekLink = (n: number) => ({ pathname: "/admin/dashboard", query: { day: shiftDay(day, n) } });
  return (
    <Card data-testid="daily-week">
      <CardHeader>
        <CardTitle className="text-base">{tr(`${K}.week_title`)}</CardTitle>
        <CardAction className="flex items-center gap-1 text-sm">
          <Link href={weekLink(-7)} aria-label={tr(`${K}.week_prev`)} className="rounded-full px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground">
            ←
          </Link>
          <span className="tabular-nums text-muted-foreground">
            {formatDate(week.days[0]!, locale)} – {formatDate(week.days[6]!, locale)}
          </span>
          <Link href={weekLink(7)} aria-label={tr(`${K}.week_next`)} className="rounded-full px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground">
            →
          </Link>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_15rem]">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{tr(`${K}.no_sessions`)}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] table-fixed border-separate border-spacing-1.5 text-sm">
              <thead>
                <tr>
                  <th scope="col" className="w-24" />
                  {week.days.map((d) => (
                    <th key={d} scope="col" className="pb-1 text-center font-normal">
                      <Link
                        href={{ pathname: "/admin/dashboard", query: d === today ? {} : { day: d } }}
                        className={cn(
                          "mx-auto grid w-12 justify-items-center rounded-xl py-1 leading-tight hover:bg-muted",
                          d === today && "bg-[#212842] text-[#fffaef] hover:bg-[#212842]",
                          d === day && d !== today && "ring-1 ring-[#d1a64a]",
                        )}
                        aria-current={d === day ? "date" : undefined}
                      >
                        <span className="text-[0.7rem] uppercase opacity-70">{dayHead(d)}</span>
                        <span className="font-semibold tabular-nums">{dayNum(d)}</span>
                      </Link>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key}>
                    <th scope="row" className="pr-1 text-left font-medium whitespace-nowrap text-muted-foreground">
                      <span className="flex items-center gap-1.5">
                        <NavIcon icon={row.icon} className="size-3.5" />
                        {row.label}
                      </span>
                    </th>
                    {week.days.map((d) => {
                      const cell = row.cells.get(d) ?? [];
                      if (!cell.length) {
                        return (
                          <td key={d} className="h-11 rounded-lg bg-[repeating-linear-gradient(135deg,#f6f1e6,#f6f1e6_4px,#efe7d6_4px,#efe7d6_8px)]">
                            <span className="sr-only">{tr(`${K}.week_closed`)}</span>
                          </td>
                        );
                      }
                      const agg = cell.reduce((a, s) => ({ booked: a.booked + s.booked, held: a.held + s.held, capacity: a.capacity + s.capacity, available: a.available + s.available }), { booked: 0, held: 0, capacity: 0, available: 0 });
                      const pct = pctOf(agg);
                      const first = cell[0]!;
                      const past = first.endsAt.getTime() < now.getTime();
                      const label = tr(`${K}.week_cell`, { when: `${shortDay(first.startsAt, locale)} ${row.label}`, booked: agg.booked + agg.held, capacity: agg.capacity });
                      return (
                        <td key={d} className="h-11 p-0">
                          <Link
                            href={`/admin/sessions/${first.sessionId}` as Route}
                            title={label}
                            aria-label={label}
                            className={cn(
                              "flex h-11 items-center justify-center rounded-lg text-xs font-semibold tabular-nums transition hover:ring-2 hover:ring-[#212842]/40 focus-visible:outline-2 focus-visible:outline-[#212842]",
                              heatClass(pct, agg.available === 0),
                              past && "opacity-50",
                            )}
                            data-testid="daily-week-cell"
                            data-pct={pct}
                          >
                            {agg.booked + agg.held}/{agg.capacity}
                          </Link>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
              <span>{tr(`${K}.week_legend`)}</span>
              <span>0%</span>
              <span className="h-2 w-40 rounded-full bg-[linear-gradient(90deg,#f8f0dd,#e6c886,#d1a64a,#b9832d,#8a5a14)]" aria-hidden="true" />
              <span>100%</span>
            </div>
          </div>
        )}
        <div className="grid content-start gap-5 text-sm">
          {busiest.length ? (
            <div className="grid gap-2">
              <h3 className="font-semibold">{tr(`${K}.week_busiest`)}</h3>
              <ul className="grid gap-2">
                {busiest.map((s) => (
                  <li key={s.sessionId} className="grid">
                    <Link href={`/admin/sessions/${s.sessionId}` as Route} className="font-medium underline-offset-4 hover:underline">
                      {when(s)}
                    </Link>
                    <span className="text-muted-foreground">{s.available ? tr(`${K}.places_left`, { count: s.available }) : tr(`${K}.full`)} · {pctOf(s)}%</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {quietest.length ? (
            <div className="grid gap-2">
              <h3 className="font-semibold">{tr(`${K}.week_quiet`)}</h3>
              <ul className="grid gap-2">
                {quietest.map((s) => (
                  <li key={s.sessionId} className="grid">
                    <Link href={`/admin/sessions/${s.sessionId}` as Route} className="font-medium underline-offset-4 hover:underline">
                      {when(s)}
                    </Link>
                    <span className="text-muted-foreground">{tr(`${K}.free_of`, { count: s.available, capacity: s.capacity })}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// The day's sessions
// ---------------------------------------------------------------------------------------------

function CapacityBlock({ capacity, tr, locale, now }: { capacity: DailyCapacity; tr: Tr; locale: Locale; now: Date }) {
  const { slots, total } = capacity;
  return (
    <Card data-testid="daily-capacity">
      <CardHeader>
        <CardTitle className="text-base">{tr(`${K}.today_title`)}</CardTitle>
        <CardAction>
          <Link href="/admin/bookings" className="text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
            {tr("ops.dashboard.overview.open_bookings")} →
          </Link>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-4">
        {slots.length ? (
          <p className="text-sm text-muted-foreground" data-testid="daily-capacity-total" data-capacity={total.capacity} data-booked={total.booked} data-available={total.available}>
            <span className="text-lg font-semibold text-foreground tabular-nums">{tr(`${K}.places_left`, { count: total.available })}</span>
            <span className="ml-2">{tr("ops.dashboard.overview.booked_of", { booked: total.booked, capacity: total.capacity })}</span>
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">{tr(`${K}.no_sessions`)}</p>
        )}
        <ul className="grid gap-2.5">
          {slots.map((s) => {
            const pct = pctOf(s);
            const past = s.endsAt.getTime() < now.getTime();
            const status = past ? "past" : s.available === 0 ? "full" : pct >= 75 ? "almost" : "open";
            return (
              <li key={s.sessionId}>
                <Link
                  href={`/admin/sessions/${s.sessionId}` as Route}
                  className={cn("grid grid-cols-[3.25rem_1fr_auto] items-center gap-3 rounded-2xl p-2.5 ring-1 ring-border transition hover:bg-muted/60", past && "opacity-55")}
                  data-testid="daily-slot"
                >
                  <span className="grid justify-items-center rounded-xl bg-[#f4ead3] py-1.5 leading-tight">
                    <NavIcon icon={s.kind === "night" ? "moon" : s.kind === "event" ? "ticket" : "sun"} className="size-3.5 text-[#a0621e]" />
                    <span className="text-sm font-semibold tabular-nums">{formatTime(s.startsAt, locale)}</span>
                  </span>
                  <span className="grid min-w-0 gap-1">
                    <span className="truncate text-sm font-medium">
                      {s.title} <span className="font-normal text-muted-foreground">· {formatTime(s.startsAt, locale)}–{formatTime(s.endsAt, locale)}</span>
                    </span>
                    <span className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                      <span className="block h-full rounded-full" style={{ width: `${Math.max(pct, 2)}%`, background: s.available === 0 ? "#8a5a14" : GOLD }} />
                    </span>
                    <span className="flex flex-wrap gap-x-3 text-xs text-muted-foreground tabular-nums">
                      <span>{tr("ops.dashboard.overview.booked_of", { booked: s.booked, capacity: s.capacity })}</span>
                      {s.held ? <span>{tr(`${K}.held`, { count: s.held })}</span> : null}
                      {s.waiting ? <span>{tr(`${K}.waiting`, { count: s.waiting })}</span> : null}
                    </span>
                  </span>
                  <span
                    className={cn(
                      "rounded-full px-2.5 py-1 text-xs font-medium whitespace-nowrap",
                      status === "full" && "bg-[#8a5a14] text-white",
                      status === "almost" && "bg-[#f4ead3] text-[#8a5a14]",
                      status === "open" && "bg-emerald-50 text-emerald-800",
                      status === "past" && "bg-muted text-muted-foreground",
                    )}
                  >
                    {status === "full" ? tr(`${K}.full`) : tr(`${K}.status_${status}`)}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// Who is coming
// ---------------------------------------------------------------------------------------------

const initials = (name: string | null) =>
  (name ?? "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");

function ClientsBlock({ clients, tr, locale, now }: { clients: DayClient[]; tr: Tr; locale: Locale; now: Date }) {
  return (
    <Card data-testid="daily-clients">
      <CardHeader>
        <CardTitle id="daily-clients-title" className="text-base">
          {tr(`${K}.clients_title`)}
        </CardTitle>
        <CardAction>
          <Badge variant="secondary">{tr(`${K}.clients_count`, { count: clients.length })}</Badge>
        </CardAction>
      </CardHeader>
      <CardContent>
        {clients.length === 0 ? (
          <p className="text-sm text-muted-foreground">{tr(`${K}.clients_empty`)}</p>
        ) : (
          <ul className="grid gap-3">
            {clients.map((c) => {
              const href = `/admin/persons/${c.personId}` as Route;
              const opps = clientOpportunities(c, now);
              return (
                <li key={c.personId} className="grid grid-cols-[2.5rem_1fr] gap-3 border-b pb-3 last:border-b-0 last:pb-0" data-testid="daily-client" data-person-id={c.personId}>
                  <span className={cn("flex size-10 items-center justify-center rounded-full text-sm font-semibold", c.membership ? "bg-[#212842] text-[#e8c26a]" : "bg-[#f4ead3] text-[#8a5a14]")} aria-hidden="true">
                    {initials(c.name)}
                  </span>
                  <div className="grid min-w-0 gap-1">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <Link href={href} className="font-medium underline-offset-4 hover:underline focus-visible:underline">
                        {c.name ?? "-"}
                      </Link>
                      <span className="text-sm text-muted-foreground tabular-nums">{c.sessions.map((s) => `${formatTime(s.startsAt, locale)} ${kindLabel(tr, s.kind)}`).join(" · ")}</span>
                    </div>
                    <div className="flex flex-wrap gap-1.5 text-xs">
                      {c.membership ? <Badge variant={c.membership.status === "past_due" ? "destructive" : "secondary"}>{membershipText(c.membership, tr, locale)}</Badge> : null}
                      {c.packages
                        .filter((p) => p.remaining > 0)
                        .map((p) => (
                          <Badge key={p.kind} variant="outline">
                            {tr(`${K}.package`, { kind: tr(`${K}.credit_${p.kind}`), remaining: p.remaining, total: p.total })}
                            {p.nextExpiresAt ? ` · ${tr(`${K}.until`, { date: formatDate(p.nextExpiresAt, locale) })}` : ""}
                          </Badge>
                        ))}
                    </div>
                    {opps.length ? (
                      <ul className="grid gap-0.5" data-testid="daily-opportunities">
                        {opps.map((o) => (
                          <li key={`${o.key}:${o.kind ?? ""}`} data-opportunity={o.key}>
                            <Link href={href} className="text-sm font-medium text-[#8a5a14] underline-offset-4 hover:underline focus-visible:underline">
                              → {opportunityText(o, tr, locale)}
                            </Link>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// Sessions to fill
// ---------------------------------------------------------------------------------------------

function FillBlock({ slots, canFill, tr, locale, errors }: { slots: CapacitySlot[]; canFill: boolean; tr: Tr; locale: Locale; errors: Record<string, string> }) {
  const labels = fillLabels(tr, errors);
  return (
    <Card data-testid="daily-fill">
      <CardHeader>
        <CardTitle className="text-base">{tr(`${K}.fill_title`)}</CardTitle>
      </CardHeader>
      <CardContent>
        {slots.length === 0 ? (
          <p className="text-sm text-muted-foreground">{tr(`${K}.fill_empty`)}</p>
        ) : (
          <ul className="grid gap-2">
            {slots.slice(0, FILL_SHOWN).map((s) => (
              <li key={s.sessionId} className="flex flex-wrap items-center justify-between gap-2 border-b pb-2 last:border-b-0 last:pb-0" data-testid="daily-fill-session">
                <div className="grid min-w-0 gap-0.5">
                  <Link href={`/admin/sessions/${s.sessionId}` as Route} className="truncate font-medium underline-offset-4 hover:underline focus-visible:underline">
                    {shortDay(s.startsAt, locale)} {formatTime(s.startsAt, locale)} · {kindLabel(tr, s.kind)}
                  </Link>
                  <span className="text-sm text-muted-foreground tabular-nums">
                    {tr(`${K}.free_of`, { count: s.available, capacity: s.capacity })}
                    {s.waiting ? ` · ${tr(`${K}.waiting`, { count: s.waiting })}` : ""}
                  </span>
                </div>
                {canFill ? <FillSessionButton sessionId={s.sessionId} labels={labels} /> : null}
              </li>
            ))}
          </ul>
        )}
        {slots.length > FILL_SHOWN ? (
          <Link href="/admin/sessions" className="mt-3 inline-block text-sm font-medium underline-offset-4 hover:underline">
            {tr(`${K}.fill_more`, { count: slots.length - FILL_SHOWN })} →
          </Link>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// Revenue
// ---------------------------------------------------------------------------------------------

function RevenueBlock({ r, day, tr, locale }: { r: DailyRevenue; day: string; tr: Tr; locale: Locale }) {
  const money = (c: number) => formatMoney(c, locale);
  const gross = r.groups.reduce((n, g) => n + g.sales.current, 0);
  const colours: Record<string, string> = { sessions: "#d1a64a", packages: "#8a5a14", memberships: "#212842", events: "#b9832d", other: "#c9c2b4" };
  return (
    <Card data-testid="daily-revenue" data-value={r.net.current}>
      <CardHeader>
        <CardTitle className="text-base">{tr(`${K}.revenue_title`)}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-1">
          <span className="text-3xl leading-none font-semibold tracking-tight tabular-nums">{money(r.net.current)}</span>
          <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <ChangeBadge change={r.net.change} changePct={r.net.changePct} formattedChange={money(Math.abs(r.net.change))} blankLabel={tr("ops.period.change_blank")} label={tr("ops.period.change")} locale={locale} />
            {tr(`${K}.revenue_vs`, { date: formatDate(r.compareDay, locale), amount: money(r.net.previous) })}
          </span>
        </div>
        {gross > 0 ? (
          <div className="flex h-2.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
            {r.groups
              .filter((g) => g.sales.current > 0)
              .map((g) => (
                <span key={g.key} style={{ width: `${(g.sales.current / gross) * 100}%`, background: colours[g.key] }} />
              ))}
          </div>
        ) : null}
        <table className="w-full text-sm">
          <tbody>
            {r.groups.map((g) => (
              <tr key={g.key} className="border-b last:border-b-0" data-group={g.key}>
                <th scope="row" className="py-1.5 text-left font-normal text-muted-foreground">
                  <span className="flex items-center gap-2">
                    <span className="size-2.5 rounded-full" style={{ background: colours[g.key] }} aria-hidden="true" />
                    {tr(`${K}.revenue_${g.key}`)}
                  </span>
                </th>
                <td className="py-1.5 text-right font-medium tabular-nums">{money(g.sales.current)}</td>
                <td className="py-1.5 pl-3 text-right text-xs text-muted-foreground tabular-nums">{money(g.sales.previous)}</td>
              </tr>
            ))}
            {r.refunds.current || r.refunds.previous ? (
              <tr data-group="refunds">
                <th scope="row" className="py-1.5 text-left font-normal text-muted-foreground">
                  {tr(`${K}.revenue_refunds`)}
                </th>
                <td className="py-1.5 text-right font-medium tabular-nums">-{money(r.refunds.current)}</td>
                <td className="py-1.5 pl-3 text-right text-xs text-muted-foreground tabular-nums">-{money(r.refunds.previous)}</td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <Link href={{ pathname: "/admin/reports/revenue", query: { period: "day", at: day } }} className="text-sm font-medium underline-offset-4 hover:underline">
          {tr("ops.dashboard.overview.more_figures")} →
        </Link>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// The page part
// ---------------------------------------------------------------------------------------------

export async function DailyDashboard({ ctx, tr, day, access, errors }: { ctx: OpsReadCtx; tr: Tr; day: string; access: DailyAccess; errors: Record<string, string> }) {
  const locale = ctx.locale;
  const [capacity, lastWeek, week, clients, toFill, revenue] = await Promise.all([
    getDailyCapacity(ctx.tx, { day, locale }),
    getDailyCapacity(ctx.tx, { day: shiftDay(day, -7), locale }),
    getWeekOccupancy(ctx.tx, { day, locale }),
    access.clients ? listDayClients(ctx.tx, { day, now: ctx.now }) : null,
    listSessionsToFill(ctx.tx, { now: ctx.now, locale }),
    access.revenue ? getDailyRevenue(ctx.tx, { day }) : null,
  ]);
  const today = brusselsDate(ctx.now);
  const count = (n: number) => String(n);
  const badge = (c: { change: number; changePct: number | null }, formatted: string) => (
    <ChangeBadge change={c.change} changePct={c.changePct} formattedChange={formatted} blankLabel={tr("ops.period.change_blank")} label={tr("ops.period.change")} locale={locale} />
  );
  const booked = comparePeriods(capacity.total.booked + capacity.total.held, lastWeek.total.booked + lastWeek.total.held);
  const occupancy = capacity.total.capacity ? Math.round(((capacity.total.booked + capacity.total.held) / capacity.total.capacity) * 100) : 0;
  const freeAhead = toFill.reduce((n, s) => n + s.available, 0);
  const suggestions = buildSuggestions({ toFill, clients, access, tr, locale, now: ctx.now, errors });

  return (
    <div className="grid gap-6">
      <SuggestionsStrip items={suggestions} tr={tr} />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi
          icon="calendar-check"
          label={tr(`${K}.kpi_occupancy`)}
          value={`${occupancy}%`}
          sub={tr(`${K}.kpi_occupancy_sub`, { booked: capacity.total.booked + capacity.total.held, capacity: capacity.total.capacity })}
          badge={badge(booked, count(Math.abs(booked.change)))}
          testId="daily-kpi-occupancy"
        />
        {clients ? (
          <Kpi icon="user-plus" label={tr(`${K}.kpi_clients`)} value={count(clients.length)} sub={tr(`${K}.kpi_clients_sub`, { count: clients.filter((c) => c.isFirstVisit).length })} testId="daily-kpi-clients" />
        ) : null}
        {revenue ? (
          <Kpi icon="euro" label={tr(`${K}.kpi_revenue`)} value={formatMoney(revenue.net.current, locale)} badge={badge(revenue.net, formatMoney(Math.abs(revenue.net.change), locale))} sub={tr(`${K}.vs_last_week`)} testId="daily-kpi-revenue" />
        ) : null}
        <Kpi icon="calendar-days" label={tr(`${K}.kpi_week`)} value={count(freeAhead)} sub={tr(`${K}.kpi_week_sub`, { count: toFill.length })} testId="daily-kpi-week" />
      </div>
      <WeekHeatmap week={week} day={day} today={today} now={ctx.now} tr={tr} locale={locale} />
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <div className="grid content-start gap-6">
          <CapacityBlock capacity={capacity} tr={tr} locale={locale} now={ctx.now} />
          {revenue ? <RevenueBlock r={revenue} day={day} tr={tr} locale={locale} /> : null}
        </div>
        <div className="grid content-start gap-6">
          {clients ? <ClientsBlock clients={clients} tr={tr} locale={locale} now={ctx.now} /> : null}
          <FillBlock slots={toFill} canFill={access.fill} tr={tr} locale={locale} errors={errors} />
        </div>
      </div>
    </div>
  );
}
