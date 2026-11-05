import Link from "next/link";
import type { Route } from "next";
import { notFound } from "next/navigation";
import { Badge, buttonVariants } from "@beam/ui";
import { brusselsDate, brusselsTime } from "@beam/core/booking";
import { formatDate, formatDateTime, type Locale, type LocalizedText } from "@beam/core/i18n";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { flag } from "@/lib/flags";
import { adminLocale, softTranslator, translator } from "@/lib/i18n";
import { getSetting } from "@/lib/settings";
import {
  attendeeListLabels,
  attendeeRow,
  bookingErrorLabels,
  changeDialogLabels,
  getSession,
  getSessionAttendees,
  listHolds,
  listProductOptions,
  listSessionsInRange,
} from "@/modules/booking/queries";
import { AttendeeList } from "@/modules/booking/ui/attendee-list";
import { CancelSessionDialog } from "@/modules/booking/ui/cancel-dialog";
import { DeleteHoldButton, HoldForm } from "@/modules/booking/ui/hold-form";
import { SessionWaitlistTab } from "@/modules/booking/ui/session-waitlist-tab";
import { LeadMagnetForm } from "@/modules/booking/ui/lead-magnet-form";
import { TicketTypesForm } from "@/modules/booking/ui/ticket-types-form";
import { listTicketTypesWithSold, readAvailabilityRow } from "@/modules/booking/server/book";

const show = (text: LocalizedText | null | undefined, locale: Locale) => text?.[locale] || text?.["nl-BE"] || text?.en || text?.["fr-BE"] || "";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOLD_KINDS = ["staff", "partner", "host", "speaker", "blocked"] as const;
type Tr = (key: string, params?: Record<string, string | number>) => string;
const RELEASE_RULES = ["customers_then_public", "public", "keep_for_leads"] as const;
/** A stored instant as the Brussels wall clock of a `datetime-local` input. */
const localInput = (d: Date | null) => (d ? `${brusselsDate(d)}T${brusselsTime(d)}` : "");

/**
 * `/admin/sessions/[id]` (`bookings.read`, booking spec 5.1): the session header (time, kind,
 * event category, capacity, held, booked, open offers, waiting), the attendee list with check
 * in, undo, no-show, notes and cancel (`bookings.write`), the holds with P2's hold form and the
 * waitlist tab. A cancelled session shows its reason read-only. booking-P7 (R2): the Lead Magnet
 * tab with the current phase, lead places left and opening times, and the configuration form
 * (`bookings.override`, flag `ff_booking_lead_priority`, events only). booking-P8 (R2): the ticket
 * types tab of an event (sold per type, archived types) with the ticket types form
 * (`bookings.override`, flag `ff_booking_ticket_types`).
 */
