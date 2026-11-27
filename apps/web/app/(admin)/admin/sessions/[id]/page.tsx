import type { Route } from "next";
import { notFound } from "next/navigation";
import { Badge, cn } from "@beam/ui";
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
  type SessionBlock,
} from "@/modules/booking/queries";
import { AttendeeList } from "@/modules/booking/ui/attendee-list";
import { CancelSessionDialog } from "@/modules/booking/ui/cancel-dialog";
import { DeleteHoldButton, HoldForm } from "@/modules/booking/ui/hold-form";
import { SessionWaitlistTab } from "@/modules/booking/ui/session-waitlist-tab";
import { LeadMagnetForm } from "@/modules/booking/ui/lead-magnet-form";
import { TicketTypesForm } from "@/modules/booking/ui/ticket-types-form";
import { listTicketTypesWithSold, readAvailabilityRow } from "@/modules/booking/server/book";
import { EventDetailsForm, EventMediaPanel } from "@/modules/booking/ui/event-details";
import { getProductPrice } from "@/modules/commerce/api";
import { PageHeader, PrimaryAction, Segmented, StatusPill, Surface, td, th, type Tone } from "@/modules/platform/ui/admin-kit";
import { files } from "@beam/db/schema";
import { inArray } from "@/lib/ctx";

const show = (text: LocalizedText | null | undefined, locale: Locale) => text?.[locale] || text?.["nl-BE"] || text?.en || text?.["fr-BE"] || "";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOLD_KINDS = ["staff", "partner", "host", "speaker", "blocked"] as const;
const HOLD_TONE: Record<(typeof HOLD_KINDS)[number], Tone> = { staff: "muted", partner: "info", host: "gold", speaker: "gold", blocked: "bad" };
type Tr = (key: string, params?: Record<string, string | number>) => string;
const RELEASE_RULES = ["customers_then_public", "public", "keep_for_leads"] as const;
type Tab = "attendees" | "waitlist" | "holds" | "details" | "lead" | "tickets";
/** A stored instant as the Brussels wall clock of a `datetime-local` input. */
const localInput = (d: Date | null) => (d ? `${brusselsDate(d)}T${brusselsTime(d)}` : "");
const secondary = "inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-[0.8125rem] font-semibold hover:bg-muted";

/** The session's state pill, the same reading as the sessions list. */
function sessionState(s: { status: string; publishedAt: Date | null; endsAt: Date }, block: SessionBlock | undefined, tr: Tr, now: Date): { tone: Tone; label: string } {
  const L = "booking.list";
  if (s.status === "cancelled") return { tone: "bad", label: tr(`${L}.status_cancelled`) };
  if (s.status === "closed") return { tone: "muted", label: tr(`${L}.status_closed`) };
  if (!s.publishedAt) return { tone: "gold", label: tr(`${L}.status_draft`) };
  if (s.endsAt.getTime() < now.getTime()) return { tone: "muted", label: tr(`${L}.status_past`) };
  if (block && block.capacity && block.availableTotal <= 0) return { tone: "full", label: tr(`${L}.status_full`) };
  if (block && block.capacity && (block.booked + block.held) / block.capacity >= 0.75) return { tone: "warn", label: tr(`${L}.status_almost`) };
  return { tone: "ok", label: tr(`${L}.status_open`) };
}

/** The figures in one bordered row, like the dashboard's KPI strip. */
function KpiStrip({ items }: { items: { key: string; label: string; value: number; sub?: string; tone?: string }[] }) {
  return (
    <dl className="grid grid-cols-2 rounded-xl border border-border bg-card sm:grid-cols-5 sm:divide-x sm:divide-border" data-testid="session-kpis">
      {items.map((k, i) => (
        <div key={k.key} className={cn("grid content-start gap-1 px-5 py-3", i < items.length - 1 && "border-b border-border sm:border-b-0")}>
          <dt className="text-[0.75rem] font-medium text-muted-foreground">{k.label}</dt>
          <dd className={cn("text-[1.375rem] leading-none font-semibold tracking-[-0.02em] tabular-nums", k.tone)}>{k.value}</dd>
          {k.sub ? <dd className="text-[0.75rem] text-muted-foreground">{k.sub}</dd> : null}
        </div>
      ))}
    </dl>
  );
}

