/**
 * booking queries, area `schedule` (booking spec 4.3, booking-P2): calendars, day view, templates,
 * exceptions, holds, the printable day list, upcoming public holidays and opening hours, plus
 * the read helpers the schedule actions use for their warnings (R6b, 3.0b). Pages call
 * `requireStaff({ permission })` before they call these; other modules never import this file
 * (they use `../api.ts`).
 */
import type { DbOrTx } from "@beam/db";
import { bookings, capacityHolds, companies, jobs, orderLines, orders, persons, products, sessionTemplates, sessions, vSessionAvailability } from "@beam/db/schema";
import {
  MATERIALISE_DAYS,
  addDays,
  brusselsDate,
  holidaySuggestions,
  openingHoursFor,
  overlapsByLocation,
  planOccurrences,
  timeToMinutes,
  zonedTimeToUtc,
  type BusinessHours,
  type SessionKind,
} from "@beam/core/booking";
import { LOCALES, t, type LocalizedText } from "@beam/core/i18n";
import { NotImplementedError } from "@beam/core/errors";
import { and, asc, eq, gt, gte, inArray, lt, ne, notInArray, sql } from "@/lib/ctx";
import { getSetting } from "@/lib/settings";
import { hasValidSubmission } from "@/modules/forms/api";
import { holidaysBetween, loadExceptionRows, toExceptionLike, type ExceptionRow } from "../api/schedule";
import { dateConflicts, templateLike, type DateConflict } from "../jobs/schedule";
import { hasEverAcceptedTerms } from "../server/terms";

export { getOpeningHours } from "../api/schedule";

export type SessionRow = typeof sessions.$inferSelect;
export type TemplateRow = typeof sessionTemplates.$inferSelect;

const dayStart = (onDate: string) => zonedTimeToUtc(onDate, "00:00");
const n = (x: unknown) => Number(x ?? 0);

// ---------------------------------------------------------------------------
// Warning helpers (R6b, 3.0b), used by the schedule actions
// ---------------------------------------------------------------------------

/**
 * R6b: ids of non-cancelled sessions in the same room (case-insensitive) that overlap one of
 * `slots`, other than `excludeSessionIds` and the sessions of `excludeTemplateIds`.
 */
export async function locationOverlaps(
  db: DbOrTx,
  location: string | null | undefined,
  slots: Array<{ startsAt: Date; endsAt: Date }>,
  opts: { excludeSessionIds?: string[]; excludeTemplateIds?: string[] } = {},
): Promise<string[]> {
  const room = (location ?? "").trim().toLowerCase();
  if (!room || slots.length === 0) return [];
  const from = new Date(Math.min(...slots.map((s) => s.startsAt.getTime())));
  const to = new Date(Math.max(...slots.map((s) => s.endsAt.getTime())));
  const others = await db
    .select({ id: sessions.id, location: sessions.location, startsAt: sessions.startsAt, endsAt: sessions.endsAt, templateId: sessions.templateId })
    .from(sessions)
    .where(
      and(
        ne(sessions.status, "cancelled"),
        sql`lower(trim(${sessions.location})) = ${room}`,
        lt(sessions.startsAt, to),
        gt(sessions.endsAt, from),
        opts.excludeSessionIds?.length ? notInArray(sessions.id, opts.excludeSessionIds) : undefined,
      ),
    );
  const candidates = others.filter((o) => !o.templateId || !opts.excludeTemplateIds?.includes(o.templateId));
  const hits = new Set<string>();
  for (const slot of slots) for (const id of overlapsByLocation({ location: room, ...slot }, candidates)) hits.add(id);
  return [...hits];
}

/** 3.0b: the ISO weekdays on which a day template starts before opening or ends after closing. */
export function outsideBusinessHours(hours: BusinessHours, t: { kind: SessionKind; weekdays: readonly number[]; startTime: string; durationMinutes: number }): number[] {
  if (t.kind !== "day") return [];
  const start = timeToMinutes(t.startTime);
  const end = start + t.durationMinutes;
  return t.weekdays.filter((wd) => {
    const day = hours.week[wd as 1 | 2 | 3 | 4 | 5 | 6 | 7];
    return !day || start < timeToMinutes(day.opens_at) || end > timeToMinutes(day.closes_at);
  });
}

// ---------------------------------------------------------------------------
// Calendar and day view
// ---------------------------------------------------------------------------

