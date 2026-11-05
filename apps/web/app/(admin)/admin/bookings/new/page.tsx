import Link from "next/link";
import type { Route } from "next";
import { Button, Input, Label, buttonVariants } from "@beam/ui";
import { BOOKING_CONFLICT_REASONS, addDays, brusselsDate, brusselsTime, zonedTimeToUtc } from "@beam/core/booking";
import { formatDate, type Locale, type LocalizedText } from "@beam/core/i18n";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, softTranslator, translator } from "@/lib/i18n";
import { listManualBookingSessions } from "@/modules/booking/queries";
import { ManualBookingWizard, type WizardSession } from "@/modules/booking/ui/manual-booking-wizard";
import { getPerson, searchPersons } from "@/modules/crm/api";

const show = (text: LocalizedText | null | undefined, locale: Locale) => text?.[locale] || text?.["nl-BE"] || text?.en || text?.["fr-BE"] || "";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Days of sessions the picker lists from the chosen date. */
const PICKER_DAYS = 14;

/**
 * `/admin/bookings/new` (`bookings.write`, booking spec 5.1): step 1 finds the person through crm
 * (`?q=`) or links to crm's new-person form; step 2 (`?personId=`) is the booking form with the
 * sessions of 14 days from `?date=` (default today; `?sessionId=` preselects one, e.g. from the
 * session detail page). Override toggles appear only with `bookings.override`.
 */