/**
 * `/admin/sessions/[id]` (`bookings.read`, booking spec 5.1), as a detail page in the back-office
 * kit (owner review, November 2026): the header (title, date, time, kind, status pill) with
 * "Add booking" (`bookings.write`) and, for events, the CSV export; a KPI strip (capacity,
 * booked, blocked, free, waiting with the open offers); then tabs (`?tab=`): the participants
 * with check in, undo, no-show, notes and cancel (`bookings.write`), the waiting list, the
 * blocked places (seats held for staff, partners, hosts or speakers) with a one-row add form,
 * and for events their details, the Lead Magnet tab (booking-P7, R2: phase, lead places left,
 * opening times and the configuration form, `bookings.override`, flag `ff_booking_lead_priority`)
 * and the ticket types tab (booking-P8, R2: sold per type, archived types, the ticket types form,
 * `bookings.override`, flag `ff_booking_ticket_types`). A cancelled session shows its reason
 * read-only; "Cancel session" (`bookings.override`) sits at the bottom.
 */
export default async function SessionDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
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
  // Owner requirements 4 and 5: price, artwork and materials of an event or WebinarGeek webinar.
  const price = isEvent && session.productId ? await getProductPrice(db, session.productId, "public").catch(() => null) : null;
  const materialRows = session.materialFileIds.length
    ? await db.select({ id: files.id, name: files.name }).from(files).where(inArray(files.id, session.materialFileIds))
    : [];
  const materials = session.materialFileIds.flatMap((fid) => materialRows.filter((m) => m.id === fid)).map((m) => ({ ...m, url: `/api/public/files/${m.id}` }));
  const localeNames = { "nl-BE": tr("platform.shell.locale_nl"), "fr-BE": tr("platform.shell.locale_fr"), en: tr("platform.shell.locale_en") };
  const localized = (field: string) => ({ field, locales: localeNames, missing: tr("platform.settings.locale_missing"), complete: tr("platform.settings.locale_complete") });
  const block = blocks.find((b) => b.id === id);
  const rows = attendees.map((a) => attendeeRow(a, session, rules, { now, locale, tr, canOverride }));
  const errors = bookingErrorLabels(tr);
  const cancelled = session.status === "cancelled";
  const state = sessionState(session, block, tr, now);
  const showLead = session.kind === "event" && (leadOn || session.isLeadMagnet);
  const showTickets = isEvent && (ticketsOn || ticketTypes.length > 0);

  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: "attendees", label: tr("booking.session.tab_attendees"), count: attendees.filter((a) => a.status !== "cancelled" && a.status !== "late_cancelled").length },
    { key: "waitlist", label: tr("booking.session.tab_waitlist"), ...(block ? { count: block.waiting } : {}) },
    { key: "holds", label: tr("booking.session.tab_holds"), count: holds.reduce((n, h) => n + h.quantity, 0) },
    ...(isEvent ? [{ key: "details" as const, label: session.eventCategory === "webinar" ? tr("booking.event.webinar_details") : tr("booking.event.details") }] : []),
    ...(showLead ? [{ key: "lead" as const, label: tr("booking.session.tab_lead") }] : []),
    ...(showTickets ? [{ key: "tickets" as const, label: tr("booking.session.tab_ticket_types") }] : []),
  ];
  const wanted = (await searchParams).tab;
  const tab: Tab = tabs.find((t) => t.key === wanted)?.key ?? "attendees";
  const tabHref = (t: Tab) => (t === "attendees" ? `/admin/sessions/${id}` : `/admin/sessions/${id}?tab=${t}`) as Route;

  return (
    <div className="grid gap-5">
      <PageHeader
        title={show(session.title, locale)}
        description={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="inline-block first-letter:uppercase">
              {formatDate(session.startsAt, locale, "full")} · {brusselsTime(session.startsAt)}–{brusselsTime(session.endsAt)}
              {session.location ? ` · ${session.location}` : ""}
            </span>
            <span>· {session.eventCategory ? tr(`booking.eventCategory.${session.eventCategory}`) : tr(`booking.kind.${session.kind}`)}</span>
            <StatusPill tone={state.tone}>{state.label}</StatusPill>
            {session.isMemberOnly ? <StatusPill tone="info">{tr("booking.session.member_only")}</StatusPill> : null}
          </span>
        }
        actions={
          <>
            {isEvent ? (
              <a href={`/admin/sessions/${id}/registrations.csv`} className={secondary} data-testid="registrations-csv">
                {tr("booking.event.export_csv")}
              </a>
            ) : null}
            {canWrite && !cancelled ? <PrimaryAction href={`/admin/bookings/new?sessionId=${id}` as Route}>+ {tr("booking.session.manual_booking")}</PrimaryAction> : null}
          </>
        }
      />

      {cancelled && session.cancelledAt ? (
        <p role="status" className="rounded-lg bg-[var(--status-bad-soft)] px-3 py-2 text-[0.8125rem] font-medium text-[var(--status-bad)]">
          {tr("booking.session.cancelled_info", { date: formatDateTime(session.cancelledAt, locale), reason: session.cancelReason ?? "" })}
        </p>
      ) : null}

      {block ? (
        <KpiStrip
          items={[
            { key: "capacity", label: tr("booking.session.capacity"), value: block.capacity },
            { key: "booked", label: tr("booking.session.booked"), value: block.booked },
            { key: "held", label: tr("booking.session.held"), value: block.held },
            { key: "free", label: tr("booking.list.col_free"), value: Math.max(0, block.availableTotal), ...(block.availableTotal <= 0 && !cancelled ? { tone: "text-[var(--status-bad)]" } : {}) },
            {
              key: "waiting",
              label: tr("booking.session.waiting"),
              value: block.waiting,
              ...(block.liveOffers ? { sub: `${tr("booking.session.live_offers")}: ${block.liveOffers}` } : {}),
              ...(block.waiting ? { tone: "text-[var(--status-warn)]" } : {}),
            },
          ]}
        />
      ) : null}

      <Segmented label={tr("booking.session.title")} items={tabs.map((t) => ({ key: t.key, label: t.label, href: tabHref(t.key), active: t.key === tab, ...(t.count !== undefined ? { count: t.count } : {}) }))} />

      {tab === "attendees" ? (
        <section aria-label={tr("booking.session.tab_attendees")}>
          <AttendeeList rows={rows} labels={attendeeListLabels(tr, soft)} canWrite={canWrite && !cancelled} canOverride={canOverride} />
        </section>
      ) : null}

      {tab === "waitlist" ? (
        <section aria-label={tr("booking.session.tab_waitlist")}>
          <SessionWaitlistTab sessionId={id} />
        </section>
      ) : null}

      {tab === "holds" ? (
        <Surface flush aria-label={tr("booking.session.tab_holds")} data-testid="session-holds">
          <p className="border-b border-border px-5 py-2.5 text-[0.75rem] text-muted-foreground">{tr("booking.holds.intro")}</p>
          {holds.length === 0 ? (
            <p className="px-5 py-5 text-center text-[0.8125rem] text-muted-foreground">{tr("booking.holds.empty")}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[40rem] text-[0.8125rem]">
                <thead className="bg-[#faf9f6]">
                  <tr className="border-b border-border">
                    <th scope="col" className={cn(th, "w-36")}>{tr("booking.holds.kind")}</th>
                    <th scope="col" className={cn(th, "w-36 text-right")}>
                      {tr("booking.holds.used")} / {tr("booking.holds.quantity")}
                    </th>
                    <th scope="col" className={cn(th, "w-48")}>{tr("booking.holds.company")}</th>
                    <th scope="col" className={th}>{tr("booking.holds.note")}</th>
                    <th scope="col" className={cn(th, "w-28")}>
                      <span className="sr-only">{tr("booking.common.delete")}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {holds.map((h) => (
                    <tr key={h.id} className="border-b border-border last:border-b-0 hover:bg-[#faf9f6]">
                      <td className={td}>
                        <StatusPill tone={HOLD_TONE[h.kind]}>{tr(`booking.holdKind.${h.kind}`)}</StatusPill>
                      </td>
                      <td className={cn(td, "text-right font-semibold tabular-nums")}>
                        {h.used}
                        <span className="font-normal text-muted-foreground">/{h.quantity}</span>
                      </td>
                      <td className={td}>{h.companyName ?? <span className="text-muted-foreground">–</span>}</td>
                      <td className={cn(td, "text-muted-foreground")}>{h.note ?? "–"}</td>
                      <td className={cn(td, "text-right")}>{canWrite && !cancelled ? <DeleteHoldButton id={h.id} label={tr("booking.common.delete")} errors={errors} /> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {canWrite && !cancelled && session.endsAt.getTime() > now.getTime() ? (
            <div className="grid gap-2 border-t border-border bg-[#faf9f6] px-5 py-3">
              <h2 className="text-[0.8125rem] font-semibold">{tr("booking.holds.add")}</h2>
              <HoldForm
                inline
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
                  saving: tr("booking.common.saving"),
                  saved: tr("booking.common.saved"),
                  errors: { ...errors, capacity_below_bookings: tr("booking.holds.below_bookings") },
                }}
              />
            </div>
          ) : null}
        </Surface>
      ) : null}

      {tab === "details" && isEvent ? (
        <Surface className="grid gap-4" aria-label={session.eventCategory === "webinar" ? tr("booking.event.webinar_details") : tr("booking.event.details")} data-testid="event-details">
          {session.webinarGeekUrl ? (
            <p className="text-sm">
              {tr("booking.event.webinargeek_link")}:{" "}
              <a href={session.webinarGeekUrl} target="_blank" rel="noreferrer" className="underline underline-offset-4">
                {session.webinarGeekUrl}
              </a>
            </p>
          ) : null}
          {session.eventCategory === "webinar" ? <p className="text-sm text-muted-foreground">{tr("booking.event.webinargeek_intro")}</p> : null}
          {canOverride && !cancelled ? (
            <>
              <EventDetailsForm
                initial={{
                  id,
                  updatedAt: session.updatedAt.toISOString(),
                  isWebinar: session.eventCategory === "webinar",
                  title: session.title,
                  description: session.description ?? {},
                  startsLocal: localInput(session.startsAt),
                  endsLocal: localInput(session.endsAt),
                  capacity: session.capacitySeats ?? 0,
                  location: session.location ?? "",
                  price: price && price.amountCents > 0 ? (price.amountCents / 100).toFixed(2) : "",
                  webinarGeekUrl: session.webinarGeekUrl ?? "",
                  webinarGeekBroadcastId: session.webinarGeekBroadcastId ?? "",
                }}
                labels={{
                  title: localized(tr("booking.templates.name")),
                  description: localized(tr("booking.templates.description")),
                  startsAt: tr("booking.event.starts_at"),
                  endsAt: tr("booking.event.ends_at"),
                  seats: tr("booking.templates.capacity_seats"),
                  location: tr("booking.templates.location"),
                  price: tr("booking.event.price"),
                  priceHint: tr("booking.event.price_hint"),
                  webinarGeekUrl: tr("booking.event.webinargeek_url"),
                  webinarGeekUrlHint: tr("booking.event.webinargeek_url_hint"),
                  webinarGeekId: tr("booking.event.webinargeek_id"),
                  webinarGeekIdHint: tr("booking.event.webinargeek_id_hint"),
                  save: tr("booking.common.save"),
                  saving: tr("booking.common.saving"),
                  saved: tr("booking.common.saved"),
                  errors: { ...errors, validation: tr("platform.errors.validation") },
                }}
              />
              <EventMediaPanel
                sessionId={id}
                imageUrl={session.imageFileId ? `/api/public/files/${session.imageFileId}` : null}
                materials={materials}
                releasedAt={session.materialsReleasedAt ? formatDateTime(session.materialsReleasedAt, locale) : null}
                labels={{
                  artwork: tr("booking.event.artwork"),
                  artworkHint: tr("booking.event.artwork_hint"),
                  artworkAlt: tr("booking.event.artwork_alt", { title: show(session.title, locale) }),
                  materials: tr("booking.event.materials"),
                  materialsHint: tr("booking.event.materials_hint"),
                  noMaterials: tr("booking.event.no_materials"),
                  upload: tr("booking.event.upload"),
                  uploading: tr("booking.event.uploading"),
                  remove: tr("booking.common.delete"),
                  released: tr("booking.event.materials_released", { date: "{date}" }),
                  notReleased: tr("booking.event.materials_hidden"),
                  release: tr("booking.event.release_materials"),
                  unrelease: tr("booking.event.hide_materials"),
                  errors: { ...errors, validation: tr("platform.errors.validation"), file_too_large: tr("booking.event.file_too_large"), image_type_not_allowed: tr("booking.event.image_type"), svg_not_allowed: tr("booking.event.image_type") },
                }}
              />
            </>
          ) : null}
        </Surface>
      ) : null}

      {tab === "lead" && showLead ? (
        <Surface className="grid gap-3" aria-label={tr("booking.session.tab_lead")} data-testid="lead-tab">
          <p className="text-sm text-muted-foreground">{tr("booking.lead.intro")}</p>
          {session.isLeadMagnet ? (
            <dl className="grid gap-1 rounded-lg bg-muted px-3 py-2 text-sm" data-testid="lead-status">
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
        </Surface>
      ) : null}

      {tab === "tickets" && showTickets ? (
        <Surface className="grid gap-3" aria-label={tr("booking.session.tab_ticket_types")} data-testid="tickets-tab">
          <p className="text-sm text-muted-foreground">{tr("booking.tickets.intro")}</p>
          {ticketTypes.length === 0 ? <p className="text-sm text-muted-foreground">{tr("booking.tickets.empty")}</p> : null}
          {!ticketsOn || !canOverride || cancelled ? (
            <ul className="grid gap-2" data-testid="ticket-types-list">
              {ticketTypes.map((t) => (
                <li key={t.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm">
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
        </Surface>
      ) : null}

      {canOverride && !cancelled ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
          <p className="text-[0.8125rem] text-muted-foreground">{tr("booking.session.cancel_session_hint")}</p>
          <CancelSessionDialog
            sessionId={id}
            labels={{
              ...changeDialogLabels(tr, tr("booking.session.cancel_session"), tr("booking.session.cancel_session_reason")),
              notify: tr("booking.session.cancel_session_notify"),
              warning: tr("booking.session.cancel_session_confirm"),
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