export type SessionBlock = {
  id: string;
  templateId: string | null;
  kind: SessionKind;
  title: LocalizedText;
  startsAt: Date;
  endsAt: Date;
  status: "open" | "closed" | "cancelled";
  eventCategory: string | null;
  isLeadMagnet: boolean;
  publishedAt: Date | null;
  location: string | null;
  capacity: number;
  held: number;
  booked: number;
  liveOffers: number;
  waiting: number;
  availableTotal: number;
};

function sessionBlocks(db: DbOrTx, where: ReturnType<typeof and>) {
  return db
    .select({
      id: sessions.id,
      templateId: sessions.templateId,
      kind: sessions.kind,
      title: sessions.title,
      startsAt: sessions.startsAt,
      endsAt: sessions.endsAt,
      status: sessions.status,
      eventCategory: sessions.eventCategory,
      isLeadMagnet: sessions.isLeadMagnet,
      publishedAt: sessions.publishedAt,
      location: sessions.location,
      capacity: vSessionAvailability.capacity,
      held: vSessionAvailability.held,
      booked: vSessionAvailability.booked,
      liveOffers: vSessionAvailability.liveOffers,
      waiting: vSessionAvailability.waiting,
      availableTotal: vSessionAvailability.availableTotal,
    })
    .from(sessions)
    .innerJoin(vSessionAvailability, eq(vSessionAvailability.sessionId, sessions.id))
    .where(where)
    .orderBy(asc(sessions.startsAt), asc(sessions.id));
}

const toBlock = (r: Awaited<ReturnType<typeof sessionBlocks>>[number]): SessionBlock => ({
  ...r,
  title: r.title,
  capacity: n(r.capacity),
  held: n(r.held),
  booked: n(r.booked),
  liveOffers: n(r.liveOffers),
  waiting: n(r.waiting),
  availableTotal: n(r.availableTotal),
});

/** `/admin/sessions`: every session starting in `[from, to)`, with its availability. */
export async function listSessionsInRange(db: DbOrTx, input: { from: Date; to: Date; kind?: SessionKind }): Promise<SessionBlock[]> {
  const rows = await sessionBlocks(db, and(gte(sessions.startsAt, input.from), lt(sessions.startsAt, input.to), input.kind ? eq(sessions.kind, input.kind) : undefined));
  return rows.map(toBlock);
}

export type DayViewSession = SessionBlock & { attendees: number; checkedIn: number; unpaidAtDesk: number };