export default async function SessionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireStaff({ permission: "bookings.read" });
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const locale = await adminLocale();
  const tr = translator(locale) as Tr;
  const soft = softTranslator(locale) as Tr;
  const db = await getAppDb();
  const session = await getSession(db, id);
  if (!session) notFound();
  const now = new Date();
  const canWrite = hasPermission(actor, "bookings.write");
  const canOverride = hasPermission(actor, "bookings.override");
  const isEvent = session.kind === "event" && !session.webinarId;
  const [blocks, attendees, holds, rules, leadOn, availability, ticketsOn, ticketTypes] = await Promise.all([
    listSessionsInRange(db, { from: session.startsAt, to: new Date(session.startsAt.getTime() + 1000) }),
    getSessionAttendees(db, id),
    listHolds(db, { sessionId: id, now: new Date(0) }),
    getSetting(db, "booking_rules"),
    flag("ff_booking_lead_priority", actor),
    readAvailabilityRow(db, session),
    flag("ff_booking_ticket_types", actor),
    isEvent ? listTicketTypesWithSold(db, id, now) : Promise.resolve([]),
  ]);
  const ticketProducts = isEvent && ticketsOn && canOverride ? (await listProductOptions(db)).filter((p) => p.kind === "ticket") : [];
  const block = blocks.find((b) => b.id === id);
  const rows = attendees.map((a) => attendeeRow(a, session, rules, { now, locale, tr, canOverride }));
  const errors = bookingErrorLabels(tr);
  const cancelled = session.status === "cancelled";
  const stat = (label: string, value: string | number) => (
    <div className="grid gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  );

  return (
    <div className="grid gap-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <h1 className="text-2xl font-semibold">{show(session.title, locale)}</h1>
          <p className="text-muted-foreground">
            {formatDate(session.startsAt, locale, "full")} · {brusselsTime(session.startsAt)}–{brusselsTime(session.endsAt)}
            {session.location ? ` · ${session.location}` : ""}
          </p>
          <span className="flex flex-wrap gap-2">
            <Badge variant="outline">{session.eventCategory ? tr(`booking.eventCategory.${session.eventCategory}`) : tr(`booking.kind.${session.kind}`)}</Badge>
            <Badge variant={cancelled ? "destructive" : "outline"}>{tr(`booking.sessionStatus.${session.status}`)}</Badge>
            {session.publishedAt ? null : <Badge variant="secondary">{tr("booking.session.draft")}</Badge>}
            {session.isMemberOnly ? <Badge variant="secondary">{tr("booking.session.member_only")}</Badge> : null}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href={`/admin/sessions/day/${brusselsDate(session.startsAt)}` as Route} className={buttonVariants({ variant: "outline", size: "sm" })}>
            {tr("booking.calendar.title")}
          </Link>
          {canWrite && !cancelled ? (
            <Link href={`/admin/bookings/new?sessionId=${id}` as Route} className={buttonVariants({ size: "sm" })}>
              {tr("booking.session.manual_booking")}
            </Link>
          ) : null}
          {canOverride && !cancelled ? (
            <CancelSessionDialog
              sessionId={id}
              labels={{
                ...changeDialogLabels(tr, tr("booking.session.cancel_session"), tr("booking.session.cancel_session_reason")),
                notify: tr("booking.session.cancel_session_notify"),
                warning: tr("booking.session.cancel_session_confirm"),
              }}
            />
          ) : null}
          {canWrite ? (
            <Link href={"/admin/bookings/checkin"} className={buttonVariants({ variant: "outline", size: "sm" })}>
              {tr("booking.day.checkin_desk")}
            </Link>
          ) : null}
        </div>
      </div>

      {cancelled && session.cancelledAt ? (
        <p role="status" className="rounded-md border border-destructive p-3 text-sm">
          {tr("booking.session.cancelled_info", { date: formatDateTime(session.cancelledAt, locale), reason: session.cancelReason ?? "" })}
        </p>
      ) : null}

      {block ? (
        <dl className="grid grid-cols-2 gap-4 rounded-md border p-4 sm:grid-cols-5">
          {stat(tr("booking.session.capacity"), block.capacity)}
          {stat(tr("booking.session.held"), block.held)}
          {stat(tr("booking.session.booked"), block.booked)}
          {stat(tr("booking.session.live_offers"), block.liveOffers)}
          {stat(tr("booking.session.waiting"), block.waiting)}
        </dl>
      ) : null}

      <section aria-labelledby="attendees" className="grid gap-3">
        <h2 id="attendees" className="text-xl font-semibold">
          {tr("booking.session.tab_attendees")}
        </h2>
        <AttendeeList rows={rows} labels={attendeeListLabels(tr, soft)} canWrite={canWrite && !cancelled} canOverride={canOverride} />
      </section>

      <section aria-labelledby="holds" className="grid gap-3">
        <h2 id="holds" className="text-xl font-semibold">
          {tr("booking.session.tab_holds")}
        </h2>
        {holds.length === 0 ? <p className="text-sm text-muted-foreground">{tr("booking.holds.empty")}</p> : null}
        <ul className="grid gap-2">
          {holds.map((h) => (
            <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
              <span>
                <Badge variant="outline">{tr(`booking.holdKind.${h.kind}`)}</Badge> {h.used}/{h.quantity}
                {h.companyName ? ` · ${h.companyName}` : ""}
                {h.note ? ` · ${h.note}` : ""}
              </span>
              {canWrite && !cancelled ? <DeleteHoldButton id={h.id} label={tr("booking.common.delete")} errors={errors} /> : null}
            </li>
          ))}
        </ul>
        {canWrite && !cancelled && session.endsAt.getTime() > now.getTime() ? (
          <HoldForm
            initial={{ sessionId: id, kind: "staff", quantity: 1, companyId: "", note: "" }}
            sessions={[{ id, label: `${formatDate(session.startsAt, locale)} ${brusselsTime(session.startsAt)} · ${show(session.title, locale)}` }]}
            companies={[]}
            labels={{
              session: tr("booking.holds.session"),
              kind: tr("booking.holds.kind"),
              kinds: Object.fromEntries(HOLD_KINDS.map((k) => [k, tr(`booking.holdKind.${k}`)])) as Record<(typeof HOLD_KINDS)[number], string>,
              quantity: tr("booking.holds.quantity"),
              company: tr("booking.holds.company"),
              none: "—",
              note: tr("booking.holds.note"),
              noteHint: tr("booking.common.no_health_notes"),
              save: tr("booking.common.save"),
              saving: tr("booking.common.save"),
              saved: tr("booking.common.save"),
              errors: { ...errors, capacity_below_bookings: tr("booking.holds.below_bookings") },
            }}
          />
        ) : null}
      </section>

      {session.kind === "event" && (leadOn || session.isLeadMagnet) ? (
        <section aria-labelledby="lead" className="grid gap-3" data-testid="lead-tab">
          <h2 id="lead" className="text-xl font-semibold">
            {tr("booking.session.tab_lead")}
          </h2>
          <p className="text-sm text-muted-foreground">{tr("booking.lead.intro")}</p>
          {session.isLeadMagnet ? (
            <dl className="grid gap-1 rounded-md border p-3 text-sm" data-testid="lead-status">
              <dt className="sr-only">{tr("booking.session.lead_phase")}</dt>
              <dd>{tr("booking.lead.phase", { phase: tr(`booking.leadPhase.${availability.leadPhase}`) })}</dd>
              <dd>{tr("booking.lead.reserved_remaining", { count: availability.leadReservedRemaining })}</dd>
              {availability.opensForCustomersAt ? <dd>{tr("booking.lead.opens_for_customers", { date: formatDateTime(availability.opensForCustomersAt, locale) })}</dd> : null}
              {availability.opensForPublicAt ? <dd>{tr("booking.lead.opens_for_public", { date: formatDateTime(availability.opensForPublicAt, locale) })}</dd> : null}
            </dl>
          ) : null}
          {!leadOn ? (
            <p className="text-sm" role="status">
              {tr("booking.lead.flag_off")}
            </p>
          ) : canOverride && !cancelled && session.startsAt.getTime() > now.getTime() ? (
            <LeadMagnetForm
              initial={{
                sessionId: id,
                capacity: availability.capacity,
                isLeadMagnet: session.isLeadMagnet,
                leadReservedSeats: session.leadReservedSeats,
                leadWindowStartLocal: localInput(session.leadWindowStartAt),
                leadWindowEndLocal: localInput(session.leadWindowEndAt),
                releaseRule: session.leadReleaseRule,
                publicReleaseLocal: localInput(session.publicReleaseAt),
                claimWindowMinutes: session.claimWindowMinutes,
                isWaitlistPositionVisible: session.isWaitlistPositionVisible,
              }}
              labels={{
                isLeadMagnet: tr("booking.lead.is_lead_magnet"),
                seatsMode: tr("booking.lead.seats_mode"),
                seatsNumber: tr("booking.lead.seats_number"),
                seatsPct: tr("booking.lead.seats_pct"),
                seats: tr("booking.lead.seats"),
                pct: tr("booking.lead.pct"),
                windowStart: tr("booking.lead.window_start"),
                windowEnd: tr("booking.lead.window_end"),
                releaseRule: tr("booking.lead.release_rule"),
                rules: Object.fromEntries(RELEASE_RULES.map((r) => [r, tr(`booking.releaseRule.${r}`)])) as Record<(typeof RELEASE_RULES)[number], string>,
                publicRelease: tr("booking.lead.public_release"),
                publicReleaseHint: tr("booking.lead.public_release_hint"),
                claimWindow: tr("booking.lead.claim_window"),
                positionVisible: tr("booking.lead.position_visible"),
                save: tr("booking.common.save"),
                saving: tr("booking.common.saving"),
                saved: tr("booking.common.saved"),
                errorWindow: tr("booking.lead.error_window"),
                errorSeats: tr("booking.lead.error_seats"),
                errorPublicRelease: tr("booking.lead.error_public_release"),
                errors,
              }}
            />
          ) : null}
        </section>
      ) : null}

      {isEvent && (ticketsOn || ticketTypes.length > 0) ? (
        <section aria-labelledby="tickets" className="grid gap-3" data-testid="tickets-tab">
          <h2 id="tickets" className="text-xl font-semibold">
            {tr("booking.session.tab_ticket_types")}
          </h2>
          <p className="text-sm text-muted-foreground">{tr("booking.tickets.intro")}</p>
          {ticketTypes.length === 0 ? <p className="text-sm text-muted-foreground">{tr("booking.tickets.empty")}</p> : null}
          {!ticketsOn || !canOverride || cancelled ? (
            <ul className="grid gap-2" data-testid="ticket-types-list">
              {ticketTypes.map((t) => (
                <li key={t.id} className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm">
                  <span className="font-medium">{show(t.name, locale)}</span>
                  <span>{tr("booking.tickets.sold", { count: t.sold })}</span>
                  {t.capacity !== null ? <span>{tr("booking.tickets.capacity_of", { count: t.capacity })}</span> : null}
                  {t.isMemberOnly ? <Badge variant="secondary">{tr("booking.session.member_only")}</Badge> : null}
                  {t.isActive ? null : <Badge variant="outline">{tr("booking.tickets.archived")}</Badge>}
                </li>
              ))}
            </ul>
          ) : null}
          {!ticketsOn ? (
            <p className="text-sm" role="status">
              {tr("booking.tickets.flag_off")}
            </p>
          ) : canOverride && !cancelled ? (
            <TicketTypesForm
              sessionId={id}
              types={ticketTypes.map((t) => ({
                id: t.id,
                name: t.name,
                productId: t.productId,
                capacity: t.capacity,
                isMemberOnly: t.isMemberOnly,
                salesStartLocal: localInput(t.salesStartAt),
                salesEndLocal: localInput(t.salesEndAt),
                maxPerBooking: t.maxPerBooking,
                requiresGuestDetails: t.requiresGuestDetails,
                sortOrder: t.sortOrder,
                isActive: t.isActive,
                sold: t.sold,
              }))}
              products={ticketProducts.map((p) => ({ id: p.id, label: `${show(p.name, locale)} (${p.sku})` }))}
              labels={{
                name: {
                  field: tr("booking.tickets.name"),
                  locales: { "nl-BE": tr("platform.shell.locale_nl"), "fr-BE": tr("platform.shell.locale_fr"), en: tr("platform.shell.locale_en") },
                  missing: tr("platform.settings.locale_missing"),
                  complete: tr("platform.settings.locale_complete"),
                },
                product: tr("booking.tickets.product"),
                productHint: tr("booking.tickets.product_hint"),
                noProduct: tr("booking.tickets.no_product"),
                capacity: tr("booking.tickets.capacity"),
                capacityHint: tr("booking.tickets.capacity_hint"),
                memberOnly: tr("booking.tickets.member_only"),
                salesStart: tr("booking.tickets.sales_start"),
                salesEnd: tr("booking.tickets.sales_end"),
                salesHint: tr("booking.tickets.sales_hint"),
                maxPerBooking: tr("booking.tickets.max_per_booking"),
                requiresGuestDetails: tr("booking.tickets.requires_guest_details"),
                sortOrder: tr("booking.tickets.sort_order"),
                sold: tr("booking.tickets.sold", { count: "{count}" }),
                archived: tr("booking.tickets.archived"),
                add: tr("booking.tickets.add"),
                save: tr("booking.common.save"),
                saving: tr("booking.common.saving"),
                saved: tr("booking.common.saved"),
                archive: tr("booking.tickets.archive"),
                errorName: tr("booking.tickets.error_name"),
                errorWindow: tr("booking.tickets.error_window"),
                errorCapacity: tr("booking.tickets.error_capacity"),
                errors,
              }}
            />
          ) : null}
        </section>
      ) : null}

      <section aria-labelledby="waitlist" className="grid gap-3">
        <h2 id="waitlist" className="text-xl font-semibold">
          {tr("booking.session.tab_waitlist")}
        </h2>
        <SessionWaitlistTab sessionId={id} />
      </section>
    </div>
  );
}
