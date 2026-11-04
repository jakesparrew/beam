import Link from "next/link";
import type { Route } from "next";
import { buttonVariants, cn } from "@beam/ui";
import { addDays, brusselsDate, brusselsTime, isoWeekday, zonedTimeToUtc, type SessionKind } from "@beam/core/booking";
import { formatDate, type Locale, type LocalizedText } from "@beam/core/i18n";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { listExceptions, listSessionsInRange } from "@/modules/booking/queries";
import { CalendarWeek, type CalendarDay } from "@/modules/booking/ui/calendar-week";

const KINDS = ["day", "night", "event"] as const;

const show = (text: LocalizedText | null | undefined, locale: Locale) => text?.[locale] || text?.["nl-BE"] || text?.en || text?.["fr-BE"] || "";

/** The Monday of the Brussels week of `onDate`. */
const mondayOf = (onDate: string) => addDays(onDate, 1 - isoWeekday(onDate));

/**
 * `/admin/sessions` (`bookings.read`, booking spec 5.1): the week calendar, Monday to Sunday,
 * filtered by kind, with links to the day view, a new session (`bookings.override`) and the
 * schedule screens (`settings.write`).
 */
export default async function SessionsPage({ searchParams }: { searchParams: Promise<{ week?: string; kind?: string }> }) {
  const actor = await requireStaff({ permission: "bookings.read" });
  const sp = await searchParams;
  const locale = await adminLocale();
  const tr = translator(locale);
  const db = await getAppDb();
  const today = brusselsDate(new Date());
  const week = mondayOf(/^\d{4}-\d{2}-\d{2}$/.test(sp.week ?? "") ? sp.week! : today);
  const kind = (KINDS as readonly string[]).includes(sp.kind ?? "") ? (sp.kind as SessionKind) : undefined;

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
      closedLabel: closed ? tr("booking.day.closed_banner", { name: show(closed.name as LocalizedText, locale) }) : null,
      blocks: blocks
        .filter((b) => brusselsDate(b.startsAt) === onDate)
        .map((b) => ({
          id: b.id,
          time: brusselsTime(b.startsAt),
          title: show(b.title, locale),
          kindLabel: b.eventCategory ? tr(`booking.eventCategory.${b.eventCategory}`) : tr(`booking.kind.${b.kind}`),
          status: b.status,
          statusLabel: b.status === "open" ? null : b.status === "closed" ? tr("booking.day.close_session") : tr("booking.status.cancelled"),
          booked: tr("booking.calendar.booked_of_capacity", { booked: b.booked, capacity: b.capacity }),
          held: b.held > 0 ? tr("booking.calendar.held", { count: b.held }) : null,
          waiting: b.waiting > 0 ? tr("booking.calendar.waiting", { count: b.waiting }) : null,
          lead: b.isLeadMagnet ? tr("booking.calendar.lead_badge") : null,
          draft: b.publishedAt ? null : tr("booking.session.draft"),
          full: b.availableTotal === 0 && b.status !== "cancelled",
        })),
    };
  });

  const href = (q: { week?: string; kind?: string }) => {
    const p = new URLSearchParams();
    if (q.week) p.set("week", q.week);
    if (q.kind) p.set("kind", q.kind);
    const s = p.toString();
    return (s ? `/admin/sessions?${s}` : "/admin/sessions") as Route;
  };
  const chip = (active: boolean) => cn("rounded-full border px-3 py-1 text-sm", active ? "border-primary bg-primary text-primary-foreground" : "hover:bg-accent");

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{tr("booking.calendar.title")}</h1>
        <div className="flex flex-wrap gap-2">
          {hasPermission(actor, "bookings.override") ? (
            <Link href="/admin/sessions/new" className={buttonVariants()}>
              {tr("booking.calendar.new_session")}
            </Link>
          ) : null}
          {hasPermission(actor, "settings.write") ? (
            <>
              <Link href="/admin/sessions/templates" className={buttonVariants({ variant: "outline" })}>
                {tr("booking.calendar.go_templates")}
              </Link>
              <Link href="/admin/sessions/exceptions" className={buttonVariants({ variant: "outline" })}>
                {tr("booking.nav.exceptions")}
              </Link>
              <Link href="/admin/sessions/rules" className={buttonVariants({ variant: "outline" })}>
                {tr("booking.nav.rules")}
              </Link>
            </>
          ) : null}
          <Link href="/admin/sessions/holds" className={buttonVariants({ variant: "outline" })}>
            {tr("booking.nav.holds")}
          </Link>
        </div>
      </div>
      <nav className="flex flex-wrap items-center gap-2" aria-label={tr("booking.calendar.week_of", { date: formatDate(week, locale, "long") })}>
        <Link href={href({ week: addDays(week, -7), kind })} className={buttonVariants({ variant: "outline", size: "sm" })}>
          {tr("booking.calendar.previous_week")}
        </Link>
        <Link href={href({ kind })} className={buttonVariants({ variant: "outline", size: "sm" })}>
          {tr("booking.calendar.today")}
        </Link>
        <Link href={href({ week: addDays(week, 7), kind })} className={buttonVariants({ variant: "outline", size: "sm" })}>
          {tr("booking.calendar.next_week")}
        </Link>
        <span className="font-medium">{tr("booking.calendar.week_of", { date: formatDate(week, locale, "long") })}</span>
      </nav>
      <nav className="flex flex-wrap items-center gap-2" aria-label={tr("booking.calendar.filter_kind")}>
        <Link href={href({ week })} className={chip(!kind)} aria-current={!kind ? "page" : undefined}>
          {tr("booking.calendar.all_kinds")}
        </Link>
        {KINDS.map((k) => (
          <Link key={k} href={href({ week, kind: k })} className={chip(kind === k)} aria-current={kind === k ? "page" : undefined}>
            {tr(`booking.kind.${k}`)}
          </Link>
        ))}
      </nav>
      <CalendarWeek days={days} empty={blocks.length === 0 ? tr("booking.calendar.empty") : null} />
    </div>
  );
}