/** `/admin/sessions/day/[date]`: the day's sessions, opening hours and exceptions. */
export async function getDayView(
  db: DbOrTx,
  input: { onDate: string },
): Promise<{ onDate: string; sessions: DayViewSession[]; openingHours: { opensAt: string; closesAt: string } | null; exceptions: ExceptionRow[]; conflicts: DateConflict[] }> {
  const blocks = (await sessionBlocks(db, and(gte(sessions.startsAt, dayStart(input.onDate)), lt(sessions.startsAt, dayStart(addDays(input.onDate, 1)))))).map(toBlock);
  const ids = blocks.map((b) => b.id);
  const counts = ids.length
    ? await db
        .select({
          sessionId: bookings.sessionId,
          attendees: sql<number>`count(*) filter (where ${bookings.status} in ('reserved', 'confirmed', 'attended'))::int`,
          checkedIn: sql<number>`count(*) filter (where ${bookings.status} = 'attended')::int`,
          unpaidAtDesk: sql<number>`count(*) filter (where ${bookings.status} = 'reserved' and ${bookings.isPayAtDesk})::int`,
        })
        .from(bookings)
        .where(inArray(bookings.sessionId, ids))
        .groupBy(bookings.sessionId)
    : [];
  const byId = new Map(counts.map((c) => [c.sessionId, c]));
  const hours = await getSetting(db, "business_hours");
  const exceptions = await loadExceptionRows(db, input.onDate, input.onDate);
  return {
    onDate: input.onDate,
    sessions: blocks.map((b) => ({ ...b, attendees: n(byId.get(b.id)?.attendees), checkedIn: n(byId.get(b.id)?.checkedIn), unpaidAtDesk: n(byId.get(b.id)?.unpaidAtDesk) })),
    openingHours: openingHoursFor(input.onDate, hours, exceptions.map(toExceptionLike)),
    exceptions,
    conflicts: await dateConflicts(db, input.onDate),
  };
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

/** `/admin/sessions/templates`: every template, active first, then by kind and start time. */
export function listTemplates(db: DbOrTx): Promise<TemplateRow[]> {
  return db.select().from(sessionTemplates).orderBy(sql`${sessionTemplates.isActive} desc`, asc(sessionTemplates.kind), asc(sessionTemplates.startTime), asc(sessionTemplates.createdAt));
}

/**
 * `/admin/sessions/templates/[id]`: the template, its planned occurrences of the next 14 days and
 * the future sessions a regeneration keeps because they are booked, held, waited on or edited.
 */
export async function getTemplate(
  db: DbOrTx,
  id: string,
  now: Date = new Date(),
): Promise<{ template: TemplateRow; preview: Array<{ startsAt: Date; endsAt: Date }>; kept: Array<{ sessionId: string; startsAt: Date; bookings: number }> } | null> {
  const [template] = await db.select().from(sessionTemplates).where(eq(sessionTemplates.id, id));
  if (!template) return null;
  const today = brusselsDate(now);
  const exceptions = (await loadExceptionRows(db, today, addDays(today, 13))).map(toExceptionLike);
  const preview = template.isActive ? planOccurrences(templateLike(template), exceptions, today, addDays(today, 13)).filter((p) => p.startsAt > now) : [];
  const kept = await db
    .select({
      sessionId: sessions.id,
      startsAt: sessions.startsAt,
      bookings: sql<number>`(select count(*)::int from bookings b where b.session_id = "sessions"."id")`,
    })
    .from(sessions)
    .where(
      and(
        eq(sessions.templateId, id),
        gt(sessions.startsAt, now),
        sql`(${sessions.hasManualChanges} or ${sessions.status} <> 'open'
          or exists (select 1 from bookings b where b.session_id = "sessions"."id")
          or exists (select 1 from waitlist_entries w where w.session_id = "sessions"."id")
          or exists (select 1 from capacity_holds c where c.session_id = "sessions"."id"))`,
      ),
    )
    .orderBy(asc(sessions.startsAt))
    .limit(200);
  return { template, preview, kept: kept.map((k) => ({ ...k, bookings: n(k.bookings) })) };
}

// ---------------------------------------------------------------------------
// Exceptions and holidays (R4, R4b)
// ---------------------------------------------------------------------------

/** `/admin/sessions/exceptions`: exceptions in `[from, to]` with the conflicts of their date. */
export async function listExceptions(db: DbOrTx, input: { from: string; to: string }): Promise<Array<ExceptionRow & { conflicts: DateConflict[] }>> {
  const rows = await loadExceptionRows(db, input.from, input.to);
  const byDate = new Map<string, DateConflict[]>();
  for (const d of new Set(rows.map((r) => r.onDate))) byDate.set(d, await dateConflicts(db, d));
  return rows.map((r) => ({ ...r, conflicts: byDate.get(r.onDate) ?? [] }));
}

/** The catalogue name of a public holiday in the three locales (`booking.holidays.<key>`). */
export function holidayName(key: string): LocalizedText {
  return Object.fromEntries(LOCALES.map((l) => [l, t(l, `booking.holidays.${key}`)]));
}

/** R4b: Belgian public holidays of the next 12 months without an exception on their date. */
export async function listUpcomingHolidays(db: DbOrTx, now: Date = new Date()): Promise<Array<{ onDate: string; key: string; name: LocalizedText }>> {
  const fromOn = brusselsDate(now);
  const toOn = addDays(fromOn, 365);
  const exceptions = (await loadExceptionRows(db, fromOn, toOn)).map(toExceptionLike);
  return holidaySuggestions(holidaysBetween(fromOn, toOn), exceptions, fromOn, toOn).map((h) => ({ ...h, name: holidayName(h.key) }));
}

// ---------------------------------------------------------------------------
// Holds
// ---------------------------------------------------------------------------

export type HoldRow = {
  id: string;
  sessionId: string;
  sessionTitle: LocalizedText;
  startsAt: Date;
  kind: "staff" | "partner" | "host" | "speaker" | "blocked";
  quantity: number;
  used: number;
  companyId: string | null;
  companyName: string | null;
  note: string | null;
};

/** `/admin/sessions/holds`: holds of sessions that have not ended, with their live bookings. */
export async function listHolds(db: DbOrTx, input: { now?: Date; sessionId?: string } = {}): Promise<HoldRow[]> {
  const rows = await db
    .select({
      id: capacityHolds.id,
      sessionId: capacityHolds.sessionId,
      sessionTitle: sessions.title,
      startsAt: sessions.startsAt,
      kind: capacityHolds.kind,
      quantity: capacityHolds.quantity,
      used: sql<number>`(select count(*)::int from bookings b where b.capacity_hold_id = "capacity_holds"."id" and b.status in ('reserved', 'confirmed', 'attended', 'no_show'))`,
      companyId: capacityHolds.companyId,
      companyName: companies.name,
      note: capacityHolds.note,
    })
    .from(capacityHolds)
    .innerJoin(sessions, eq(sessions.id, capacityHolds.sessionId))
    .leftJoin(companies, eq(companies.id, capacityHolds.companyId))
    .where(and(gt(sessions.endsAt, input.now ?? new Date()), input.sessionId ? eq(capacityHolds.sessionId, input.sessionId) : undefined))
    .orderBy(asc(sessions.startsAt), asc(capacityHolds.createdAt));
  return rows.map((r) => ({ ...r, sessionTitle: r.sessionTitle, used: n(r.used) }));
}

/** Upcoming open sessions for the hold form's session picker (next `days` days). */
export async function listHoldableSessions(db: DbOrTx, input: { now?: Date; days?: number } = {}): Promise<Array<{ id: string; title: LocalizedText; startsAt: Date; kind: SessionKind }>> {
  const now = input.now ?? new Date();
  const rows = await db
    .select({ id: sessions.id, title: sessions.title, startsAt: sessions.startsAt, kind: sessions.kind })
    .from(sessions)
    .where(and(gt(sessions.startsAt, now), lt(sessions.startsAt, new Date(now.getTime() + (input.days ?? 60) * 86_400_000)), ne(sessions.status, "cancelled")))
    .orderBy(asc(sessions.startsAt))
    .limit(500);
  return rows.map((r) => ({ ...r, title: r.title }));
}

/** Company names for the partner hold picker (crm `companies`, names only). */
export function listCompanyOptions(db: DbOrTx): Promise<Array<{ id: string; name: string }>> {
  return db.select({ id: companies.id, name: companies.name }).from(companies).orderBy(asc(companies.name)).limit(500);
}

/** The status of the template's regeneration job for its current version (`regenerate:<id>:<version>`). */
export async function getRegenerationStatus(db: DbOrTx, template: { id: string; version: number }): Promise<{ jobId: string; status: string; lastError: string | null } | null> {
  const [row] = await db
    .select({ jobId: jobs.id, status: jobs.status, lastError: jobs.lastError })
    .from(jobs)
    .where(eq(jobs.idempotencyKey, `regenerate:${template.id}:${template.version}`));
  return row ?? null;
}

/** Active session, night and ticket products for the "single-ticket product" pickers (names only). */
export async function listProductOptions(db: DbOrTx): Promise<Array<{ id: string; kind: string; sku: string; name: LocalizedText }>> {
  const rows = await db
    .select({ id: products.id, kind: products.kind, sku: products.sku, name: products.name })
    .from(products)
    .where(and(eq(products.isActive, true), inArray(products.kind, ["session", "night", "ticket"])))
    .orderBy(asc(products.kind), asc(products.sortOrder), asc(products.sku))
    .limit(200);
  return rows.map((r) => ({ ...r, name: r.name }));
}

/** The session row (for the edit form and the session actions' pages). */
export async function getSession(db: DbOrTx, id: string): Promise<SessionRow | null> {
  const [row] = await db.select().from(sessions).where(eq(sessions.id, id));
  return row ?? null;
}

/** Templates and materialisation horizon in one look (for the calendar's empty state). */
export async function scheduleSummary(db: DbOrTx, now: Date = new Date()): Promise<{ activeTemplates: number; materialisedThroughOn: string | null; horizonOn: string }> {
  const [a] = await db.select({ c: sql<number>`count(*)::int` }).from(sessionTemplates).where(eq(sessionTemplates.isActive, true));
  const [m] = await db.select({ last: sql<Date | null>`max(${sessions.startsAt})` }).from(sessions).where(sql`${sessions.templateId} is not null`);
  const last = m?.last ? new Date(m.last) : null;
  return { activeTemplates: n(a?.c), materialisedThroughOn: last ? brusselsDate(last) : null, horizonOn: addDays(brusselsDate(now), MATERIALISE_DAYS) };
}

// ---------------------------------------------------------------------------
// Printable day list (R62b)
// ---------------------------------------------------------------------------

export type PrintAttendee = {
  bookingId: string;
  personId: string;
  name: string;
  guestOf: string | null;
  status: "reserved" | "confirmed" | "attended";
  paidWith: "credit" | "order" | "guest" | "free";
  isPayAtDesk: boolean;
  /** Cents still to pay at the desk (an unpaid order line), else null. */
  toPayCents: number | null;
  termsPending: boolean;
  healthMissing: boolean;
  notes: string | null;
};

export type PrintSession = {
  sessionId: string;
  title: LocalizedText;
  kind: SessionKind;
  status: "open" | "closed" | "cancelled";
  startsAt: Date;
  endsAt: Date;
  location: string | null;
  attendees: PrintAttendee[];
};

const HEALTH_FORM = "health-declaration";

const fullName = (first: string | null, last: string | null) => [first, last].filter((x) => x && x.trim()).join(" ") || "—";

/** forms' validity check; while forms has not landed it, a declaration counts as missing. */
async function healthValid(db: DbOrTx, personId: string): Promise<boolean> {
  try {
    return (await hasValidSubmission(db, { personId, formSlug: HEALTH_FORM })).valid;
  } catch (error) {
    if (error instanceof NotImplementedError) return false;
    throw error;
  }
}

/**
 * `/admin/sessions/day/[date]/print`: every non-cancelled session of the day with its live
 * attendees (time, name, guest of, paid with, to pay, terms pending, health declaration
 * missing or expired, notes): the reception's fallback when the network is down.
 */
export async function getDayPrintList(db: DbOrTx, input: { onDate: string }): Promise<{ onDate: string; sessions: PrintSession[] }> {
  const list = await db
    .select({ id: sessions.id, title: sessions.title, kind: sessions.kind, status: sessions.status, startsAt: sessions.startsAt, endsAt: sessions.endsAt, location: sessions.location })
    .from(sessions)
    .where(and(gte(sessions.startsAt, dayStart(input.onDate)), lt(sessions.startsAt, dayStart(addDays(input.onDate, 1))), ne(sessions.status, "cancelled")))
    .orderBy(asc(sessions.startsAt), asc(sessions.id));
  if (list.length === 0) return { onDate: input.onDate, sessions: [] };

  const rows = await db
    .select({
      bookingId: bookings.id,
      sessionId: bookings.sessionId,
      personId: bookings.personId,
      firstName: persons.firstName,
      lastName: persons.lastName,
      guestOfBookingId: bookings.guestOfBookingId,
      status: bookings.status,
      paidWith: bookings.paidWith,
      isPayAtDesk: bookings.isPayAtDesk,
      notes: bookings.notes,
      lineTotalCents: orderLines.lineTotalCents,
      lineQuantity: orderLines.quantity,
      orderStatus: orders.status,
      createdAt: bookings.createdAt,
    })
    .from(bookings)
    .innerJoin(persons, eq(persons.id, bookings.personId))
    .leftJoin(orderLines, eq(orderLines.id, bookings.orderLineId))
    .leftJoin(orders, eq(orders.id, orderLines.orderId))
    .where(and(inArray(bookings.sessionId, list.map((s) => s.id)), inArray(bookings.status, ["reserved", "confirmed", "attended"])))
    .orderBy(asc(persons.lastName), asc(persons.firstName), asc(bookings.createdAt));

  const ownerIds = [...new Set(rows.map((r) => r.guestOfBookingId).filter((x): x is string => !!x))];
  const owners = ownerIds.length
    ? await db
        .select({ id: bookings.id, firstName: persons.firstName, lastName: persons.lastName })
        .from(bookings)
        .innerJoin(persons, eq(persons.id, bookings.personId))
        .where(inArray(bookings.id, ownerIds))
    : [];
  const ownerName = new Map(owners.map((o) => [o.id, fullName(o.firstName, o.lastName)]));
  const people = [...new Set(rows.map((r) => r.personId))];
  const terms = new Map<string, boolean>();
  const health = new Map<string, boolean>();
  for (const id of people) {
    terms.set(id, await hasEverAcceptedTerms(db, id));
    health.set(id, await healthValid(db, id));
  }

  return {
    onDate: input.onDate,
    sessions: list.map((s) => ({
      sessionId: s.id,
      title: s.title,
      kind: s.kind,
      status: s.status,
      startsAt: s.startsAt,
      endsAt: s.endsAt,
      location: s.location,
      attendees: rows
        .filter((r) => r.sessionId === s.id)
        .map((r) => {
          const unpaid = r.status === "reserved" && r.lineTotalCents !== null && r.orderStatus !== "paid";
          return {
            bookingId: r.bookingId,
            personId: r.personId,
            name: fullName(r.firstName, r.lastName),
            guestOf: r.guestOfBookingId ? (ownerName.get(r.guestOfBookingId) ?? "—") : null,
            status: r.status as PrintAttendee["status"],
            paidWith: r.paidWith,
            isPayAtDesk: r.isPayAtDesk,
            toPayCents: unpaid ? Math.round(n(r.lineTotalCents) / Math.max(1, n(r.lineQuantity))) : null,
            termsPending: !terms.get(r.personId),
            healthMissing: !health.get(r.personId),
            notes: r.notes,
          };
        }),
    })),
  };
}
