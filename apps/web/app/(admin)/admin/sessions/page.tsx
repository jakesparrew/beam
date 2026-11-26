import Link from "next/link";
import type { Route } from "next";
import { cn } from "@beam/ui";
import { addDays, brusselsDate, brusselsTime, isoWeekday, zonedTimeToUtc, type SessionKind } from "@beam/core/booking";
import { formatDate, formatTime, type Locale, type LocalizedText } from "@beam/core/i18n";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { listExceptions, listSessionsInRange, type SessionBlock } from "@/modules/booking/queries";
import { CalendarWeek, type CalendarDay } from "@/modules/booking/ui/calendar-week";
import { OccupancyBar, PageHeader, PeriodSwitch, PrimaryAction, Segmented, StatusPill, Surface, Toolbar, td, th, type Tone } from "@/modules/platform/ui/admin-kit";

const KINDS = ["day", "night", "event"] as const;
const L = "booking.list";

const show = (text: LocalizedText | null | undefined, locale: Locale) => text?.[locale] || text?.["nl-BE"] || text?.en || text?.["fr-BE"] || "";

/** The Monday of the Brussels week of `onDate`. */
const mondayOf = (onDate: string) => addDays(onDate, 1 - isoWeekday(onDate));

/**
 * `/admin/sessions` (`bookings.read`, booking spec 5.1): the sessions of one week, Monday to
 * Sunday, filtered by kind. The list view (default, owner review November 2026) shows each day as
 * a group of rows with fixed columns: time, session, occupancy, free places, waiting list and
 * status; `?view=week` keeps the week calendar. One primary action (a new session,
 * `bookings.override`); the schedule, closing days and blocked places live under Settings and on
 * the session page.
 */
