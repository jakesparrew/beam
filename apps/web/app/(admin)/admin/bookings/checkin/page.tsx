import Link from "next/link";
import type { Route } from "next";
import type { ReactNode } from "react";
import { NavIcon, cn } from "@beam/ui";
import { BOOKING_CONFLICT_REASONS, brusselsDate, brusselsTime, type BookingRules } from "@beam/core/booking";
import { formatDate, formatMoney, type Locale, type LocalizedText } from "@beam/core/i18n";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, softTranslator, translator } from "@/lib/i18n";
import { getSetting } from "@/lib/settings";
import { attendanceFlags, codeFromScan, getCheckinCard, getCheckinDay, searchCheckin, type CheckinCard, type CheckinRow } from "@/modules/booking/queries";
import { BookingCard, type BookingCardView } from "@/modules/booking/ui/booking-card";
import { CheckInAllButton, CheckInButton, CheckinDesk } from "@/modules/booking/ui/checkin-desk";
import { Initials } from "@/modules/booking/ui/kit";
import { DeskCreditsBadge } from "@/modules/credits/api";
import { PageHeader, PrimaryAction, SecondaryAction, StatusPill, Surface, td, th, type Tone } from "@/modules/platform/ui/admin-kit";

const show = (text: LocalizedText | null | undefined, locale: Locale) => text?.[locale] || text?.["nl-BE"] || text?.en || text?.["fr-BE"] || "";
type Tr = (key: string, params?: Record<string, string | number>) => string;
const UUID = /^[0-9a-f-]{36}$/i;
const HERE = "/admin/bookings/checkin";

/** A catalogue key that may not exist yet, with an existing fallback (Missing-catalogue-keys of booking-P4). */
const orKey = (soft: Tr, key: string, fallback: string) => {
  const v = soft(key);
  return v === key ? fallback : v;
};

/** Icon per session kind, shared by the session tabs and the result card. */
const KIND_ICON = { day: "sun", night: "moon", event: "calendar-days" } as const;
const PAID_TONE: Record<CheckinRow["paidWith"], Tone> = { order: "ok", credit: "ok", guest: "ok", free: "muted" };

function cardView(c: CheckinCard, locale: Locale, tr: Tr, soft: Tr, canOverride: boolean): BookingCardView {
  const rc = c.receptionCard;
  const cues: BookingCardView["cues"] = [
    ...(c.kind === "night" ? [{ icon: "moon", label: tr("booking.checkin.cue_night") }] : []),
    ...(rc?.isMember ? [{ icon: "badge-check", label: tr("booking.checkin.cue_member") }] : []),
    ...(c.paidWith === "credit" ? [{ icon: "package", label: tr("booking.checkin.cue_package") }] : []),
    ...(rc?.isMinor ? [{ icon: "baby", label: tr("booking.checkin.cue_child") }] : []),
    ...(c.guestOfName ? [{ icon: "user-plus", label: tr("booking.checkin.guests_of", { name: c.guestOfName }) }] : []),
  ];
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
    name: c.ageGroup ? `${c.name} (${tr(`booking.ageGroup.${c.ageGroup}`)})` : c.name,
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
    cues,
    guests: c.guests.map((g) => ({
      bookingId: g.bookingId,
      // Children come as guests of the adult (owner's review 1): the desk sees their age group.
      name: g.ageGroup ? `${g.name} (${tr(`booking.ageGroup.${g.ageGroup}`)})` : g.name,
      statusLabel: tr(`booking.status.${g.status}`),
      canCheckIn: (g.status === "confirmed" || g.status === "no_show") && c.inWindow && !c.wrongDay,
    })),
  };
}

/** One small icon per thing to look at (terms, health declaration, notes), its meaning as tooltip and for screen readers. */
function Attention({ row, tr }: { row: CheckinRow; tr: Tr }) {
  const items = [
    ...(!row.termsAccepted ? [{ icon: "scroll-text", label: tr("booking.checkin.terms_pending"), warn: true }] : []),
    ...(row.healthDeclaration.state !== "valid"
      ? [{ icon: "activity", label: tr(row.healthDeclaration.state === "expired" ? "booking.checkin.health_expired" : "booking.checkin.health_missing"), warn: true }]
      : []),
    ...(row.notes ? [{ icon: "sticky-note", label: `${tr("booking.session.attendee_notes")}: ${row.notes}`, warn: false }] : []),
  ];
  if (!items.length) return <span className="text-muted-foreground">–</span>;
  return (
    <span className="flex items-center gap-1">
      {items.map((i) => (
        <span
          key={i.icon}
          title={i.label}
          className={cn("grid size-6 place-items-center rounded-md", i.warn ? "bg-[var(--status-warn-soft)] text-[var(--status-warn)]" : "bg-muted text-muted-foreground")}
        >
          <NavIcon icon={i.icon} className="size-3.5" />
          <span className="sr-only">{i.label}</span>
        </span>
      ))}
    </span>
  );
}

