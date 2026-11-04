import Link from "next/link";
import type { Route } from "next";
import { notFound } from "next/navigation";
import { persons } from "@beam/db/schema";
import { URL_SEGMENT, formatDateTime, localeFromSegment, pick } from "@beam/core/i18n";
import { Badge, buttonVariants, cn } from "@beam/ui";
import { requireCustomer } from "@/lib/auth";
import { getAppDb, inArray } from "@/lib/ctx";
import { translator } from "@/lib/i18n";
import { listMyBookings } from "@/modules/booking/queries";

const TABS = ["upcoming", "past", "events", "guests", "as_guest"] as const;
type Tab = (typeof TABS)[number];
type Row = Awaited<ReturnType<typeof listMyBookings>>[number];

/**
 * `/[locale]/account/bookings` (booking spec 5.2): upcoming and past bookings, event
 * registrations, the guest bookings I made and the bookings where I am a guest. Rows come from
 * `v_person_bookings` scoped to the signed-in person (attendee or owner) and never carry staff
 * notes or another person's check-in code. Other people appear by name only.
 */
export default async function MyBookingsPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ tab?: string }> }) {
  const { locale: seg } = await params;
  const locale = localeFromSegment(seg);
  if (!locale) notFound();
  const actor = await requireCustomer(locale);
  const me = actor.personId;
  const tr = translator(locale);
  const { tab: rawTab } = await searchParams;
  const tab: Tab = TABS.includes(rawTab as Tab) ? (rawTab as Tab) : "upcoming";
  const db = await getAppDb();
  const base = `/${URL_SEGMENT[locale]}/account/bookings`;

  let rows: Row[];
  if (tab === "upcoming" || tab === "past" || tab === "events") {
    rows = await listMyBookings(db, me, { scope: tab });
  } else {
    const all = [...(await listMyBookings(db, me, { scope: "upcoming" })), ...(await listMyBookings(db, me, { scope: "past" }))];
    rows = tab === "guests" ? all.filter((r) => r.personId !== me) : all.filter((r) => r.personId === me && r.isGuest && r.ownerPersonId !== me);
  }

  // Names of the other people on these rows: the guest I booked, or the owner who booked me.
  const otherIds = [...new Set(rows.map((r) => (r.personId !== me ? r.personId : r.isGuest ? r.ownerPersonId : null)).filter((x): x is string => !!x && x !== me))];
  const names = new Map(
    otherIds.length
      ? (await db.select({ id: persons.id, firstName: persons.firstName, lastName: persons.lastName }).from(persons).where(inArray(persons.id, otherIds))).map((p) => [
          p.id,
          [p.firstName, p.lastName].filter(Boolean).join(" "),
        ])
      : [],
  );

  const tabLabel: Record<Tab, string> = {
    upcoming: tr("booking.portalBookings.tab_upcoming"),
    past: tr("booking.portalBookings.tab_past"),
    events: tr("booking.portalBookings.tab_events"),
    guests: tr("booking.portalBookings.tab_guests"),
    as_guest: tr("booking.portalBookings.tab_as_guest"),
  };
  const empty: Record<Tab, string> = {
    upcoming: tr("booking.portalBookings.empty"),
    past: tr("booking.portalBookings.empty_past"),
    events: tr("booking.portalBookings.empty_events"),
    guests: tr("booking.portalBookings.empty_guests"),
    as_guest: tr("booking.portalBookings.empty_as_guest"),
  };

  return (
    <section aria-labelledby="my-bookings-title" className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 id="my-bookings-title" className="text-2xl font-semibold">
          {tr("booking.portalBookings.title")}
        </h1>
        <Link href={`/${URL_SEGMENT[locale]}/account/book` as Route} className={cn(buttonVariants({}), "min-h-11")}>
          {tr("booking.portalBookings.book")}
        </Link>
      </div>

      <nav aria-label={tr("booking.portalBookings.title")} className="flex flex-wrap gap-2" data-testid="bookings-tabs">
        {TABS.map((k) => (
          <Link
            key={k}
            href={(k === "upcoming" ? base : `${base}?tab=${k}`) as Route}
            aria-current={k === tab ? "page" : undefined}
            className={cn(buttonVariants({ variant: k === tab ? "default" : "outline" }), "min-h-11")}
          >
            {tabLabel[k]}
          </Link>
        ))}
      </nav>

      {rows.length === 0 ? (
        <div className="space-y-3 rounded-lg border border-dashed p-6 text-center" data-testid="bookings-empty">
          <p>{empty[tab]}</p>
          <Link href={`/${URL_SEGMENT[locale]}/account/book` as Route} className={cn(buttonVariants({ variant: "outline" }), "min-h-11")}>
            {tr("booking.portalBookings.book")}
          </Link>
        </div>
      ) : (
        <ul className="grid gap-3" data-testid="bookings-list">
          {rows.map((r) => {
            const other = r.personId !== me ? names.get(r.personId) : r.isGuest && r.ownerPersonId ? names.get(r.ownerPersonId) : null;
            const relation =
              r.personId !== me && other
                ? tr("booking.portalBookings.booked_for_guest", { name: other })
                : r.isGuest && r.ownerPersonId !== me && other
                  ? tr("booking.portalBookings.guest_of", { name: other })
                  : null;
            return (
              <li key={r.id} className="flex flex-col gap-2 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between" data-testid={`my-booking-${r.id}`}>
                <div className="space-y-1">
                  <h2 className="font-medium">{pick(r.title, locale)}</h2>
                  <p className="text-sm">{formatDateTime(r.startsAt, locale, "full")}</p>
                  {relation ? <p className="text-sm text-muted-foreground">{relation}</p> : null}
                  <p className="flex flex-wrap gap-2 text-sm">
                    <Badge variant={r.status === "confirmed" || r.status === "attended" ? "success" : r.status === "reserved" ? "warning" : "outline"}>
                      {tr(`booking.status.${r.status}`)}
                    </Badge>
                    <span className="text-muted-foreground">{tr(`booking.kind.${r.kind}`)}</span>
                  </p>
                </div>
                <Link href={`${base}/${r.id}` as Route} className={cn(buttonVariants({ variant: "outline" }), "min-h-11")}>
                  {tr("booking.portalBookings.open")}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
