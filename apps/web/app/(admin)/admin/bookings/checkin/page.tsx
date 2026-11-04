import Link from "next/link";
import type { Route } from "next";
import { Badge, buttonVariants } from "@beam/ui";
import { BOOKING_CONFLICT_REASONS, brusselsDate, brusselsTime } from "@beam/core/booking";
import { formatDate, formatMoney, type Locale, type LocalizedText } from "@beam/core/i18n";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, softTranslator, translator } from "@/lib/i18n";
import { codeFromScan, getCheckinCard, getCheckinDay, searchCheckin, type CheckinCard, type CheckinRow } from "@/modules/booking/queries";
import { BookingCard, type BookingCardView } from "@/modules/booking/ui/booking-card";
import { CheckinDesk } from "@/modules/booking/ui/checkin-desk";

const show = (text: LocalizedText | null | undefined, locale: Locale) => text?.[locale] || text?.["nl-BE"] || text?.en || text?.["fr-BE"] || "";
type Tr = (key: string, params?: Record<string, string | number>) => string;

/** A catalogue key that may not exist yet, with an existing fallback (Missing-catalogue-keys of booking-P4). */
const orKey = (soft: Tr, key: string, fallback: string) => {
  const v = soft(key);
  return v === key ? fallback : v;
};

function cardView(c: CheckinCard, locale: Locale, tr: Tr, soft: Tr, canOverride: boolean): BookingCardView {
  const rc = c.receptionCard;
  const reception = rc
    ? [
        tr("crm.person360.header.customer_number", { customerNumber: rc.customerNumber }),
        soft(`crm.enums.person_status.${rc.status}`),
        ...(rc.tags.length ? [`${soft("crm.reception.tags")}: ${rc.tags.join(", ")}`] : []),
        rc.emergencyContact ? `${soft("crm.reception.emergency_contact")}: ${rc.emergencyContact.name} · ${rc.emergencyContact.phone}` : soft("crm.reception.no_emergency_contact"),
        ...(rc.isMinor ? [soft("crm.reception.minor")] : []),
      ]
    : [];
  const live = c.status === "confirmed" || c.status === "no_show";
  return {
    bookingId: c.bookingId,
    personId: c.personId,
    name: c.name,
    sessionLine: `${formatDate(c.startsAt, locale, "full")} · ${brusselsTime(c.startsAt)}–${brusselsTime(c.endsAt)} · ${show(c.sessionTitle, locale)}`,
    status: c.status,
    statusLabel: tr(`booking.status.${c.status}`),
    checkedInLabel: c.status === "attended" && c.attendedAt ? tr("booking.checkin.already_checked_in", { time: brusselsTime(c.attendedAt) }) : null,
    wrongDayLabel: c.wrongDay ? tr("booking.checkin.wrong_day", { date: formatDate(c.startsAt, locale, "full") }) : null,
    toPayLabel: c.toPayCents !== null ? tr("booking.checkin.to_pay", { amount: formatMoney(c.toPayCents, locale) }) : null,
    orderId: c.orderId,
    termsPending: !c.termsAccepted,
    health: rc ? (rc.declarations.healthDeclarationValid ? "valid" : c.healthDeclaration.state === "expired" ? "expired" : "missing") : c.healthDeclaration.state,
    canCheckIn: c.canCheckIn,
    canOverride: canOverride && live && !c.canCheckIn,
    canUndo: c.canUndo,
    canMarkNoShow: c.canMarkNoShow,
    canRevertNoShow: c.canRevertNoShow && !c.canCheckIn,
    notes: c.notes,
    reception,
    guests: c.guests.map((g) => ({
      bookingId: g.bookingId,
      name: g.name,
      statusLabel: tr(`booking.status.${g.status}`),
      canCheckIn: (g.status === "confirmed" || g.status === "no_show") && c.inWindow && !c.wrongDay,
    })),
  };
}

function RowLink({ row, locale, tr }: { row: CheckinRow; locale: Locale; tr: Tr }) {
  return (
    <li>
      <Link
        href={`/admin/bookings/checkin?b=${row.bookingId}` as Route}
        className="flex min-h-11 flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 hover:bg-accent"
        data-booking-id={row.bookingId}
      >
        <span>
          <span className="font-medium">{row.name}</span>
          <span className="text-sm text-muted-foreground">
            {" "}
            · {brusselsTime(row.startsAt)} {show(row.sessionTitle, locale)}
            {row.guestOfName ? ` · ${tr("booking.checkin.guests_of", { name: row.guestOfName })}` : ""}
          </span>
        </span>
        <span className="flex flex-wrap gap-1">
          <Badge variant="outline">{tr(`booking.status.${row.status}`)}</Badge>
          {row.toPayCents !== null ? <Badge variant="warning">{tr("booking.checkin.to_pay", { amount: formatMoney(row.toPayCents, locale) })}</Badge> : null}
          {!row.termsAccepted ? <Badge variant="warning">{tr("booking.checkin.terms_pending")}</Badge> : null}
          {row.healthDeclaration.state !== "valid" ? (
            <Badge variant="warning">{tr(row.healthDeclaration.state === "expired" ? "booking.checkin.health_expired" : "booking.checkin.health_missing")}</Badge>
          ) : null}
        </span>
      </Link>
    </li>
  );
}