type RowCtx = { tr: Tr; locale: Locale; rules: BookingRules; now: Date; canWrite: boolean; errors: Record<string, string>; sessionParam?: string };

/** One attendee as a table row: who, what they booked, payment, attention and the one-click action. */
function GuestRow({ row, ctx, withSession }: { row: CheckinRow; ctx: RowCtx; withSession: boolean }) {
  const { tr, locale } = ctx;
  const arrived = row.status === "attended";
  const flags = attendanceFlags(row, ctx.rules, ctx.now);
  const open = `${HERE}?${new URLSearchParams({ ...(ctx.sessionParam ? { s: ctx.sessionParam } : {}), b: row.bookingId })}` as Route;
  const extra = [row.ageGroup ? tr(`booking.ageGroup.${row.ageGroup}`) : null, row.guestOfName ? tr("booking.checkin.guest_of_name", { name: row.guestOfName }) : null].filter(Boolean).join(" · ");
  const payment =
    row.toPayCents !== null ? (
      <StatusPill tone="warn">{tr("booking.checkin.to_pay", { amount: formatMoney(row.toPayCents, locale) })}</StatusPill>
    ) : row.status === "reserved" ? (
      <StatusPill tone="warn">{tr("booking.status.reserved")}</StatusPill>
    ) : (
      <StatusPill tone={PAID_TONE[row.paidWith]}>{tr(`booking.paidWith.${row.paidWith}`)}</StatusPill>
    );
  let action: ReactNode = <span className="text-muted-foreground">–</span>;
  if (arrived && row.attendedAt) {
    action = (
      <span className="inline-flex items-center gap-1.5 font-medium text-[var(--status-ok)]" title={tr("booking.checkin.already_checked_in", { time: brusselsTime(row.attendedAt) })}>
        <NavIcon icon="circle-check" className="size-4" />
        {brusselsTime(row.attendedAt)}
      </span>
    );
  } else if (row.status === "reserved" && row.orderId) {
    action = (
      <Link href={`/admin/pos?order=${row.orderId}` as Route} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-[0.8125rem] font-semibold hover:bg-muted">
        <NavIcon icon="credit-card" />
        {tr("booking.checkin.take_payment")}
      </Link>
    );
  } else if (ctx.canWrite && flags.canCheckIn) {
    action = <CheckInButton bookingId={row.bookingId} label={tr("booking.checkin.check_in")} errors={ctx.errors} />;
  } else if (row.status === "confirmed" && ctx.now.getTime() < flags.opensAt.getTime()) {
    action = <span className="text-[0.75rem] text-muted-foreground">{tr("booking.checkin.opens_at", { time: brusselsTime(flags.opensAt) })}</span>;
  } else if (row.status === "confirmed") {
    action = <span className="text-[0.75rem] text-muted-foreground">{tr("booking.checkin.window_closed")}</span>;
  }
  return (
    <tr className={cn("border-b border-border last:border-b-0 hover:bg-[#faf9f6]", arrived && "text-muted-foreground")} data-status={row.status}>
      <td className={td}>
        {/* Rows still to arrive carry the booking id on their link (the desk's e2e contract). */}
        <Link href={open} className="flex items-center gap-2.5" {...(arrived ? {} : { "data-booking-id": row.bookingId })}>
          <Initials id={row.personId} name={row.name} className={cn(arrived && "opacity-60")} />
          <span className="grid leading-tight">
            <span className={cn("font-semibold hover:underline", !arrived && "text-foreground")}>{row.name || "—"}</span>
            {row.email ? <span className="text-[0.75rem] text-muted-foreground">{row.email}</span> : null}
          </span>
        </Link>
      </td>
      <td className={td}>
        <span className="grid leading-tight">
          <span className="whitespace-nowrap">{withSession ? `${brusselsTime(row.startsAt)} · ${show(row.sessionTitle, locale)}` : tr(`booking.kind.${row.kind}`)}</span>
          {extra ? <span className="text-[0.75rem] text-muted-foreground">{extra}</span> : null}
        </span>
      </td>
      <td className={td}>{payment}</td>
      <td className={td}>
        <Attention row={row} tr={tr} />
      </td>
      <td className={cn(td, "text-right whitespace-nowrap")}>{action}</td>
    </tr>
  );
}