export default async function SessionsPage({ searchParams }: { searchParams: Promise<{ week?: string; kind?: string; view?: string }> }) {
  const actor = await requireStaff({ permission: "bookings.read" });
  const sp = await searchParams;
  const locale = await adminLocale();
  const tr = translator(locale);
  const db = await getAppDb();
  const now = new Date();
  const today = brusselsDate(now);
  const week = mondayOf(/^\d{4}-\d{2}-\d{2}$/.test(sp.week ?? "") ? sp.week! : today);
  const kind = (KINDS as readonly string[]).includes(sp.kind ?? "") ? (sp.kind as SessionKind) : undefined;
  const view = sp.view === "week" ? "week" : "list";

  const [blocks, exceptions] = await Promise.all([
    listSessionsInRange(db, { from: zonedTimeToUtc(week, "00:00"), to: zonedTimeToUtc(addDays(week, 7), "00:00"), ...(kind ? { kind } : {}) }),
    listExceptions(db, { from: week, to: addDays(week, 6) }),
  ]);

  const days: CalendarDay[] = Array.from({ length: 7 }, (_, i) => {
    const onDate = addDays(week, i);
    const closed = exceptions.find((e) => e.onDate === onDate && (!e.templateIds || e.templateIds.length === 0) && e.kind !== "special_hours");
    return {
      onDate,
      label: formatDate(onDate, locale, "full"),
      isToday: onDate === today,
      closedLabel: closed ? tr("booking.day.closed_banner", { name: show(closed.name, locale) }) : null,
      blocks: blocks
        .filter((b) => brusselsDate(b.startsAt) === onDate)
        .map((b) => ({
          id: b.id,
          time: brusselsTime(b.startsAt),
          title: show(b.title, locale),
          kindLabel: b.eventCategory ? tr(`booking.eventCategory.${b.eventCategory}`) : tr(`booking.kind.${b.kind}`),
          status: b.status,
          statusLabel: b.status === "open" ? null : tr(`booking.availability.${b.status}`),
          booked: tr("booking.calendar.booked_of_capacity", { booked: b.booked, capacity: b.capacity }),
          held: b.held > 0 ? tr("booking.calendar.held", { count: b.held }) : null,
          waiting: b.waiting > 0 ? tr("booking.calendar.waiting", { count: b.waiting }) : null,
          lead: b.isLeadMagnet ? tr("booking.calendar.lead_badge") : null,
          draft: b.publishedAt ? null : tr("booking.session.draft"),
          full: b.availableTotal === 0 && b.status !== "cancelled",
        })),
    };
  });

  const href = (q: { week?: string; kind?: string; view?: string }) => {
    const p = new URLSearchParams();
    if (q.week) p.set("week", q.week);
    if (q.kind) p.set("kind", q.kind);
    if (q.view && q.view !== "list") p.set("view", q.view);
    const s = p.toString();
    return (s ? `/admin/sessions?${s}` : "/admin/sessions") as Route;
  };
  const state = (b: SessionBlock): { tone: Tone; label: string } => {
    if (b.status === "cancelled") return { tone: "bad", label: tr(`${L}.status_cancelled`) };
    if (b.status === "closed") return { tone: "muted", label: tr(`${L}.status_closed`) };
    if (!b.publishedAt) return { tone: "gold", label: tr(`${L}.status_draft`) };
    if (b.endsAt.getTime() < now.getTime()) return { tone: "muted", label: tr(`${L}.status_past`) };
    if (b.availableTotal <= 0) return { tone: "full", label: tr(`${L}.status_full`) };
    if (b.capacity && (b.booked + b.held) / b.capacity >= 0.75) return { tone: "warn", label: tr(`${L}.status_almost`) };
    return { tone: "ok", label: tr(`${L}.status_open`) };
  };

  return (
    <div className="grid gap-5">
      <PageHeader
        title={tr("booking.calendar.title")}
        description={tr(`${L}.subtitle`)}
        actions={hasPermission(actor, "bookings.override") ? <PrimaryAction href="/admin/sessions/new">+ {tr("booking.calendar.new_session")}</PrimaryAction> : null}
      />
      <Toolbar>
        <PeriodSwitch
          label={tr(`${L}.week_range`, { from: formatDate(week, locale), to: formatDate(addDays(week, 6), locale) })}
          previous={href({ week: addDays(week, -7), kind, view })}
          next={href({ week: addDays(week, 7), kind, view })}
          today={href({ kind, view })}
          todayLabel={tr("booking.calendar.today")}
          previousLabel={tr("booking.calendar.previous_week")}
          nextLabel={tr("booking.calendar.next_week")}
        />
        <Segmented
          label={tr("booking.calendar.filter_kind")}
          items={[
            { key: "all", label: tr("booking.calendar.all_kinds"), href: href({ week, view }), active: !kind },
            ...KINDS.map((k) => ({ key: k, label: tr(`booking.kind.${k}`), href: href({ week, kind: k, view }), active: kind === k })),
          ]}
        />
        <div className="ml-auto">
          <Segmented
            label={tr(`${L}.view_label`)}
            items={[
              { key: "list", label: tr(`${L}.view_list`), href: href({ week, kind }), active: view === "list" },
              { key: "week", label: tr(`${L}.view_week`), href: href({ week, kind, view: "week" }), active: view === "week" },
            ]}
          />
        </div>
      </Toolbar>
      {view === "week" ? (
        <CalendarWeek days={days} empty={blocks.length === 0 ? tr("booking.calendar.empty") : null} />
      ) : (
        <Surface flush data-testid="sessions-list">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[46rem] text-[0.8125rem]">
              <thead className="bg-[#faf9f6]">
                <tr className="border-b border-border">
                  <th scope="col" className={cn(th, "w-36")}>{tr(`${L}.col_time`)}</th>
                  <th scope="col" className={th}>{tr(`${L}.col_session`)}</th>
                  <th scope="col" className={cn(th, "w-48")}>{tr(`${L}.col_occupancy`)}</th>
                  <th scope="col" className={cn(th, "w-20 text-right")}>{tr(`${L}.col_free`)}</th>
                  <th scope="col" className={cn(th, "w-24 text-right")}>{tr(`${L}.col_waiting`)}</th>
                  <th scope="col" className={cn(th, "w-28")}>{tr(`${L}.col_status`)}</th>
                </tr>
              </thead>
              {days.map((d) => {
                const dayBlocks = blocks.filter((b) => brusselsDate(b.startsAt) === d.onDate);
                const booked = dayBlocks.reduce((n, b) => n + b.booked + b.held, 0);
                const capacity = dayBlocks.reduce((n, b) => n + b.capacity, 0);
                return (
                  <tbody key={d.onDate} data-day={d.onDate}>
                    <tr className="border-b border-border bg-[#fcfbf9]">
                      <th scope="rowgroup" colSpan={6} className="px-5 py-2 text-left font-normal">
                        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                          <span className="text-[0.8125rem] font-semibold first-letter:uppercase">{d.label}</span>
                          {d.isToday ? <StatusPill tone="info">{tr(`${L}.today_badge`)}</StatusPill> : null}
                          {d.closedLabel ? <StatusPill tone="bad">{d.closedLabel}</StatusPill> : null}
                          <span className="text-[0.75rem] text-muted-foreground">
                            {dayBlocks.length ? tr(`${L}.day_summary`, { count: dayBlocks.length, booked, capacity }) : tr(`${L}.day_empty`)}
                          </span>
                        </span>
                      </th>
                    </tr>
                    {dayBlocks.map((b) => {
                      const st = state(b);
                      const past = b.endsAt.getTime() < now.getTime();
                      const link = `/admin/sessions/${b.id}` as Route;
                      return (
                        <tr key={b.id} className={cn("border-b border-border hover:bg-[#faf9f6]", past && "text-muted-foreground")} data-testid="sessions-row">
                          <td className={cn(td, "font-semibold whitespace-nowrap")}>
                            <Link href={link} className="hover:underline">
                              {formatTime(b.startsAt, locale)}–{formatTime(b.endsAt, locale)}
                            </Link>
                          </td>
                          <td className={td}>
                            <Link href={link} className="flex flex-wrap items-center gap-x-2 gap-y-1 hover:underline">
                              <span className={cn("font-medium", !past && "text-foreground")}>{show(b.title, locale)}</span>
                              {(() => {
                                const kindText = b.eventCategory ? tr(`booking.eventCategory.${b.eventCategory}`) : tr(`booking.kind.${b.kind}`);
                                return kindText === show(b.title, locale) ? null : <span className="text-[0.75rem] text-muted-foreground">{kindText}</span>;
                              })()}
                              {b.isLeadMagnet ? <StatusPill tone="gold">{tr("booking.calendar.lead_badge")}</StatusPill> : null}
                            </Link>
                          </td>
                          <td className={td}>
                            <OccupancyBar taken={b.booked + b.held} capacity={b.capacity} full={b.availableTotal <= 0} />
                          </td>
                          <td className={cn(td, "text-right font-semibold tabular-nums")}>{b.status === "cancelled" ? "–" : Math.max(0, b.availableTotal)}</td>
                          <td className={cn(td, "text-right tabular-nums")}>{b.waiting ? <span className="font-semibold text-[var(--status-warn)]">{b.waiting}</span> : <span className="text-muted-foreground">–</span>}</td>
                          <td className={td}>
                            <StatusPill tone={st.tone}>{st.label}</StatusPill>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                );
              })}
            </table>
          </div>
        </Surface>
      )}
    </div>
  );
}
