/**
 * booking queries, area `attendance` (booking spec 4.3, R35, R62b), booking-P4: the check-in
 * desk's name search (`searchCheckin`), the result card of a scanned code or a chosen booking
 * (`getCheckinCard`) and the scan parser (`codeFromScan`). Staff queries call
 * `requirePermission('bookings.read')`. Each attendee row carries the health declaration state
 * from forms' `hasValidSubmission` and whether the person ever accepted the terms; neither ever
 * blocks a check-in. Other modules never import this file (they use `../api.ts`).
 */
import type { DbOrTx } from "@beam/db";
import { activityEvents, bookings, creditEntries, orderLines, orders, persons, sessions, vSessionAvailability } from "@beam/db/schema";
import { BOOKING_CONFLICT_REASONS, addDays, brusselsDate, brusselsTime, freeCancelUntil, isCheckinCode, normaliseCheckinCode, zonedTimeToUtc, type BookingRules, type BookingStatus, type PaidWith, type SessionKind } from "@beam/core/booking";
import { NotImplementedError } from "@beam/core/errors";
import { formatDateTime, formatMoney, type Locale, type LocalizedText } from "@beam/core/i18n";
import { requirePermission } from "@/lib/auth";
import { and, asc, eq, gte, inArray, isNull, lt, ne, or, sql } from "@/lib/ctx";
import { getSetting } from "@/lib/settings";
import { getPersonCreditSummary } from "@/modules/credits/api";
import { getReceptionCard, type ReceptionCardData } from "@/modules/crm/api";
import { hasValidSubmission } from "@/modules/forms/api";
import { checkInWindow, revertNoShowUntil } from "../jobs/attendance";
import { HEALTH_DECLARATION_FORM } from "../server/declarations";
import { hasEverAcceptedTerms } from "../server/terms";
import type { AttendeeListLabels, AttendeeRowView } from "../ui/attendee-list";
import type { ChangeDialogLabels } from "../ui/cancel-dialog";

/** Rows of a name search (the set is one day, so no index is needed). */
const SEARCH_LIMIT = 50;

/** The statuses the desk shows (live, checked in, no-show); cancelled rows never appear. */
const DESK_STATUSES: BookingStatus[] = ["reserved", "confirmed", "attended", "no_show"];

const dayStart = (onDate: string) => zonedTimeToUtc(onDate, "00:00");
const fullName = (first: string | null, last: string | null) => [first, last].filter((x) => x && x.trim()).join(" ");

/**
 * Reads a scanner's or keyboard's input as a check-in code: the bare code (any case, `O`/`I`/`L`
 * read the Crockford way, dashes and spaces dropped) or the QR URL
 * `https://<host>/admin/bookings/checkin?c=<code>`. Anything else (a name) is null.
 */
