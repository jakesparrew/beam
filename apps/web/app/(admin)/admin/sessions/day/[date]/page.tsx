import Link from "next/link";
import type { Route } from "next";
import { notFound } from "next/navigation";
import { buttonVariants } from "@beam/ui";
import { addDays, brusselsTime } from "@beam/core/booking";
import { formatDate, type Locale, type LocalizedText } from "@beam/core/i18n";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { getDayView } from "@/modules/booking/queries";
import { DayView } from "@/modules/booking/ui/day-view";

const show = (text: LocalizedText | null | undefined, locale: Locale) => text?.[locale] || text?.["nl-BE"] || text?.en || text?.["fr-BE"] || "";

/**
 * `/admin/sessions/day/[date]` (`bookings.read`, booking spec 5.1): the day's sessions with
 * availability, attendees, check-in progress and unpaid pay-at-desk rows; opening hours or the
 * closed-day banner; close/reopen (`bookings.write`) and the printable day list.
 */
export default async function SessionDayPage({ params }: { params: Promise<{ date: string }> }) {
  const actor = await requireStaff({ permission: "bookings.read" });
  const { date } = await params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T12:00:00Z`))) notFound();
  const locale = await adminLocale();
  const tr = translator(locale);
  const db = await getAppDb();
  const view = await getDayView(db, { onDate: date });

  const closing = view.exceptions.find((e) => (!e.templateIds || e.templateIds.length === 0) && e.kind !== "special_hours");
  const banner = closing
    ? tr("booking.day.closed_banner", { name: show(closing.name, locale) })
    : view.openingHours
      ? tr("booking.day.opening_hours", { opens: view.openingHours.opensAt, closes: view.openingHours.closesAt })
      : null;

  const items = view.sessions.map((s) => ({
    id: s.id,
    time: `${brusselsTime(s.startsAt)}–${brusselsTime(s.endsAt)}`,
    title: show(s.title, locale),
    kindLabel: s.eventCategory ? tr(`booking.eventCategory.${s.eventCategory}`) : tr(`booking.kind.${s.kind}`),
    status: s.status,
    statusLabel: s.status === "open" ? tr("booking.session.published") : s.status === "closed" ? tr("booking.day.close_session") : tr("booking.status.cancelled"),
    capacity: s.capacity,
    used: s.capacity - s.availableTotal,
    bookedLabel: tr("booking.session.capacity_label", { booked: s.booked, capacity: s.capacity }),
    attendeesLabel: tr("booking.day.attendees", { count: s.attendees }),
    checkedInLabel: tr("booking.day.checked_in", { done: s.checkedIn, total: s.attendees }),
    unpaidLabel: s.unpaidAtDesk > 0 ? tr("booking.day.unpaid_desk", { count: s.unpaidAtDesk }) : null,
    location: s.location,
  }));

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{tr("booking.day.title", { date: formatDate(date, locale, "full") })}</h1>
        <div className="flex flex-wrap gap-2">
          <Link href={`/admin/sessions/day/${addDays(date, -1)}` as Route} className={buttonVariants({ variant: "outline", size: "sm" })}>
            ←
          </Link>
          <Link href={`/admin/sessions/day/${addDays(date, 1)}` as Route} className={buttonVariants({ variant: "outline", size: "sm" })}>
            →
          </Link>
          <Link href={`/admin/sessions?week=${date}` as Route} className={buttonVariants({ variant: "outline", size: "sm" })}>
            {tr("booking.calendar.title")}
          </Link>
          <Link href={`/admin/sessions/day/${date}/print` as Route} className={buttonVariants({ size: "sm" })}>
            {tr("booking.day.print")}
          </Link>
        </div>
      </div>
      {view.conflicts.length ? (
        <section className="rounded-md border border-destructive p-3 text-sm" aria-labelledby="conflicts">
          <h2 id="conflicts" className="font-medium">
            {tr("booking.exceptions.conflicts_title")}
          </h2>
          <ul className="list-disc pl-4">
            {view.conflicts.map((c) => (
              <li key={c.sessionId}>{tr("booking.exceptions.conflict_row", { time: brusselsTime(c.startsAt), count: c.liveBookings })}</li>
            ))}
          </ul>
        </section>
      ) : null}
      <DayView
        items={items}
        banner={banner}
        empty={tr("booking.day.empty")}
        canWrite={hasPermission(actor, "bookings.write")}
        labels={{
          close: tr("booking.day.close_session"),
          reopen: tr("booking.day.reopen_session"),
          error: tr("booking.errors.invalid_transition"),
          forbidden: tr("platform.errors.forbidden"),
          availability: tr("booking.session.capacity"),
        }}
      />
    </div>
  );
}
