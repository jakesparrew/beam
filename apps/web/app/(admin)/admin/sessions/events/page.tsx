import Link from "next/link";
import type { Route } from "next";
import { Badge, buttonVariants, EmptyState } from "@beam/ui";
import { brusselsTime } from "@beam/core/booking";
import { formatDate, type Locale, type LocalizedText } from "@beam/core/i18n";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { listSessionsInRange } from "@/modules/booking/queries";

const show = (text: LocalizedText | null | undefined, locale: Locale) => text?.[locale] || text?.["nl-BE"] || text?.en || text?.["fr-BE"] || "";
const DAY = 86_400_000;
const FILTERS = ["all", "events", "webinars"] as const;

/**
 * `/admin/sessions/events` (`bookings.read`, owner requirements 4 and 5): events and WebinarGeek
 * webinars from a week ago on, any date, outside the day and night schedules. Each row opens the
 * session page (details, artwork, materials, registrations and the CSV export); "New event" and
 * "New webinar" open `/admin/sessions/new` with the category chosen (`bookings.override`).
 */
export default async function EventsPage({ searchParams }: { searchParams: Promise<{ show?: string }> }) {
  const actor = await requireStaff({ permission: "bookings.read" });
  const locale = await adminLocale();
  const tr = translator(locale);
  const wanted = (await searchParams).show;
  const filter = (FILTERS as readonly string[]).includes(wanted ?? "") ? (wanted as (typeof FILTERS)[number]) : "all";
  const now = new Date().getTime();
  const all = await listSessionsInRange(await getAppDb(), { from: new Date(now - 7 * DAY), to: new Date(now + 3 * 365 * DAY), kind: "event" });
  const rows = all.filter((s) => (filter === "webinars" ? s.eventCategory === "webinar" : filter === "events" ? s.eventCategory !== "webinar" : true));
  const canCreate = hasPermission(actor, "bookings.override");

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="grid gap-1">
          <h1 className="text-2xl font-semibold">{tr("booking.event.list_title")}</h1>
          <p className="text-muted-foreground">{tr("booking.event.list_intro")}</p>
        </div>
        {canCreate ? (
          <div className="flex flex-wrap gap-2">
            <Link href="/admin/sessions/new?category=lecture" className={buttonVariants({ size: "sm" })}>
              {tr("booking.event.new_event")}
            </Link>
            <Link href="/admin/sessions/new?category=webinar" className={buttonVariants({ variant: "outline", size: "sm" })}>
              {tr("booking.event.new_webinar")}
            </Link>
          </div>
        ) : null}
      </div>
      <nav aria-label={tr("booking.event.filter")} className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <Link
            key={f}
            href={`/admin/sessions/events${f === "all" ? "" : `?show=${f}`}` as Route}
            aria-current={f === filter ? "page" : undefined}
            className={buttonVariants({ variant: f === filter ? "default" : "outline", size: "sm" })}
          >
            {tr(`booking.event.filter_${f}`)}
          </Link>
        ))}
      </nav>
      {rows.length === 0 ? (
        <EmptyState title={tr("booking.event.list_empty")} />
      ) : (
        <ul className="grid gap-2" data-testid="events-list">
          {rows.map((s) => (
            <li key={s.id}>
              <Link href={`/admin/sessions/${s.id}` as Route} className="flex flex-wrap items-center justify-between gap-3 rounded-md border px-4 py-3 hover:bg-muted/50">
                <span className="grid gap-0.5">
                  <span className="font-medium">{show(s.title, locale)}</span>
                  <span className="text-sm text-muted-foreground">
                    {formatDate(s.startsAt, locale, "full")} · {brusselsTime(s.startsAt)}–{brusselsTime(s.endsAt)}
                    {s.location ? ` · ${s.location}` : ""}
                  </span>
                </span>
                <span className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge variant="outline">{tr(`booking.eventCategory.${s.eventCategory ?? "special_activity"}`)}</Badge>
                  {s.publishedAt ? null : <Badge variant="secondary">{tr("booking.session.draft")}</Badge>}
                  {s.status === "cancelled" ? <Badge variant="destructive">{tr("booking.sessionStatus.cancelled")}</Badge> : null}
                  <span className="tabular-nums">{tr("booking.event.booked_of", { booked: s.booked, capacity: s.capacity })}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