export function codeFromScan(input: string): string | null {
  let raw = input.trim();
  const m = /[?&]c=([^&#\s]+)/.exec(raw);
  if (m?.[1]) {
    try {
      raw = decodeURIComponent(m[1]);
    } catch {
      raw = m[1];
    }
  }
  const code = normaliseCheckinCode(raw);
  return isCheckinCode(code) ? code : null;
}

export type HealthDeclarationState = { valid: boolean; expiresAt: Date | null; state: "valid" | "expired" | "missing" };

/** forms' validity check (R62b); while forms has not landed it, the declaration reads as missing. */
export async function healthDeclarationOf(db: DbOrTx, personId: string): Promise<HealthDeclarationState> {
  try {
    const r = await hasValidSubmission(db, { personId, formSlug: HEALTH_DECLARATION_FORM });
    return { valid: r.valid, expiresAt: r.expiresAt, state: r.valid ? "valid" : r.completedAt ? "expired" : "missing" };
  } catch (error) {
    if (error instanceof NotImplementedError) return { valid: false, expiresAt: null, state: "missing" };
    throw error;
  }
}

export type CheckinRow = {
  bookingId: string;
  sessionId: string;
  sessionTitle: LocalizedText;
  kind: SessionKind;
  startsAt: Date;
  endsAt: Date;
  personId: string;
  name: string;
  email: string | null;
  status: BookingStatus;
  paidWith: PaidWith;
  guestOfBookingId: string | null;
  guestOfName: string | null;
  isPayAtDesk: boolean;
  /** The unpaid order of a `reserved` row (POS link) and its amount per seat; else null. */
  orderId: string | null;
  toPayCents: number | null;
  attendedAt: Date | null;
  notes: string | null;
  healthDeclaration: HealthDeclarationState;
  termsAccepted: boolean;
};

type RawRow = {
  bookingId: string;
  sessionId: string;
  sessionTitle: LocalizedText;
  kind: SessionKind;
  startsAt: Date;
  endsAt: Date;
  personId: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  status: BookingStatus;
  paidWith: PaidWith;
  guestOfBookingId: string | null;
  isPayAtDesk: boolean;
  orderId: string | null;
  orderStatus: string | null;
  lineTotalCents: number | null;
  lineQuantity: number | null;
  attendedAt: Date | null;
  notes: string | null;
};

function rowSelect(db: DbOrTx) {
  return db
    .select({
      bookingId: bookings.id,
      sessionId: bookings.sessionId,
      sessionTitle: sessions.title,
      kind: sessions.kind,
      startsAt: sessions.startsAt,
      endsAt: sessions.endsAt,
      personId: bookings.personId,
      firstName: persons.firstName,
      lastName: persons.lastName,
      email: persons.email,
      status: bookings.status,
      paidWith: bookings.paidWith,
      guestOfBookingId: bookings.guestOfBookingId,
      isPayAtDesk: bookings.isPayAtDesk,
      orderId: orders.id,
      orderStatus: orders.status,
      lineTotalCents: orderLines.lineTotalCents,
      lineQuantity: orderLines.quantity,
      attendedAt: bookings.attendedAt,
      notes: bookings.notes,
    })
    .from(bookings)
    .innerJoin(sessions, eq(sessions.id, bookings.sessionId))
    .innerJoin(persons, eq(persons.id, bookings.personId))
    .leftJoin(orderLines, eq(orderLines.id, bookings.orderLineId))
    .leftJoin(orders, eq(orders.id, orderLines.orderId));
}

/** Owner names of guest rows, health declaration and terms per person. */
async function enrich(db: DbOrTx, rows: RawRow[]): Promise<CheckinRow[]> {
  const ownerIds = [...new Set(rows.map((r) => r.guestOfBookingId).filter((x): x is string => !!x))];
  const owners = ownerIds.length
    ? await db
        .select({ id: bookings.id, firstName: persons.firstName, lastName: persons.lastName })
        .from(bookings)
        .innerJoin(persons, eq(persons.id, bookings.personId))
        .where(inArray(bookings.id, ownerIds))
    : [];
  const ownerName = new Map(owners.map((o) => [o.id, fullName(o.firstName, o.lastName)]));
  const health = new Map<string, HealthDeclarationState>();
  const terms = new Map<string, boolean>();
  for (const id of new Set(rows.map((r) => r.personId))) {
    health.set(id, await healthDeclarationOf(db, id));
    terms.set(id, await hasEverAcceptedTerms(db, id));
  }
  return rows.map((r) => {
    const unpaid = r.status === "reserved" && r.lineTotalCents !== null && r.orderStatus !== "paid";
    return {
      bookingId: r.bookingId,
      sessionId: r.sessionId,
      sessionTitle: r.sessionTitle,
      kind: r.kind,
      startsAt: r.startsAt,
      endsAt: r.endsAt,
      personId: r.personId,
      name: fullName(r.firstName, r.lastName),
      email: r.email,
      status: r.status,
      paidWith: r.paidWith,
      guestOfBookingId: r.guestOfBookingId,
      guestOfName: r.guestOfBookingId ? (ownerName.get(r.guestOfBookingId) ?? null) : null,
      isPayAtDesk: r.isPayAtDesk,
      orderId: unpaid ? r.orderId : null,
      toPayCents: unpaid ? Math.round((r.lineTotalCents ?? 0) / Math.max(1, r.lineQuantity ?? 1)) : null,
      attendedAt: r.attendedAt,
      notes: r.notes,
      healthDeclaration: health.get(r.personId)!,
      termsAccepted: terms.get(r.personId) ?? false,
    };
  });
}

/**
 * The desk's name search (booking spec 4.3): attendees of the sessions that start on `onDate`
 * (Brussels day, not cancelled) whose `first_name || ' ' || last_name` or email contains `q`,
 * case-insensitive. Guests without an email are found by name.
 */
export async function searchCheckin(db: DbOrTx, input: { onDate: string; q: string }): Promise<CheckinRow[]> {
  await requirePermission("bookings.read");
  const q = input.q.trim();
  if (!q) return [];
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const name = sql`(coalesce(${persons.firstName}, '') || ' ' || coalesce(${persons.lastName}, ''))`;
  const rows = await rowSelect(db)
    .where(
      and(
        gte(sessions.startsAt, dayStart(input.onDate)),
        lt(sessions.startsAt, dayStart(addDays(input.onDate, 1))),
        ne(sessions.status, "cancelled"),
        inArray(bookings.status, DESK_STATUSES),
        or(sql`${name} ilike ${like}`, sql`${persons.email} ilike ${like}`),
      ),
    )
    .orderBy(asc(sessions.startsAt), asc(persons.lastName), asc(persons.firstName), asc(bookings.id))
    .limit(SEARCH_LIMIT);
  return enrich(db, rows);
}

export type CheckinCard = CheckinRow & {
  /** The guests of this (owner) booking, checked in one by one ("Check in all" runs one action each). */
  guests: CheckinRow[];
  /** The session is not on `now`'s Brussels day: shown with a warning and no check-in button. */
  wrongDay: boolean;
  /** `now` is inside the check-in window of `settings.booking_rules.check_in` (R35). */
  inWindow: boolean;
  /** `confirmed` (or `no_show`) row inside the window on the right day: the big button shows. */
  canCheckIn: boolean;
  canUndo: boolean;
  canMarkNoShow: boolean;
  canRevertNoShow: boolean;
  opensAt: Date;
  closesAt: Date;
  /** crm's reception card; null while crm has not landed it. */
  receptionCard: ReceptionCardData | null;
};

/**
 * The result card of a scanned code or a chosen booking (`/admin/bookings/checkin?c=` or `?b=`):
 * the row with its guests, the window flags of R35-R37, the payment still due and crm's
 * reception card. Null when nothing matches ("not found"); cancelled rows are found too, so the
 * desk can say so.
 */
export async function getCheckinCard(db: DbOrTx, input: { code?: string; bookingId?: string; now?: Date }): Promise<CheckinCard | null> {
  await requirePermission("bookings.read");
  const now = input.now ?? new Date();
  const code = input.code ? codeFromScan(input.code) : null;
  if (!code && !input.bookingId) return null;
  const [raw] = await rowSelect(db).where(code ? eq(bookings.checkinCode, code) : eq(bookings.id, input.bookingId!));
  if (!raw) return null;
  const guestRows = await rowSelect(db)
    .where(and(eq(bookings.guestOfBookingId, raw.bookingId), inArray(bookings.status, DESK_STATUSES)))
    .orderBy(asc(bookings.createdAt), asc(bookings.id));
  const [row, ...guests] = await enrich(db, [raw, ...guestRows]);
  const rules: BookingRules = await getSetting(db, "booking_rules");
  const { opensAt, closesAt } = checkInWindow(raw, rules);
  const today = brusselsDate(now);
  const wrongDay = brusselsDate(raw.startsAt) !== today && brusselsDate(raw.endsAt) !== today;
  const inWindow = now.getTime() >= opensAt.getTime() && now.getTime() <= closesAt.getTime();
  let receptionCard: ReceptionCardData | null = null;
  try {
    receptionCard = await getReceptionCard(db, raw.personId);
  } catch (error) {
    if (!(error instanceof NotImplementedError)) throw error;
  }
  return {
    ...row!,
    guests,
    wrongDay,
    inWindow,
    canCheckIn: (raw.status === "confirmed" || raw.status === "no_show") && inWindow && !wrongDay,
    canUndo: raw.status === "attended" && now.getTime() <= closesAt.getTime(),
    canMarkNoShow: raw.status === "confirmed" && now.getTime() >= raw.startsAt.getTime(),
    canRevertNoShow: raw.status === "no_show" && now.getTime() <= revertNoShowUntil(raw, rules).getTime(),
    opensAt,
    closesAt,
    receptionCard,
  };
}

export type CheckinDaySession = {
  sessionId: string;
  title: LocalizedText;
  kind: SessionKind;
  startsAt: Date;
  endsAt: Date;
  status: "open" | "closed" | "cancelled";
  arrived: number;
  /** Live rows not checked in yet, with their health declaration state. */
  notArrived: CheckinRow[];
};

/** The desk's day: every non-cancelled session of `onDate` with the attendees not yet arrived (R35, R62b). */
export async function getCheckinDay(db: DbOrTx, input: { onDate: string }): Promise<CheckinDaySession[]> {
  await requirePermission("bookings.read");
  const list = await db
    .select({ id: sessions.id, title: sessions.title, kind: sessions.kind, startsAt: sessions.startsAt, endsAt: sessions.endsAt, status: sessions.status })
    .from(sessions)
    .where(and(gte(sessions.startsAt, dayStart(input.onDate)), lt(sessions.startsAt, dayStart(addDays(input.onDate, 1))), ne(sessions.status, "cancelled")))
    .orderBy(asc(sessions.startsAt), asc(sessions.id));
  if (list.length === 0) return [];
  const ids = list.map((s) => s.id);
  const counts = await db
    .select({ sessionId: bookings.sessionId, arrived: sql<number>`count(*)::int` })
    .from(bookings)
    .where(and(inArray(bookings.sessionId, ids), eq(bookings.status, "attended")))
    .groupBy(bookings.sessionId);
  const arrived = new Map(counts.map((c) => [c.sessionId, Number(c.arrived)]));
  const waiting = await enrich(
    db,
    await rowSelect(db)
      .where(and(inArray(bookings.sessionId, ids), inArray(bookings.status, ["reserved", "confirmed"])))
      .orderBy(asc(persons.lastName), asc(persons.firstName), asc(bookings.id)),
  );
  return list.map((s) => ({
    sessionId: s.id,
    title: s.title,
    kind: s.kind,
    startsAt: s.startsAt,
    endsAt: s.endsAt,
    status: s.status,
    arrived: arrived.get(s.id) ?? 0,
    notArrived: waiting.filter((r) => r.sessionId === s.id),
  }));
}

export type ManualBookingSession = {
  id: string;
  title: LocalizedText;
  kind: SessionKind;
  startsAt: Date;
  endsAt: Date;
  status: "open" | "closed" | "cancelled";
  availableTotal: number;
  capacity: number;
  creditKind: "day" | "night" | null;
  creditCost: number;
  productId: string | null;
  /** `settings.booking_rules.pay_at_desk` allows this kind and the session has a price (R63). */
  payAtDeskAllowed: boolean;
  /** The person's remaining units of the session's credit kind; null without credits or a person. */
  creditBalance: number | null;
};

/**
 * The manual booking wizard's session picker (booking spec 5.1 `/admin/bookings/new`): open and
 * closed sessions starting in `[from, to)` (webinar sessions excluded, R64) with their live
 * availability, the payment options and the chosen person's credit balance per kind.
 */
export async function listManualBookingSessions(db: DbOrTx, input: { from: Date; to: Date; personId?: string }): Promise<ManualBookingSession[]> {
  await requirePermission("bookings.write");
  const rows = await db
    .select({
      id: sessions.id,
      title: sessions.title,
      kind: sessions.kind,
      startsAt: sessions.startsAt,
      endsAt: sessions.endsAt,
      status: sessions.status,
      creditKind: sessions.creditKind,
      creditCost: sessions.creditCost,
      productId: sessions.productId,
      availableTotal: vSessionAvailability.availableTotal,
      capacity: vSessionAvailability.capacity,
    })
    .from(sessions)
    .innerJoin(vSessionAvailability, eq(vSessionAvailability.sessionId, sessions.id))
    .where(and(gte(sessions.startsAt, input.from), lt(sessions.startsAt, input.to), ne(sessions.status, "cancelled"), isNull(sessions.webinarId)))
    .orderBy(asc(sessions.startsAt), asc(sessions.id));
  const rules: BookingRules = await getSetting(db, "booking_rules");
  let balance: Map<string, number> | null = null;
  if (input.personId) {
    try {
      const summary = await getPersonCreditSummary(db, input.personId);
      balance = new Map(summary.byKind.map((k) => [k.kind as string, k.remainingUnits]));
    } catch (error) {
      if (!(error instanceof NotImplementedError)) throw error;
    }
  }
  return rows.map((r) => ({
    ...r,
    availableTotal: Number(r.availableTotal ?? 0),
    capacity: Number(r.capacity ?? 0),
    payAtDeskAllowed: rules.pay_at_desk.enabled && rules.pay_at_desk.kinds.includes(r.kind) && r.productId !== null,
    creditBalance: r.creditKind && balance ? (balance.get(r.creditKind) ?? 0) : null,
  }));
}

// ---------------------------------------------------------------------------
// Session detail and booking detail (booking spec 5.1)
// ---------------------------------------------------------------------------

export type AttendanceFlags = { canCheckIn: boolean; canUndo: boolean; canMarkNoShow: boolean; canRevertNoShow: boolean; inWindow: boolean };

/** Which attendance buttons a row shows at `now` (R35-R37); the actions check the same rules. */
export function attendanceFlags(row: { status: BookingStatus; startsAt: Date; endsAt: Date }, rules: BookingRules, now: Date): AttendanceFlags {
  const { opensAt, closesAt } = checkInWindow(row, rules);
  const t = now.getTime();
  const inWindow = t >= opensAt.getTime() && t <= closesAt.getTime();
  return {
    inWindow,
    canCheckIn: row.status === "confirmed" && inWindow,
    canUndo: row.status === "attended" && t <= closesAt.getTime(),
    canMarkNoShow: row.status === "confirmed" && t >= row.startsAt.getTime(),
    canRevertNoShow: row.status === "no_show" && t <= revertNoShowUntil(row, rules).getTime(),
  };
}

export type SessionAttendee = {
  bookingId: string;
  version: number;
  personId: string;
  name: string;
  guestOfBookingId: string | null;
  guestOfName: string | null;
  paidWith: PaidWith;
  status: BookingStatus;
  isPayAtDesk: boolean;
  isOverCapacity: boolean;
  ticketTypeId: string | null;
  toPayCents: number | null;
  notes: string | null;
  attendedAt: Date | null;
  guestCount: number;
};

/** `/admin/sessions/[id]` attendee list: every booking of the session (cancelled ones last), owners before their guests. */
export async function getSessionAttendees(db: DbOrTx, sessionId: string): Promise<SessionAttendee[]> {
  await requirePermission("bookings.read");
  const rows = await db
    .select({
      bookingId: bookings.id,
      version: bookings.version,
      personId: bookings.personId,
      firstName: persons.firstName,
      lastName: persons.lastName,
      guestOfBookingId: bookings.guestOfBookingId,
      paidWith: bookings.paidWith,
      status: bookings.status,
      isPayAtDesk: bookings.isPayAtDesk,
      isOverCapacity: bookings.isOverCapacity,
      ticketTypeId: bookings.ticketTypeId,
      notes: bookings.notes,
      attendedAt: bookings.attendedAt,
      orderStatus: orders.status,
      lineTotalCents: orderLines.lineTotalCents,
      lineQuantity: orderLines.quantity,
      createdAt: bookings.createdAt,
    })
    .from(bookings)
    .innerJoin(persons, eq(persons.id, bookings.personId))
    .leftJoin(orderLines, eq(orderLines.id, bookings.orderLineId))
    .leftJoin(orders, eq(orders.id, orderLines.orderId))
    .where(eq(bookings.sessionId, sessionId))
    .orderBy(sql`${bookings.status} in ('cancelled', 'late_cancelled')`, asc(persons.lastName), asc(persons.firstName), asc(bookings.createdAt));
  const names = new Map(rows.map((r) => [r.bookingId, fullName(r.firstName, r.lastName)]));
  const guests = new Map<string, number>();
  for (const r of rows) if (r.guestOfBookingId && (r.status === "reserved" || r.status === "confirmed")) guests.set(r.guestOfBookingId, (guests.get(r.guestOfBookingId) ?? 0) + 1);
  const list: SessionAttendee[] = rows.map((r) => ({
    bookingId: r.bookingId,
    version: r.version,
    personId: r.personId,
    name: names.get(r.bookingId) ?? "",
    guestOfBookingId: r.guestOfBookingId,
    guestOfName: r.guestOfBookingId ? (names.get(r.guestOfBookingId) ?? null) : null,
    paidWith: r.paidWith,
    status: r.status,
    isPayAtDesk: r.isPayAtDesk,
    isOverCapacity: r.isOverCapacity,
    ticketTypeId: r.ticketTypeId,
    toPayCents: r.status === "reserved" && r.lineTotalCents !== null && r.orderStatus !== "paid" ? Math.round(r.lineTotalCents / Math.max(1, r.lineQuantity ?? 1)) : null,
    notes: r.notes,
    attendedAt: r.attendedAt,
    guestCount: guests.get(r.bookingId) ?? 0,
  }));
  // Guests right after their owner.
  const owners = list.filter((r) => !r.guestOfBookingId || !names.has(r.guestOfBookingId));
  return owners.flatMap((o) => [o, ...list.filter((g) => g.guestOfBookingId === o.bookingId)]);
}

/** `/admin/bookings/[id]` status history: the booking's facts (kind, time, actor kind), oldest first; never `data`. */
export async function getBookingHistory(db: DbOrTx, bookingId: string): Promise<Array<{ kind: string; occurredAt: Date; actorKind: string }>> {
  await requirePermission("bookings.read");
  const rows = await db
    .select({ kind: activityEvents.kind, occurredAt: activityEvents.occurredAt, actor: activityEvents.actor })
    .from(activityEvents)
    .where(and(eq(activityEvents.refType, "booking"), eq(activityEvents.refId, bookingId)))
    .orderBy(asc(activityEvents.occurredAt), asc(activityEvents.id));
  return rows.map((r) => ({ kind: r.kind, occurredAt: r.occurredAt, actorKind: (r.actor as { kind?: string } | null)?.kind ?? "system" }));
}

/** `/admin/bookings/[id]` credits used: the ledger rows that reference the booking (consume and release). */
export async function getBookingCreditEntries(db: DbOrTx, bookingId: string): Promise<Array<{ kind: string; quantity: number; createdAt: Date }>> {
  await requirePermission("bookings.read");
  return db
    .select({ kind: creditEntries.kind, quantity: creditEntries.quantity, createdAt: creditEntries.createdAt })
    .from(creditEntries)
    .where(and(eq(creditEntries.refType, "booking"), eq(creditEntries.refId, bookingId)))
    .orderBy(asc(creditEntries.createdAt));
}

// ---------------------------------------------------------------------------
// View helpers of the staff screens (server side; the ui components take plain props)
// ---------------------------------------------------------------------------

export type Tr = (key: string, params?: Record<string, string | number>) => string;

/** A catalogue key that may not exist yet, with an existing fallback (Missing-catalogue-keys of booking-P4). */
export const orKey = (soft: Tr, key: string, fallback: string) => {
  const v = soft(key);
  return v === key ? fallback : v;
};

/** The staff error texts of the booking actions. */
export function bookingErrorLabels(tr: Tr): Record<string, string> {
  return {
    ...Object.fromEntries(BOOKING_CONFLICT_REASONS.map((r) => [r, tr(`booking.errors.${r}`)])),
    validation: tr("platform.errors.validation"),
    forbidden: tr("platform.errors.forbidden"),
    not_found: tr("platform.errors.not_found"),
    internal: tr("platform.errors.internal"),
  };
}

/** The attendee list texts (session detail and booking detail). */
export function attendeeListLabels(tr: Tr, soft: Tr): AttendeeListLabels {
  const errors = bookingErrorLabels(tr);
  return {
    columns: {
      name: tr("booking.session.attendee_name"),
      guestOf: tr("booking.session.attendee_guest_of"),
      paidWith: tr("booking.session.attendee_paid_with"),
      status: tr("booking.session.attendee_status"),
      notes: tr("booking.session.attendee_notes"),
      actions: soft("platform.jobs.col_actions"),
    },
    checkIn: tr("booking.session.check_in"),
    undo: tr("booking.session.undo_check_in"),
    markNoShow: tr("booking.session.mark_no_show"),
    revertNoShow: orKey(soft, "booking.session.revert_no_show", tr("booking.session.check_in")),
    editNotes: tr("booking.bookings.edit_notes"),
    save: tr("booking.common.save"),
    cancel: tr("booking.common.cancel"),
    open: tr("booking.day.open_session"),
    noHealthNotes: tr("booking.common.no_health_notes"),
    empty: tr("booking.session.empty"),
    errors,
    cancelDialog: {
      trigger: tr("booking.session.cancel_booking"),
      title: tr("booking.session.cancel_booking"),
      includeGuests: orKey(soft, "booking.bookings.include_guests", tr("booking.bookings.guests")),
      reason: tr("booking.bookings.force_reason"),
      noHealthNotes: tr("booking.common.no_health_notes"),
      forceTitle: tr("booking.manual.override_title"),
      forceNone: tr("booking.session.cancel_booking"),
      forceReleaseCredit: tr("booking.bookings.force_release_credit"),
      forceRefund: tr("booking.bookings.force_refund"),
      confirm: tr("booking.common.confirm"),
      close: tr("booking.common.close"),
      reload: tr("booking.common.reload"),
      errors: { ...errors, stale_version: tr("booking.common.stale_version") },
    },
  };
}

/** One attendee row's view: labels, flags and the cancel policy preview. */
export function attendeeRow(
  a: SessionAttendee,
  session: { kind: "day" | "night" | "event"; startsAt: Date; endsAt: Date },
  rules: BookingRules,
  ctx: { now: Date; locale: Locale; tr: Tr; canOverride: boolean },
): AttendeeRowView {
  const f = attendanceFlags({ status: a.status, startsAt: session.startsAt, endsAt: session.endsAt }, rules, ctx.now);
  const freeUntil = freeCancelUntil(session.kind, session.startsAt, rules);
  const policy =
    a.status === "reserved" || (freeUntil && ctx.now.getTime() <= freeUntil.getTime())
      ? ctx.tr("booking.bookings.policy_free", { date: formatDateTime(freeUntil ?? session.startsAt, ctx.locale, "full") })
      : ctx.tr("booking.bookings.policy_late");
  return {
    bookingId: a.bookingId,
    version: a.version,
    name: a.name || "—",
    guestOf: a.guestOfName,
    paidWith: ctx.tr(`booking.paidWith.${a.paidWith}`),
    status: a.status,
    statusLabel: a.status === "attended" && a.attendedAt ? `${ctx.tr("booking.status.attended")} ${brusselsTime(a.attendedAt)}` : ctx.tr(`booking.status.${a.status}`),
    toPay: a.toPayCents !== null ? ctx.tr("booking.checkin.to_pay", { amount: formatMoney(a.toPayCents, ctx.locale) }) : null,
    notes: a.notes,
    hasGuests: a.guestCount > 0,
    canCheckIn: f.canCheckIn,
    canUndo: f.canUndo,
    canMarkNoShow: f.canMarkNoShow,
    canRevertNoShow: f.canRevertNoShow,
    canCancel: (a.status === "confirmed" || a.status === "reserved" || (a.status === "late_cancelled" && ctx.canOverride)) && ctx.now.getTime() < session.endsAt.getTime(),
    policy,
  };
}

/** The texts of a staff change dialog (reschedule, add guest, cancel session). */
export function changeDialogLabels(tr: Tr, trigger: string, reason: string = tr("booking.manual.reason")): ChangeDialogLabels {
  return {
    trigger,
    title: trigger,
    reason,
    confirm: tr("booking.common.confirm"),
    close: tr("booking.common.close"),
    reload: tr("booking.common.reload"),
    errors: { ...bookingErrorLabels(tr), stale_version: tr("booking.common.stale_version") },
  };
}