/**
 * `/admin/bookings/checkin` (`bookings.write`, booking spec 5.1, R35, R62b): the reception desk.
 * `?c=<code>` is the QR URL, `?q=` the scan field (a code or a name), `?b=` a chosen booking.
 * Shows the result card, the name matches of today and today's sessions with the people not yet
 * arrived. A missing health declaration or unaccepted terms are badges, never a block.
 */
export default async function CheckinPage({ searchParams }: { searchParams: Promise<{ q?: string; c?: string; b?: string }> }) {
  const actor = await requireStaff({ permission: "bookings.write" });
  const locale = await adminLocale();
  const tr = translator(locale) as Tr;
  const soft = softTranslator(locale) as Tr;
  const db = await getAppDb();
  const sp = await searchParams;
  const now = new Date();
  const today = brusselsDate(now);
  const input = (sp.c ?? sp.q ?? "").trim();
  const code = input ? codeFromScan(input) : null;
  const bookingId = sp.b && /^[0-9a-f-]{36}$/i.test(sp.b) ? sp.b : undefined;

  const [card, matches, day] = await Promise.all([
    bookingId ? getCheckinCard(db, { bookingId, now }) : code ? getCheckinCard(db, { code, now }) : Promise.resolve(null),
    !bookingId && !code && input ? searchCheckin(db, { onDate: today, q: input }) : Promise.resolve([]),
    getCheckinDay(db, { onDate: today }),
  ]);
  const notFound = !card && (!!bookingId || !!code || (input && matches.length === 0));

  const errors = {
    ...Object.fromEntries(BOOKING_CONFLICT_REASONS.map((r) => [r, tr(`booking.errors.${r}`)])),
    validation: tr("platform.errors.validation"),
    forbidden: tr("platform.errors.forbidden"),
    not_found: tr("booking.checkin.not_found"),
    internal: tr("platform.errors.internal"),
  };
  const cardLabels = {
    checkIn: tr("booking.checkin.check_in"),
    checkInAll: tr("booking.checkin.check_in_all"),
    checkInOverride: orKey(soft, "booking.checkin.check_in_override", `${tr("booking.checkin.check_in")} (${tr("booking.manual.override_title")})`),
    undo: tr("booking.checkin.undo"),
    markNoShow: tr("booking.checkin.mark_no_show"),
    revertNoShow: orKey(soft, "booking.checkin.revert_no_show", tr("booking.checkin.check_in")),
    takePayment: tr("booking.checkin.take_payment"),
    termsPending: tr("booking.checkin.terms_pending"),
    healthMissing: tr("booking.checkin.health_missing"),
    healthExpired: tr("booking.checkin.health_expired"),
    fillInForm: tr("booking.checkin.fill_in_form"),
    guestsOf: card ? tr("booking.checkin.guests_of", { name: card.name }) : "",
    notes: tr("booking.session.attendee_notes"),
    errors,
  };

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{tr("booking.checkin.title")}</h1>
        <div className="flex flex-wrap gap-2">
          <Link href={"/admin/bookings/new"} className={buttonVariants({ variant: "outline", size: "sm" })}>
            {tr("booking.checkin.add_walk_in")}
          </Link>
          <Link href={`/admin/sessions/day/${today}/print` as Route} className={buttonVariants({ variant: "outline", size: "sm" })}>
            {tr("booking.day.print")}
          </Link>
        </div>
      </div>
      <CheckinDesk labels={{ scan: tr("booking.checkin.scan_label"), submit: soft("crm.common.search"), hint: orKey(soft, "booking.checkin.scan_hint", tr("booking.bookings.search")) }}>
        {card ? <BookingCard card={cardView(card, locale, tr, soft, hasPermission(actor, "bookings.override"))} labels={cardLabels} canWrite /> : null}
        {notFound ? (
          <p role="status" className="rounded-md border border-destructive p-3 text-sm" data-testid="checkin-not-found">
            {tr("booking.checkin.not_found")}
          </p>
        ) : null}
        {matches.length ? (
          <ul className="grid gap-2" aria-label={tr("booking.checkin.scan_label")}>
            {matches.map((m) => (
              <RowLink key={m.bookingId} row={m} locale={locale} tr={tr} />
            ))}
          </ul>
        ) : null}
      </CheckinDesk>

      <section aria-labelledby="today" className="grid gap-4">
        <h2 id="today" className="text-lg font-semibold">
          {tr("booking.checkin.today_sessions")}
        </h2>
        {day.length === 0 ? <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">{tr("booking.day.empty")}</p> : null}
        {day.map((s) => (
          <div key={s.sessionId} className="grid gap-2 rounded-md border p-3" data-session-id={s.sessionId}>
            <h3 className="flex flex-wrap items-center justify-between gap-2 font-medium">
              <Link href={`/admin/sessions/${s.sessionId}` as Route} className="underline-offset-4 hover:underline">
                {brusselsTime(s.startsAt)}–{brusselsTime(s.endsAt)} · {show(s.title, locale)}
              </Link>
              <span className="text-sm font-normal text-muted-foreground">{tr("booking.day.checked_in", { done: s.arrived, total: s.arrived + s.notArrived.length })}</span>
            </h3>
            {s.notArrived.length ? (
              <>
                <p className="text-sm text-muted-foreground">{tr("booking.checkin.not_arrived")}</p>
                <ul className="grid gap-2">
                  {s.notArrived.map((r) => (
                    <RowLink key={r.bookingId} row={r} locale={locale} tr={tr} />
                  ))}
                </ul>
              </>
            ) : null}
          </div>
        ))}
      </section>
    </div>
  );
}
