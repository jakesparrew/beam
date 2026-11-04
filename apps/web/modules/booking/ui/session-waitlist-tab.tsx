/**
 * The waitlist tab of `/admin/sessions/[id]` (booking spec 5.1), booking-P5: the session's
 * entries in the staff `WaitlistTable` (`waitlist.manage`; without it the tab says nothing is
 * shown). Also exports the label and row builders the `/admin/waitlist` page shares.
 */
import { formatDateTime, type Locale, type LocalizedText } from "@beam/core/i18n";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { listWaitlistRows, type StaffWaitlistRow } from "../queries/waitlist";
import { WaitlistTable, type WaitlistTableLabels, type WaitlistTableRow } from "./waitlist-table";

type Tr = (key: string, params?: Record<string, string | number>) => string;

/** A title in `locale`, falling back to any filled locale (staff screens never fail on a gap). */
export const showText = (text: LocalizedText | null | undefined, locale: Locale): string =>
  text?.[locale] || text?.["nl-BE"] || text?.en || text?.["fr-BE"] || "";

const QUEUES = ["lead", "customer", "public"] as const;
const STATES = ["waiting", "offered", "confirmed", "released", "expired", "withdrawn"] as const;
const ERRORS = ["session_full", "already_waiting", "already_booked", "protected_seat", "outside_window", "session_closed", "invalid_transition", "member_only"] as const;

/** The table's texts from the `booking` catalogue. */
export function waitlistTableLabels(tr: Tr): WaitlistTableLabels {
  return {
    person: tr("booking.bookings.person"),
    queue: tr("booking.session.waiting"),
    joinedAt: tr("booking.waitlist.joined_at"),
    offerExpires: tr("booking.waitlist.offer_expires"),
    signals: tr("booking.waitlist.signals"),
    offerSeat: tr("booking.waitlist.offer_seat"),
    moveQueue: tr("booking.waitlist.move_queue"),
    reorder: tr("booking.waitlist.reorder"),
    release: tr("booking.waitlist.release"),
    withdraw: tr("booking.waitlist.withdraw"),
    clearFlag: tr("booking.waitlist.clear_flag"),
    reason: tr("booking.manual.reason"),
    noEmailPhone: tr("booking.waitlist.no_email_phone"),
    confirm: tr("booking.common.confirm"),
    empty: tr("booking.waitlist.empty"),
    queues: Object.fromEntries(QUEUES.map((q) => [q, tr(`booking.queue.${q}`)])) as WaitlistTableLabels["queues"],
    states: Object.fromEntries(STATES.map((s) => [s, tr(`booking.waitlistState.${s}`)])) as WaitlistTableLabels["states"],
    errors: { ...Object.fromEntries(ERRORS.map((e) => [e, tr(`booking.errors.${e}`)])), validation: tr("booking.errors.invalid_transition") },
  };
}

/** Query rows to table rows (dates as ISO strings, titles in the staff locale). */
export function toTableRows(rows: StaffWaitlistRow[], locale: Locale): WaitlistTableRow[] {
  return rows.map((r) => ({
    entryId: r.entryId,
    sessionId: r.sessionId,
    sessionLabel: `${showText(r.sessionTitle, locale)} · ${formatDateTime(r.startsAt, locale, "full")}`,
    personName: r.personName,
    hasEmail: r.hasEmail,
    queue: r.queue,
    state: r.state,
    joinedAt: r.joinedAt.toISOString(),
    offerExpiresAt: r.offerExpiresAt ? r.offerExpiresAt.toISOString() : null,
    isFlagged: r.isFlagged,
    flagReason: r.flagReason,
    bookingId: r.bookingId,
  }));
}

export async function SessionWaitlistTab(props: { sessionId: string }) {
  const actor = await requireStaff({ permission: "bookings.read" });
  const locale = await adminLocale();
  const tr = translator(locale);
  if (!hasPermission(actor, "waitlist.manage")) return <p className="text-sm text-muted-foreground">{tr("booking.waitlist.empty")}</p>;
  const { rows } = await listWaitlistRows(await getAppDb(), { sessionId: props.sessionId });
  return <WaitlistTable rows={toTableRows(rows, locale)} labels={waitlistTableLabels(tr)} showSession={false} />;
}