function GuestTable({ ctx, withSession, groups }: { ctx: RowCtx; withSession: boolean; groups: { key: string; label?: string; rows: CheckinRow[] }[] }) {
  const { tr } = ctx;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[46rem] text-[0.8125rem]">
        <thead className="bg-[#faf9f6]">
          <tr className="border-b border-border">
            <th scope="col" className={th}>{tr("booking.checkin.col_guest")}</th>
            <th scope="col" className={cn(th, "w-56")}>{tr("booking.checkin.col_booked")}</th>
            <th scope="col" className={cn(th, "w-44")}>{tr("booking.checkin.col_payment")}</th>
            <th scope="col" className={cn(th, "w-28")}>{tr("booking.checkin.col_attention")}</th>
            <th scope="col" className={cn(th, "w-36 text-right")}>{tr("booking.checkin.col_action")}</th>
          </tr>
        </thead>
        {groups
          .filter((g) => g.rows.length)
          .map((g) => (
            <tbody key={g.key}>
              {g.label ? (
                <tr className="border-b border-border bg-[#fcfbf9]">
                  <th scope="rowgroup" colSpan={5} className="px-5 py-1.5 text-left text-[0.75rem] font-semibold text-muted-foreground">
                    {g.label} <span className="font-normal tabular-nums">· {g.rows.length}</span>
                  </th>
                </tr>
              ) : null}
              {g.rows.map((r) => (
                <GuestRow key={r.bookingId} row={r} ctx={ctx} withSession={withSession} />
              ))}
            </tbody>
          ))}
      </table>
    </div>
  );
}

/**
 * `/admin/bookings/checkin` (`bookings.write`, booking spec 5.1, R35, R62b): the reception desk,
 * as a reception tool (owner review, November 2026). A compact scan bar with "Add walk-in" and
 * "Print day list" beside it; `?c=<code>` is the QR URL, `?q=` the scan field (a code or a name),
 * `?b=` a chosen booking: the result card or the name matches show under the bar. Then today's
 * sessions as tabs (time and "x of y checked in"; `?s=` picks one, else the session running now,
 * the next one or the last), the chosen session's guests as one table (who, what they booked,
 * payment, one attention column of small icons, a one-click "Check in" and "Check in all"),
 * those checked in below, muted, with their arrival time. A missing health declaration or
 * unaccepted terms are icons, never a block.
 */
