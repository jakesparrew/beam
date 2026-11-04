import Link from "next/link";
import type { Route } from "next";
import { notFound } from "next/navigation";
import { Badge, buttonVariants } from "@beam/ui";
import { brusselsTime } from "@beam/core/booking";
import { formatDate, formatDateTime, type Locale, type LocalizedText } from "@beam/core/i18n";
import { hasPermission, requireStaff } from "@/lib/auth";
import { NotFoundError, getAppDb } from "@/lib/ctx";
import { adminLocale, softTranslator, translator } from "@/lib/i18n";
import { getSetting } from "@/lib/settings";
import { attendeeListLabels, attendeeRow, getBooking, getBookingCreditEntries, getBookingHistory, getCheckinCard, type SessionAttendee, type Tr } from "@/modules/booking/queries";
import { checkinQrSvg } from "@/modules/booking/server/qr";
import { AttendeeList } from "@/modules/booking/ui/attendee-list";

const show = (text: LocalizedText | null | undefined, locale: Locale) => text?.[locale] || text?.["nl-BE"] || text?.en || text?.["fr-BE"] || "";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fullName = (first: string | null, last: string | null) => [first, last].filter((x) => x && x.trim()).join(" ") || "—";

async function load(id: string) {
  const db = await getAppDb();
  try {
    return { db, detail: await getBooking(db, id) };
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
}

/**
 * `/admin/bookings/[id]` (`bookings.read`, booking spec 5.1): person, session, status and payment,
 * the status history from the booking's facts, the credit ledger rows, the order line and the
 * POS link of an unpaid row, guests, the check-in QR code, notes and the waitlist origin; with
 * `bookings.write` check in, undo, no-show, notes and cancel (policy preview, force options with
 * `bookings.override`).
 */
export default async function BookingDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireStaff({ permission: "bookings.read" });
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const locale = await adminLocale();
  const tr = translator(locale) as Tr;
  const soft = softTranslator(locale) as Tr;
  const { db, detail } = await load(id);
  const { booking, session, person, guests } = detail;
  const now = new Date();
  const canWrite = hasPermission(actor, "bookings.write");
  const canOverride = hasPermission(actor, "bookings.override");
  const [history, credits, card, rules, qr] = await Promise.all([
    getBookingHistory(db, id),
    getBookingCreditEntries(db, id),
    getCheckinCard(db, { bookingId: id, now }),
    getSetting(db, "booking_rules"),
    checkinQrSvg(booking.checkinCode),
  ]);
  const attendee: SessionAttendee = {
    bookingId: booking.id,
    version: booking.version,
    personId: booking.personId,
    name: fullName(person.firstName, person.lastName),
    guestOfBookingId: booking.guestOfBookingId,
    guestOfName: card?.guestOfName ?? null,
    paidWith: booking.paidWith,
    status: booking.status,
    isPayAtDesk: booking.isPayAtDesk,
    isOverCapacity: booking.isOverCapacity,
    ticketTypeId: booking.ticketTypeId,
    toPayCents: card?.toPayCents ?? null,
    notes: booking.notes,
    attendedAt: booking.attendedAt,
    guestCount: guests.filter((g) => g.status === "reserved" || g.status === "confirmed").length,
  };
  const row = attendeeRow(attendee, session, rules, { now, locale, tr, canOverride });

  return (
    <div className="grid gap-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <h1 className="text-2xl font-semibold">
            <Link href={`/admin/persons/${person.id}` as Route} className="underline-offset-4 hover:underline">
              {fullName(person.firstName, person.lastName)}
            </Link>
          </h1>
          <p className="text-muted-foreground">
            <Link href={`/admin/sessions/${session.id}` as Route} className="underline-offset-4 hover:underline">
              {show(session.title, locale)}
            </Link>{" "}
            · {formatDate(session.startsAt, locale, "full")} {brusselsTime(session.startsAt)}–{brusselsTime(session.endsAt)}
          </p>
          <span className="flex flex-wrap gap-2">
            <Badge variant="outline">{tr(`booking.status.${booking.status}`)}</Badge>
            <Badge variant="outline">{tr(`booking.paidWith.${booking.paidWith}`)}</Badge>
            <Badge variant="outline">{tr(`booking.source.${booking.source}`)}</Badge>
            {booking.isPayAtDesk ? <Badge variant="warning">{tr("booking.manual.pay_at_desk")}</Badge> : null}
            {booking.isOverCapacity ? <Badge variant="destructive">{tr("booking.manual.over_capacity")}</Badge> : null}
            {booking.source === "waitlist" ? <Badge variant="secondary">{tr("booking.bookings.waitlist_origin")}</Badge> : null}
            {booking.cancelReasonCode ? <Badge variant="secondary">{tr(`booking.cancelReason.${booking.cancelReasonCode}`)}</Badge> : null}
          </span>
        </div>
        {canWrite && card?.orderId ? (
          <Link href={`/admin/pos?order=${card.orderId}` as Route} className={buttonVariants({ size: "sm" })}>
            {tr("booking.checkin.take_payment")}
          </Link>
        ) : null}
      </div>

      <section aria-labelledby="booking-row" className="grid gap-3">
        <h2 id="booking-row" className="sr-only">
          {tr("booking.session.tab_attendees")}
        </h2>
        <AttendeeList rows={[row]} labels={attendeeListLabels(tr, soft)} canWrite={canWrite} canOverride={canOverride} />
        {booking.cancelReason ? <p className="text-sm text-muted-foreground">{booking.cancelReason}</p> : null}
      </section>

      <div className="grid gap-8 lg:grid-cols-2">
        <section aria-labelledby="qr" className="grid gap-2">
          <h2 id="qr" className="text-lg font-semibold">
            {tr("booking.bookings.qr_code")}
          </h2>
          <div className="w-40" role="img" aria-label={tr("booking.bookings.qr_code")} dangerouslySetInnerHTML={{ __html: qr }} />
          <code className="text-sm tracking-widest">{booking.checkinCode}</code>
        </section>

        <section aria-labelledby="guests" className="grid gap-2">
          <h2 id="guests" className="text-lg font-semibold">
            {tr("booking.bookings.guests")}
          </h2>
          {guests.length === 0 ? <p className="text-sm text-muted-foreground">—</p> : null}
          <ul className="grid gap-1">
            {guests.map((g) => (
              <li key={g.id}>
                <Link href={`/admin/bookings/${g.id}` as Route} className="underline-offset-4 hover:underline">
                  {fullName(g.firstName, g.lastName)}
                </Link>{" "}
                <span className="text-sm text-muted-foreground">
                  · {tr(`booking.status.${g.status}`)} · {tr(`booking.paidWith.${g.paidWith}`)}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="history" className="grid gap-2">
          <h2 id="history" className="text-lg font-semibold">
            {tr("booking.bookings.status_history")}
          </h2>
          <ol className="grid gap-1 text-sm">
            {history.map((h, i) => (
              <li key={`${h.kind}-${i}`} className="flex flex-wrap gap-2">
                <span className="tabular-nums text-muted-foreground">{formatDateTime(h.occurredAt, locale)}</span>
                <span>{soft(`crm.timeline.kinds.${h.kind}`) === `crm.timeline.kinds.${h.kind}` ? h.kind : soft(`crm.timeline.kinds.${h.kind}`)}</span>
              </li>
            ))}
          </ol>
        </section>

        <section aria-labelledby="credits" className="grid gap-2">
          <h2 id="credits" className="text-lg font-semibold">
            {tr("booking.bookings.credits_used")}
          </h2>
          {credits.length === 0 ? <p className="text-sm text-muted-foreground">—</p> : null}
          <ul className="grid gap-1 text-sm">
            {credits.map((c, i) => (
              <li key={i} className="tabular-nums">
                {formatDateTime(c.createdAt, locale)} · {c.kind} · {c.quantity}
              </li>
            ))}
          </ul>
          {booking.orderLineId ? (
            <p className="text-sm">
              {tr("booking.bookings.order_line")}: <code>{booking.orderLineId}</code>
            </p>
          ) : null}
        </section>
      </div>
    </div>
  );
}