export default async function NewBookingPage({ searchParams }: { searchParams: Promise<{ q?: string; personId?: string; date?: string; sessionId?: string }> }) {
  const actor = await requireStaff({ permission: "bookings.write" });
  const locale = await adminLocale();
  const tr = translator(locale);
  const soft = softTranslator(locale);
  const db = await getAppDb();
  const sp = await searchParams;
  const q = (sp.q ?? "").trim();
  const personId = sp.personId && UUID.test(sp.personId) ? sp.personId : undefined;
  const sessionId = sp.sessionId && UUID.test(sp.sessionId) ? sp.sessionId : undefined;
  const date = sp.date && DATE.test(sp.date) ? sp.date : brusselsDate(new Date());
  const person = personId ? await getPerson(db, personId) : null;
  const withSession = (extra: Record<string, string>) => {
    const p = new URLSearchParams(extra);
    if (sessionId) p.set("sessionId", sessionId);
    return `/admin/bookings/new?${p.toString()}` as Route;
  };

  if (!person) {
    const matches = q ? await searchPersons(db, { q, limit: 20 }) : [];
    return (
      <div className="grid gap-6">
        <h1 className="text-2xl font-semibold">{tr("booking.manual.title")}</h1>
        <form method="get" role="search" className="grid max-w-xl gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
          <div className="grid gap-1">
            <Label htmlFor="manual-q">{tr("booking.manual.person_search")}</Label>
            <Input id="manual-q" name="q" defaultValue={q} placeholder={soft("crm.persons.list.search_placeholder")} autoFocus />
          </div>
          {sessionId ? <input type="hidden" name="sessionId" value={sessionId} /> : null}
          <Button type="submit">{soft("crm.common.search")}</Button>
        </form>
        {matches.length ? (
          <ul className="grid max-w-xl gap-2">
            {matches.map((m) => (
              <li key={m.personId}>
                <Link href={withSession({ personId: m.personId })} className="flex min-h-11 items-center justify-between gap-2 rounded-md border px-3 py-2 hover:bg-accent">
                  <span className="font-medium">{m.name}</span>
                  <span className="text-sm text-muted-foreground">
                    {m.customerNumber}
                    {m.email ? ` · ${m.email}` : ""}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : q ? (
          <p className="text-sm text-muted-foreground">{tr("booking.bookings.empty")}</p>
        ) : null}
        <Link href={"/admin/persons/new"} className={buttonVariants({ variant: "outline", size: "sm" }) + " w-fit"}>
          {tr("booking.manual.new_person")}
        </Link>
      </div>
    );
  }

  const canOverride = hasPermission(actor, "bookings.override");
  const rows = await listManualBookingSessions(db, { from: zonedTimeToUtc(date, "00:00"), to: zonedTimeToUtc(addDays(date, PICKER_DAYS), "00:00"), personId: person.id });
  const sessions: WizardSession[] = rows.map((s) => ({
    id: s.id,
    label: `${formatDate(s.startsAt, locale)} ${brusselsTime(s.startsAt)} · ${show(s.title, locale)}${s.status === "closed" ? ` · ${tr("booking.availability.closed")}` : ""}`,
    kind: s.kind,
    availability: s.availableTotal > 0 ? tr("booking.availability.placesLeft", { count: s.availableTotal }) : tr("booking.availability.full"),
    isFull: s.availableTotal <= 0,
    canPayCredit: s.creditKind !== null && s.creditCost > 0,
    canPayOrder: s.productId !== null || s.ticketTypes.length > 0,
    canPayAtDesk: s.payAtDeskAllowed,
    isFree: s.productId === null && s.ticketTypes.length === 0 && (s.creditKind === null || s.creditCost === 0),
    creditBalance: s.creditBalance !== null ? tr("booking.manual.credit_balance", { count: s.creditBalance }) : null,
    // R51: staff with `bookings.override` may sell a type outside its sales window (bookSeats checks it).
    ticketTypes: s.ticketTypes.map((t) => {
      const state =
        t.state === "not_yet" || t.state === "not_on_sale"
          ? tr("booking.portalSession.ticket_not_on_sale")
          : t.state === "sold_out"
            ? tr("booking.portalSession.ticket_sold_out")
            : t.left !== null
              ? tr("booking.portalSession.ticket_left", { count: t.left })
              : null;
      return { id: t.id, label: state ? `${show(t.name, locale)} · ${state}` : show(t.name, locale), disabled: t.state !== "on_sale" };
    }),
  }));
  const errors = {
    ...Object.fromEntries(BOOKING_CONFLICT_REASONS.map((r) => [r, tr(`booking.errors.${r}`)])),
    validation: tr("platform.errors.validation"),
    ticket_type_required: tr("booking.errors.ticket_type_required"),
    too_many_tickets: tr("booking.errors.too_many_tickets"),
    guest_details_required: tr("booking.errors.guest_details_required"),
    too_many_guests: tr("booking.errors.too_many_guests"),
    reason_required: tr("booking.manual.reason"),
    forbidden: tr("platform.errors.forbidden"),
    not_found: tr("platform.errors.not_found"),
    internal: tr("platform.errors.internal"),
  };

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{tr("booking.manual.title")}</h1>
        <Link href={"/admin/bookings/new"} className={buttonVariants({ variant: "outline", size: "sm" })}>
          {tr("booking.manual.person_search")}
        </Link>
      </div>
      <p className="text-lg">
        <span className="font-medium">{[person.firstName, person.lastName].filter(Boolean).join(" ") || person.email || person.customerNumber}</span> <span className="text-sm text-muted-foreground">· {person.customerNumber}</span>
      </p>
      <form method="get" className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="personId" value={person.id} />
        <div className="grid gap-1">
          <Label htmlFor="manual-date">{tr("booking.exceptions.date")}</Label>
          <Input id="manual-date" type="date" name="date" defaultValue={date} />
        </div>
        <Button type="submit" variant="outline">
          {tr("booking.manual.session_picker")}
        </Button>
      </form>
      <ManualBookingWizard
        personId={person.id}
        sessions={sessions}
        {...(sessionId ? { initialSessionId: sessionId } : {})}
        canOverride={canOverride}
        labels={{
          session: tr("booking.manual.session_picker"),
          choose: tr("booking.manual.session_picker"),
          payment: tr("booking.manual.payment"),
          ticketType: tr("booking.manual.ticket_type"),
          payCredit: tr("booking.manual.pay_credit"),
          payOrderNow: tr("booking.manual.pay_order_now"),
          payAtDesk: tr("booking.manual.pay_at_desk"),
          payFree: tr("booking.manual.pay_free"),
          guests: tr("booking.manual.guests"),
          addGuest: tr("booking.manual.add_guest"),
          removeGuest: tr("booking.common.delete"),
          firstName: tr("booking.manual.first_name"),
          lastName: tr("booking.manual.last_name"),
          email: tr("booking.manual.email"),
          sharesBed: tr("booking.portalSession.guest_shares_bed"),
          overrideTitle: tr("booking.manual.override_title"),
          overCapacity: tr("booking.manual.over_capacity"),
          overCapacityWarning: tr("booking.manual.over_capacity_warning"),
          reason: tr("booking.manual.reason"),
          sendEmail: tr("booking.manual.send_email"),
          emergencyContact: tr("booking.manual.emergency_contact"),
          emergencyName: soft("crm.persons.edit.emergency_name"),
          emergencyPhone: tr("booking.manual.phone"),
          create: tr("booking.manual.create"),
          errors,
        }}
      />
    </div>
  );
}