export default async function CheckinPage({ searchParams }: { searchParams: Promise<{ q?: string; c?: string; b?: string; s?: string }> }) {
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
  const bookingId = sp.b && UUID.test(sp.b) ? sp.b : undefined;

  const [card, matches, day, rules] = await Promise.all([
    bookingId ? getCheckinCard(db, { bookingId, now }) : code ? getCheckinCard(db, { code, now }) : Promise.resolve(null),
    !bookingId && !code && input ? searchCheckin(db, { onDate: today, q: input }) : Promise.resolve([]),
    getCheckinDay(db, { onDate: today }),
    getSetting(db, "booking_rules"),
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

  // The chosen tab, else the card's session (a scan of today), else the latest session running now, the next one or the last.
  const running = day.filter((s) => s.startsAt.getTime() <= now.getTime() && now.getTime() < s.endsAt.getTime());
  const selected =
    day.find((s) => s.sessionId === sp.s) ??
    (card ? day.find((s) => s.sessionId === card.sessionId) : undefined) ??
    running.at(-1) ??
    day.find((s) => s.startsAt.getTime() > now.getTime()) ??
    day.at(-1);
  const canWrite = hasPermission(actor, "bookings.write");
  const searchCtx: RowCtx = { tr, locale, rules, now, canWrite, errors };
  const ctx: RowCtx = selected ? { ...searchCtx, sessionParam: selected.sessionId } : searchCtx;
  const done = day.reduce((n, s) => n + s.arrived, 0);
  const total = day.reduce((n, s) => n + s.arrived + s.notArrived.length, 0);
  const toCheck = selected ? selected.notArrived.filter((r) => attendanceFlags(r, rules, now).canCheckIn).map((r) => r.bookingId) : [];

  return (
    <div className="grid gap-5">
      <PageHeader
        title={tr("booking.checkin.title")}
        description={
          <span className="inline-block first-letter:uppercase">
            {formatDate(today, locale, "full")}
            {day.length ? ` · ${tr("booking.day.checked_in", { done, total })}` : ""}
          </span>
        }
      />
      <CheckinDesk
        labels={{ scan: tr("booking.checkin.scan_label"), submit: soft("crm.common.search"), hint: orKey(soft, "booking.checkin.scan_hint", tr("booking.bookings.search")) }}
        actions={
          <>
            <SecondaryAction href={`/admin/sessions/day/${today}/print` as Route}>{tr("booking.day.print")}</SecondaryAction>
            <PrimaryAction href="/admin/bookings/new">
              <NavIcon icon="user-plus" />
              {tr("booking.checkin.add_walk_in")}
            </PrimaryAction>
          </>
        }
      >
        {card ? (
          <BookingCard
            card={cardView(card, locale, tr, soft, hasPermission(actor, "bookings.override"))}
            labels={cardLabels}
            canWrite
            // credits-P6: "Day: 4 · Night: 1 · Member until ..." (renders nothing without `credits.read`).
            credits={<DeskCreditsBadge personId={card.personId} locale={locale} />}
          />
        ) : null}
        {notFound ? (
          <p role="status" className="rounded-lg bg-[var(--status-bad-soft)] px-3 py-2 text-[0.8125rem] font-medium text-[var(--status-bad)]" data-testid="checkin-not-found">
            {tr("booking.checkin.not_found")}
          </p>
        ) : null}
        {matches.length ? (
          <Surface flush>
            <h2 className="border-b border-border px-5 py-2.5 text-[0.8125rem] font-semibold">{tr("booking.checkin.results_for", { q: input })}</h2>
            <GuestTable ctx={searchCtx} withSession groups={[{ key: "matches", rows: matches }]} />
          </Surface>
        ) : null}
      </CheckinDesk>

      {day.length === 0 || !selected ? (
        <Surface className="text-center text-[0.8125rem] text-muted-foreground">{tr("booking.day.empty")}</Surface>
      ) : (
        <Surface flush data-session-id={selected.sessionId}>
          <nav aria-label={tr("booking.checkin.today_sessions")} className="flex overflow-x-auto border-b border-border bg-[#faf9f6]">
            {day.map((s) => {
              const active = s.sessionId === selected.sessionId;
              return (
                <Link
                  key={s.sessionId}
                  href={`${HERE}?s=${s.sessionId}` as Route}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "-mb-px grid max-w-52 shrink-0 gap-0.5 border-b-2 px-4 py-2 text-left",
                    active ? "border-[#c9973a] bg-card text-foreground" : "border-transparent text-muted-foreground hover:bg-card hover:text-foreground",
                  )}
                >
                  <span className="flex items-center gap-1.5 text-[0.8125rem] font-semibold whitespace-nowrap">
                    <NavIcon icon={KIND_ICON[s.kind]} className="size-3.5 shrink-0" />
                    {brusselsTime(s.startsAt)}
                    <span className="truncate font-normal">{show(s.title, locale)}</span>
                  </span>
                  <span className="text-[0.75rem] whitespace-nowrap tabular-nums">{tr("booking.day.checked_in", { done: s.arrived, total: s.arrived + s.notArrived.length })}</span>
                </Link>
              );
            })}
          </nav>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-2.5">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <Link href={`/admin/sessions/${selected.sessionId}` as Route} className="font-semibold hover:underline">
                {brusselsTime(selected.startsAt)}–{brusselsTime(selected.endsAt)} · {show(selected.title, locale)}
              </Link>
              <span className="text-[0.75rem] text-muted-foreground">{tr(`booking.kind.${selected.kind}`)}</span>
              {selected.status === "closed" ? <StatusPill tone="muted">{tr("booking.sessionStatus.closed")}</StatusPill> : null}
            </span>
            {canWrite && toCheck.length ? <CheckInAllButton bookingIds={toCheck} label={tr("booking.checkin.check_in_all")} errors={errors} /> : null}
          </div>
          {selected.notArrived.length || selected.checkedIn.length ? (
            <GuestTable
              ctx={ctx}
              withSession={false}
              groups={[
                { key: "waiting", label: tr("booking.checkin.not_arrived"), rows: selected.notArrived },
                { key: "arrived", label: tr("booking.checkin.checked_in"), rows: selected.checkedIn },
              ]}
            />
          ) : (
            <p className="px-5 py-6 text-center text-[0.8125rem] text-muted-foreground">{tr("booking.session.empty")}</p>
          )}
        </Surface>
      )}
    </div>
  );
}
