/**
 * The four day blocks at the top of `/admin/dashboard` (owner requirements 6): capacity per
 * session, who is coming with their membership and package status and what to offer them, the
 * sessions of the next 7 days with free places ("fill this session"), and the revenue of the
 * day. Each block shows only when the viewer may see it (`dailyAccess`).
 */
import type { Route } from "next";
import Link from "next/link";
import { Badge, Card, CardAction, CardContent, CardHeader, CardTitle } from "@beam/ui";
import { formatDate, formatMoney, formatTime, type Locale } from "@beam/core/i18n";
import {
  clientOpportunities,
  getDailyCapacity,
  getDailyRevenue,
  listDayClients,
  listSessionsToFill,
  type CapacitySlot,
  type DailyAccess,
  type DayClient,
  type Opportunity,
} from "../dashboard/daily";
import { FILL_REASONS } from "../dashboard/fill-session";
import type { OpsReadCtx } from "../reports/registry";
import { ChangeBadge } from "./ChangeBadge";
import { FillSessionButton, type FillSessionLabels } from "./FillSessionButton";

type Tr = (key: string, params?: Record<string, string | number>) => string;
const K = "ops.dashboard.daily";

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

function CapacityBlock({ slots, total, tr, locale, now }: { slots: CapacitySlot[]; total: { capacity: number; booked: number; held: number; available: number }; tr: Tr; locale: Locale; now: Date }) {
  return (
    <section aria-labelledby="daily-capacity" className="relative grid gap-4 overflow-hidden rounded-[1.25rem] bg-[#212842] p-5 text-[#fffaef] sm:p-6" data-testid="daily-capacity">
      <div aria-hidden="true" className="pointer-events-none absolute -top-24 -right-16 size-64 rounded-full bg-[radial-gradient(circle,rgba(232,194,106,0.35),transparent_65%)]" />
      <div className="relative flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="daily-capacity" className="text-xs font-semibold tracking-[0.25em] text-[#e8c26a] uppercase">
            {tr(`${K}.capacity_title`)}
          </h2>
          {slots.length ? (
            <p className="mt-1 text-3xl font-semibold tracking-tight tabular-nums" data-testid="daily-capacity-total" data-capacity={total.capacity} data-booked={total.booked} data-available={total.available}>
              {tr(`${K}.places_left`, { count: total.available })}
              <span className="ml-2 text-sm font-normal tracking-normal text-[#fffaef]/70">{tr("ops.dashboard.overview.booked_of", { booked: total.booked, capacity: total.capacity })}</span>
            </p>
          ) : (
            <p className="mt-1 text-[#fffaef]/80">{tr(`${K}.no_sessions`)}</p>
          )}
        </div>
        <Link href="/admin/bookings" className="rounded-full bg-[#fffaef]/10 px-4 py-2 text-sm font-medium hover:bg-[#fffaef]/20">
          {tr("ops.dashboard.overview.open_bookings")} →
        </Link>
      </div>
      {slots.length ? (
        <ul className="relative grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {slots.map((s) => {
            const pct = s.capacity ? Math.min(100, Math.round(((s.booked + s.held) / s.capacity) * 100)) : 0;
            const past = s.endsAt.getTime() < now.getTime();
            return (
              <li key={s.sessionId}>
                <Link
                  href={`/admin/sessions/${s.sessionId}` as Route}
                  className={`grid gap-3 rounded-2xl bg-[#fffaef]/[0.06] p-4 ring-1 ring-[#fffaef]/10 transition hover:bg-[#fffaef]/10 focus-visible:outline-2 focus-visible:outline-[#e8c26a] ${past ? "opacity-55" : ""}`}
                  data-testid="daily-slot"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-xl font-semibold tabular-nums">
                      {formatTime(s.startsAt, locale)}
                      <span className="text-sm font-normal text-[#fffaef]/60"> – {formatTime(s.endsAt, locale)}</span>
                    </span>
                    <span className="rounded-full bg-[#e8c26a]/15 px-2.5 py-0.5 text-xs text-[#e8c26a]">{kindLabel(tr, s.kind)}</span>
                  </div>
                  <span className="truncate text-sm text-[#fffaef]/80">{s.title}</span>
                  <div className="h-1.5 overflow-hidden rounded-full bg-[#fffaef]/10" aria-hidden="true">
                    <div className={`h-full rounded-full ${s.available === 0 ? "bg-[#e07a5f]" : "bg-[linear-gradient(90deg,#b57627,#f7cc78)]"}`} style={{ width: `${Math.max(pct, 2)}%` }} />
                  </div>
                  <span className="flex flex-wrap gap-x-3 text-xs text-[#fffaef]/75 tabular-nums">
                    <span>{tr("ops.dashboard.overview.booked_of", { booked: s.booked, capacity: s.capacity })}</span>
                    <span className="font-medium text-[#fffaef]">{s.available ? tr(`${K}.places_left`, { count: s.available }) : tr(`${K}.full`)}</span>
                    {s.held ? <span>{tr(`${K}.held`, { count: s.held })}</span> : null}
                    {s.waiting ? <span>{tr(`${K}.waiting`, { count: s.waiting })}</span> : null}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

function ClientsBlock({ clients, tr, locale, now }: { clients: DayClient[]; tr: Tr; locale: Locale; now: Date }) {
  return (
    <Card data-testid="daily-clients">
      <CardHeader>
        <CardTitle className="text-base">{tr(`${K}.clients_title`)}</CardTitle>
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
                <li key={c.personId} className="grid gap-1 border-b pb-3 last:border-b-0 last:pb-0" data-testid="daily-client" data-person-id={c.personId}>
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
                          <Link href={href} className="text-sm font-medium text-[#a0621e] underline-offset-4 hover:underline focus-visible:underline">
                            → {opportunityText(o, tr, locale)}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function FillBlock({ slots, canFill, tr, locale, errors }: { slots: CapacitySlot[]; canFill: boolean; tr: Tr; locale: Locale; errors: Record<string, string> }) {
  const labels: FillSessionLabels = {
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
            {slots.map((s) => (
              <li key={s.sessionId} className="flex flex-wrap items-center justify-between gap-2 border-b pb-2 last:border-b-0 last:pb-0" data-testid="daily-fill-session">
                <div className="grid min-w-0 gap-0.5">
                  <Link href={`/admin/sessions/${s.sessionId}` as Route} className="truncate font-medium underline-offset-4 hover:underline focus-visible:underline">
                    {new Intl.DateTimeFormat(locale, { timeZone: "Europe/Brussels", weekday: "short", day: "numeric", month: "short" }).format(s.startsAt)} {formatTime(s.startsAt, locale)} · {kindLabel(tr, s.kind)}
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
      </CardContent>
    </Card>
  );
}

async function RevenueBlock({ ctx, day, tr }: { ctx: OpsReadCtx; day: string; tr: Tr }) {
  const r = await getDailyRevenue(ctx.tx, { day });
  const money = (c: number) => formatMoney(c, ctx.locale);
  const badge = (c: { change: number; changePct: number | null }) => (
    <ChangeBadge change={c.change} changePct={c.changePct} formattedChange={money(Math.abs(c.change))} blankLabel={tr("ops.period.change_blank")} label={tr("ops.period.change")} locale={ctx.locale} />
  );
  return (
    <Card data-testid="daily-revenue" data-value={r.net.current}>
      <CardHeader>
        <CardTitle className="text-base">{tr(`${K}.revenue_title`)}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-1">
          <span className="text-3xl leading-none font-semibold tracking-tight tabular-nums">{money(r.net.current)}</span>
          <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {badge(r.net)}
            {tr(`${K}.revenue_vs`, { date: formatDate(r.compareDay, ctx.locale), amount: money(r.net.previous) })}
          </span>
        </div>
        <table className="w-full text-sm">
          <tbody>
            {r.groups.map((g) => (
              <tr key={g.key} className="border-b last:border-b-0" data-group={g.key}>
                <th scope="row" className="py-1.5 text-left font-normal text-muted-foreground">
                  {tr(`${K}.revenue_${g.key}`)}
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

export async function DailyDashboard({ ctx, tr, day, access, errors }: { ctx: OpsReadCtx; tr: Tr; day: string; access: DailyAccess; errors: Record<string, string> }) {
  const [capacity, clients, toFill, revenue] = await Promise.all([
    getDailyCapacity(ctx.tx, { day, locale: ctx.locale }),
    access.clients ? listDayClients(ctx.tx, { day, now: ctx.now }) : null,
    listSessionsToFill(ctx.tx, { now: ctx.now, locale: ctx.locale }),
    access.revenue ? RevenueBlock({ ctx, day, tr }) : null,
  ]);
  return (
    <div className="grid gap-6">
      <CapacityBlock slots={capacity.slots} total={capacity.total} tr={tr} locale={ctx.locale} now={ctx.now} />
      <div className="grid gap-6 lg:grid-cols-2">
        {clients ? <ClientsBlock clients={clients} tr={tr} locale={ctx.locale} now={ctx.now} /> : null}
        <div className="grid content-start gap-6">
          {revenue}
          <FillBlock slots={toFill} canFill={access.fill} tr={tr} locale={ctx.locale} errors={errors} />
        </div>
      </div>
    </div>
  );
}
