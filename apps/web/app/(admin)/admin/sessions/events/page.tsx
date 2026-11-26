import Link from "next/link";
import type { Route } from "next";
import { cn, EmptyState } from "@beam/ui";
import { brusselsTime } from "@beam/core/booking";
import { type Locale, type LocalizedText } from "@beam/core/i18n";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { listSessionsInRange, type SessionBlock } from "@/modules/booking/queries";
import { OccupancyBar, PageHeader, PrimaryAction, SecondaryAction, Segmented, StatusPill, Surface, Toolbar, td, th, type Tone } from "@/modules/platform/ui/admin-kit";

const show = (text: LocalizedText | null | undefined, locale: Locale) => text?.[locale] || text?.["nl-BE"] || text?.en || text?.["fr-BE"] || "";
const DAY = 86_400_000;
const FILTERS = ["all", "events", "webinars"] as const;
const L = "booking.list";

/**
 * `/admin/sessions/events` (`bookings.read`, owner requirements 4 and 5): events and WebinarGeek
 * webinars from a week ago on, any date, outside the day and night schedules, as one table (date,
 * title and kind, place, occupancy, status). Each row opens the session page (details, artwork,
 * materials, registrations and the CSV export); "New event" and "New webinar" open
 * `/admin/sessions/new` with the category chosen (`bookings.override`).
 */
export default async function EventsPage({ searchParams }: { searchParams: Promise<{ show?: string }> }) {
  const actor = await requireStaff({ permission: "bookings.read" });
  const locale = await adminLocale();
  const tr = translator(locale);
  const wanted = (await searchParams).show;
  const filter = (FILTERS as readonly string[]).includes(wanted ?? "") ? (wanted as (typeof FILTERS)[number]) : "all";
  const now = new Date().getTime();
  const all = await listSessionsInRange(await getAppDb(), { from: new Date(now - 7 * DAY), to: new Date(now + 3 * 365 * DAY), kind: "event" });
  const isWebinar = (s: SessionBlock) => s.eventCategory === "webinar";
  const matches = (f: (typeof FILTERS)[number]) => (s: SessionBlock) => (f === "webinars" ? isWebinar(s) : f === "events" ? !isWebinar(s) : true);
  const rows = all.filter(matches(filter));
  const canCreate = hasPermission(actor, "bookings.override");
  const state = (s: SessionBlock): { tone: Tone; label: string } => {
    if (s.status === "cancelled") return { tone: "bad", label: tr(`${L}.status_cancelled`) };
    if (!s.publishedAt) return { tone: "gold", label: tr(`${L}.status_draft`) };
    if (s.endsAt.getTime() < now) return { tone: "muted", label: tr(`${L}.status_past`) };
    if (s.capacity && s.availableTotal <= 0) return { tone: "full", label: tr(`${L}.status_full`) };
    return { tone: "ok", label: tr(`${L}.status_open`) };
  };
  const day = new Intl.DateTimeFormat(locale, { timeZone: "Europe/Brussels", day: "numeric" });
  const month = new Intl.DateTimeFormat(locale, { timeZone: "Europe/Brussels", month: "short" });
  const weekday = new Intl.DateTimeFormat(locale, { timeZone: "Europe/Brussels", weekday: "long" });

  return (
    <div className="grid gap-5">
      <PageHeader
        title={tr("booking.event.list_title")}
        description={tr("booking.event.list_intro")}
        actions={
          canCreate ? (
            <>
              <SecondaryAction href="/admin/sessions/new?category=webinar">+ {tr("booking.event.new_webinar")}</SecondaryAction>
              <PrimaryAction href="/admin/sessions/new?category=lecture">+ {tr("booking.event.new_event")}</PrimaryAction>
            </>
          ) : null
        }
      />
      <Toolbar>
        <Segmented
          label={tr("booking.event.filter")}
          items={FILTERS.map((f) => ({ key: f, label: tr(`booking.event.filter_${f}`), href: `/admin/sessions/events${f === "all" ? "" : `?show=${f}`}` as Route, active: f === filter, count: all.filter(matches(f)).length }))}
        />
      </Toolbar>
      {rows.length === 0 ? (
        <EmptyState title={tr("booking.event.list_empty")} />
      ) : (
        <Surface flush data-testid="events-list">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[46rem] text-[0.8125rem]">
              <thead className="bg-[#faf9f6]">
                <tr className="border-b border-border">
                  <th scope="col" className={cn(th, "w-40")}>{tr(`${L}.col_time`)}</th>
                  <th scope="col" className={th}>{tr("booking.event.details")}</th>
                  <th scope="col" className={cn(th, "w-48")}>{tr(`${L}.col_occupancy`)}</th>
                  <th scope="col" className={cn(th, "w-28")}>{tr(`${L}.col_status`)}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => {
                  const st = state(s);
                  const past = s.endsAt.getTime() < now;
                  const link = `/admin/sessions/${s.id}` as Route;
                  return (
                    <tr key={s.id} className={cn("border-b border-border last:border-b-0 hover:bg-[#faf9f6]", past && "text-muted-foreground")}>
                      <td className={td}>
                        <Link href={link} className="flex items-center gap-3">
                          <span className="grid w-11 shrink-0 justify-items-center rounded-lg border border-border bg-card py-1 leading-tight">
                            <span className="text-[0.625rem] font-semibold text-[#8a5a14] uppercase">{month.format(s.startsAt)}</span>
                            <span className="text-[1rem] font-semibold text-foreground">{day.format(s.startsAt)}</span>
                          </span>
                          <span className="grid leading-tight">
                            <span className="font-medium text-foreground first-letter:uppercase">{weekday.format(s.startsAt)}</span>
                            <span className="text-[0.75rem] text-muted-foreground">
                              {brusselsTime(s.startsAt)}–{brusselsTime(s.endsAt)}
                            </span>
                          </span>
                        </Link>
                      </td>
                      <td className={td}>
                        <Link href={link} className="grid gap-0.5 hover:underline">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className={cn("font-semibold", !past && "text-foreground")}>{show(s.title, locale)}</span>
                            <StatusPill tone={isWebinar(s) ? "info" : "gold"}>{tr(`booking.eventCategory.${s.eventCategory ?? "special_activity"}`)}</StatusPill>
                          </span>
                          <span className="text-[0.75rem] text-muted-foreground">{isWebinar(s) ? "WebinarGeek" : (s.location ?? "–")}</span>
                        </Link>
                      </td>
                      <td className={td}>{s.capacity ? <OccupancyBar taken={s.booked + s.held} capacity={s.capacity} full={s.availableTotal <= 0} /> : <span className="text-muted-foreground">{s.booked}</span>}</td>
                      <td className={td}>
                        <StatusPill tone={st.tone}>{st.label}</StatusPill>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Surface>
      )}
    </div>
  );
}
