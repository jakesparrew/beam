import Link from "next/link";
import type { Route } from "next";
import { notFound, redirect } from "next/navigation";
import { cn } from "@beam/ui";
import { BOOKING_CONFLICT_REASONS, brusselsTime } from "@beam/core/booking";
import { ForbiddenError } from "@beam/core/errors";
import { formatDate, type Locale, type LocalizedText } from "@beam/core/i18n";
import { hasPermission, requireStaff } from "@/lib/auth";
import { createCtx, getAppDb, type Tx } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { assignHoldSeat, unassignHoldSeat } from "@/modules/booking/actions";
import { listCompanyOptions, listHoldableSessions, listHolds, listMyPartnerHolds, type PartnerHoldRow } from "@/modules/booking/queries";
import { DeleteHoldButton, HoldForm } from "@/modules/booking/ui/hold-form";
import { PageHeader, StatusPill, Surface, td, th, type Tone } from "@/modules/platform/ui/admin-kit";
import { partnerScope } from "@/modules/platform/api";

const show = (text: LocalizedText | null | undefined, locale: Locale) => text?.[locale] || text?.["nl-BE"] || text?.en || text?.["fr-BE"] || "";
const KINDS = ["staff", "partner", "host", "speaker", "blocked"] as const;
const KIND_TONE: Record<(typeof KINDS)[number], Tone> = { staff: "muted", partner: "info", host: "gold", speaker: "gold", blocked: "bad" };
const HERE = "/admin/sessions/holds";
const input = "h-9 rounded-lg border border-input bg-card px-2.5 text-[0.8125rem]";
const button = "inline-flex h-9 items-center rounded-lg border border-border bg-card px-3 text-[0.8125rem] font-semibold hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2";

type Search = { assigned?: string; unassigned?: string; error?: string };

/** Posts one seat assignment (R3) and comes back with the outcome in the query string. */
async function assign(formData: FormData) {
  "use server";
  const field = (k: string) => {
    const v = formData.get(k);
    return typeof v === "string" ? v : "";
  };
  const res = await assignHoldSeat({ holdId: field("holdId"), firstName: field("firstName"), lastName: field("lastName"), email: field("email") });
  redirect((res.ok ? `${HERE}?assigned=1` : `${HERE}?error=${encodeURIComponent(outcomeOf(res.error))}`) as Route);
}

/** Frees one assigned seat (R3). */
async function unassign(formData: FormData) {
  "use server";
  const bookingId = formData.get("bookingId");
  const res = await unassignHoldSeat({ bookingId: typeof bookingId === "string" ? bookingId : "" });
  redirect((res.ok ? `${HERE}?unassigned=1` : `${HERE}?error=${encodeURIComponent(outcomeOf(res.error))}`) as Route);
}

function outcomeOf(error: { code: string; message: string }): string {
  return error.code === "conflict" ? error.message : error.code;
}

/**
 * `/admin/sessions/holds` (booking spec 5.1, R11; R3 booking-P9), the blocked places, in the
 * back-office kit (owner review, November 2026). Staff (`bookings.read`; changes need
 * `bookings.write`): one table of the places held for staff, partners, hosts or speakers, or
 * blocked, across sessions that have not ended (session, kind, used of places, company, note),
 * the names on held places and the add form. Partner mode (`partner.own`: an `external_partner`,
 * or a user with `partner.own` but without `bookings.read`): only the holds of their own company
 * from platform's `partnerScope`, with counts and the names they entered, never another attendee
 * and never the staff note; they add and remove names, nothing else.
 */
export default async function HoldsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const actor = await requireStaff();
  const canRead = hasPermission(actor, "bookings.read");
  const partnerMode = actor.roleKey === "external_partner" || (!canRead && hasPermission(actor, "partner.own"));
  if (!partnerMode && !canRead) notFound();
  const sp = await searchParams;
  const locale = await adminLocale();
  const tr = translator(locale);
  const db = await getAppDb();
  const sessionLabel = (s: { title: LocalizedText; startsAt: Date }) => `${formatDate(s.startsAt, locale)} ${brusselsTime(s.startsAt)} · ${show(s.title, locale)}`;
  const status = statusLine(sp, tr);

  if (partnerMode) {
    let companyId: string;
    try {
      ({ companyId } = await partnerScope(createCtx({ tx: db as unknown as Tx, actor })));
    } catch (error) {
      if (error instanceof ForbiddenError) notFound();
      throw error;
    }
    const seatHolds = await listMyPartnerHolds(db, { companyId });
    return (
      <div className="grid gap-5">
        <PageHeader title={tr("booking.holds.partner_title")} description={tr("booking.holds.partner_intro")} />
        {status}
        {seatHolds.length === 0 ? (
          <Surface className="text-center text-[0.8125rem] text-muted-foreground">{tr("booking.holds.empty")}</Surface>
        ) : (
          <HoldSeats holds={seatHolds} canAssign tr={tr} sessionLabel={sessionLabel} />
        )}
      </div>
    );
  }

  const canWrite = hasPermission(actor, "bookings.write");
  const [holds, seatHolds, sessions, companies] = await Promise.all([
    listHolds(db),
    listMyPartnerHolds(db, { companyId: null }),
    canWrite ? listHoldableSessions(db) : Promise.resolve([]),
    canWrite ? listCompanyOptions(db) : Promise.resolve([]),
  ]);
  const errors = {
    ...Object.fromEntries(BOOKING_CONFLICT_REASONS.map((r) => [r, tr(`booking.errors.${r}`)])),
    capacity_below_bookings: tr("booking.holds.below_bookings"),
    validation: tr("platform.errors.validation"),
    forbidden: tr("platform.errors.forbidden"),
    not_found: tr("platform.errors.not_found"),
  };

  return (
    <div className="grid gap-5">
      <PageHeader title={tr("booking.holds.title")} description={tr("booking.holds.intro")} />
      {status}
      {holds.length === 0 ? (
        <Surface className="text-center text-[0.8125rem] text-muted-foreground">{tr("booking.holds.empty")}</Surface>
      ) : (
        <Surface flush data-testid="holds-list">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[48rem] text-[0.8125rem]">
              <thead className="bg-[#faf9f6]">
                <tr className="border-b border-border">
                  <th scope="col" className={th}>{tr("booking.holds.session")}</th>
                  <th scope="col" className={cn(th, "w-32")}>{tr("booking.holds.kind")}</th>
                  <th scope="col" className={cn(th, "w-36 text-right")}>
                    {tr("booking.holds.used")} / {tr("booking.holds.quantity")}
                  </th>
                  <th scope="col" className={cn(th, "w-44")}>{tr("booking.holds.company")}</th>
                  <th scope="col" className={cn(th, "w-56")}>{tr("booking.holds.note")}</th>
                  <th scope="col" className={cn(th, "w-28")}>
                    <span className="sr-only">{tr("booking.common.delete")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {holds.map((h) => (
                  <tr key={h.id} className="border-b border-border last:border-b-0 hover:bg-[#faf9f6]">
                    <td className={td}>
                      <Link href={`/admin/sessions/${h.sessionId}?tab=holds` as Route} className="grid leading-tight hover:underline">
                        <span className="font-medium text-foreground">{show(h.sessionTitle, locale)}</span>
                        <span className="text-[0.75rem] text-muted-foreground tabular-nums">
                          {formatDate(h.startsAt, locale)} · {brusselsTime(h.startsAt)}
                        </span>
                      </Link>
                    </td>
                    <td className={td}>
                      <StatusPill tone={KIND_TONE[h.kind]}>{tr(`booking.holdKind.${h.kind}`)}</StatusPill>
                    </td>
                    <td className={cn(td, "text-right font-semibold tabular-nums")}>
                      {h.used}
                      <span className="font-normal text-muted-foreground">/{h.quantity}</span>
                    </td>
                    <td className={td}>{h.companyName ?? <span className="text-muted-foreground">–</span>}</td>
                    <td className={cn(td, "text-muted-foreground")}>{h.note ?? "–"}</td>
                    <td className={cn(td, "text-right")}>{canWrite ? <DeleteHoldButton id={h.id} label={tr("booking.common.delete")} errors={errors} /> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Surface>
      )}
      {canWrite ? (
        <Surface className="grid gap-3" aria-labelledby="add-hold">
          <h2 id="add-hold" className="text-[0.9375rem] font-semibold">
            {tr("booking.holds.add")}
          </h2>
          <HoldForm
            initial={{ sessionId: sessions[0]?.id ?? "", kind: "staff", quantity: 1, companyId: "", note: "" }}
            sessions={sessions.map((s) => ({ id: s.id, label: sessionLabel(s) }))}
            companies={companies.map((c) => ({ id: c.id, label: c.name }))}
            labels={{
              session: tr("booking.holds.session"),
              kind: tr("booking.holds.kind"),
              kinds: Object.fromEntries(KINDS.map((k) => [k, tr(`booking.holdKind.${k}`)])) as Record<(typeof KINDS)[number], string>,
              quantity: tr("booking.holds.quantity"),
              company: tr("booking.holds.company"),
              none: "—",
              note: tr("booking.holds.note"),
              noteHint: tr("booking.common.no_health_notes"),
              save: tr("booking.common.save"),
              saving: tr("platform.settings.saving"),
              saved: tr("booking.common.saved"),
              errors,
            }}
          />
        </Surface>
      ) : null}
      {seatHolds.length > 0 ? (
        <section aria-labelledby="hold-seats" className="grid gap-3">
          <header className="grid gap-0.5">
            <h2 id="hold-seats" className="text-[0.9375rem] font-semibold">
              {tr("booking.holds.seats_title")}
            </h2>
            <p className="max-w-2xl text-[0.8125rem] text-muted-foreground">{tr("booking.holds.seats_intro")}</p>
          </header>
          <HoldSeats holds={seatHolds} canAssign={canWrite} tr={tr} sessionLabel={sessionLabel} />
        </section>
      ) : null}
    </div>
  );
}

/** The outcome of the last assign or unassign, announced to screen readers. */
function statusLine(sp: Search, tr: (key: string, params?: Record<string, string | number>) => string) {
  const ok = "rounded-lg bg-[var(--status-ok-soft)] px-3 py-2 text-[0.8125rem] font-medium text-[var(--status-ok)]";
  if (sp.assigned)
    return (
      <p role="status" className={ok}>
        {tr("booking.holds.assigned")}
      </p>
    );
  if (sp.unassigned)
    return (
      <p role="status" className={ok}>
        {tr("booking.holds.unassigned")}
      </p>
    );
  if (!sp.error) return null;
  const reason = sp.error;
  const text = (BOOKING_CONFLICT_REASONS as readonly string[]).includes(reason)
    ? tr(`booking.errors.${reason}`)
    : reason === "not_found"
      ? tr("booking.holds.not_found")
      : reason === "validation"
        ? tr("booking.errors.validation")
        : reason === "forbidden"
          ? tr("platform.errors.forbidden")
          : tr("booking.errors.generic");
  return (
    <p role="alert" className="rounded-lg bg-[var(--status-bad-soft)] px-3 py-2 text-[0.8125rem] font-medium text-[var(--status-bad)]">
      {text}
    </p>
  );
}

/** R3: one surface per hold with its counts, the names on it and the form to add one. */
function HoldSeats({
  holds,
  canAssign,
  tr,
  sessionLabel,
}: {
  holds: PartnerHoldRow[];
  canAssign: boolean;
  tr: (key: string, params?: Record<string, string | number>) => string;
  sessionLabel: (s: { title: LocalizedText; startsAt: Date }) => string;
}) {
  return (
    <ul className="grid gap-3">
      {holds.map((h) => {
        const left = Math.max(0, h.quantity - h.used);
        const locked = h.isStarted || h.isCancelled;
        const titleId = `hold-${h.id}`;
        return (
          <li key={h.id} aria-labelledby={titleId} className="grid gap-2.5 rounded-xl border border-border bg-card p-4">
            <div className="flex flex-wrap items-center gap-2">
              <h3 id={titleId} className="text-[0.875rem] font-semibold">
                {sessionLabel({ title: h.sessionTitle, startsAt: h.startsAt })}
              </h3>
              <StatusPill tone={KIND_TONE[h.kind]}>{tr(`booking.holdKind.${h.kind}`)}</StatusPill>
              {h.companyName ? <span className="text-[0.8125rem] text-muted-foreground">{h.companyName}</span> : null}
              <span className="ml-auto text-[0.8125rem] tabular-nums">
                <b className="font-semibold">{h.used}</b>
                <span className="text-muted-foreground">
                  /{h.quantity} · {tr("booking.holds.seats_left", { count: left })}
                </span>
              </span>
            </div>
            {h.note ? <p className="text-[0.8125rem] text-muted-foreground">{h.note}</p> : null}
            {h.seats.length === 0 ? (
              <p className="text-[0.8125rem] text-muted-foreground">{tr("booking.holds.seats_none")}</p>
            ) : (
              <ul className="grid">
                {h.seats.map((s) => (
                  <li key={s.bookingId} className="flex min-h-10 flex-wrap items-center gap-3 border-b border-border py-1 last:border-b-0">
                    <span className="font-medium">{[s.firstName, s.lastName].filter(Boolean).join(" ")}</span>
                    <span className="text-[0.75rem] text-muted-foreground">{tr(`booking.status.${s.status}`)}</span>
                    {canAssign && !locked ? (
                      <form action={unassign} className="ml-auto">
                        <input type="hidden" name="bookingId" value={s.bookingId} />
                        <button type="submit" className={button}>
                          {tr("booking.holds.unassign")}
                        </button>
                      </form>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {h.isCancelled ? (
              <p className="text-[0.8125rem] text-muted-foreground">{tr("booking.holds.seats_cancelled")}</p>
            ) : h.isStarted ? (
              <p className="text-[0.8125rem] text-muted-foreground">{tr("booking.holds.seats_started")}</p>
            ) : left === 0 ? (
              <p className="text-[0.8125rem] text-muted-foreground">{tr("booking.holds.seats_full")}</p>
            ) : canAssign ? (
              <form action={assign} className="flex flex-wrap items-end gap-2 border-t border-border pt-3">
                <input type="hidden" name="holdId" value={h.id} />
                <label className="grid gap-1 text-[0.75rem] font-medium text-muted-foreground">
                  {tr("booking.holds.first_name")}
                  <input name="firstName" required maxLength={100} autoComplete="off" className={input} />
                </label>
                <label className="grid gap-1 text-[0.75rem] font-medium text-muted-foreground">
                  {tr("booking.holds.last_name")}
                  <input name="lastName" required maxLength={100} autoComplete="off" className={input} />
                </label>
                <label className="grid gap-1 text-[0.75rem] font-medium text-muted-foreground">
                  {tr("booking.holds.email")}
                  <input name="email" type="email" maxLength={254} autoComplete="off" aria-describedby={`${titleId}-email-hint`} className={input} />
                </label>
                <button type="submit" className={button}>
                  {tr("booking.holds.assign")}
                </button>
                <p id={`${titleId}-email-hint`} className="w-full text-[0.75rem] text-muted-foreground">
                  {tr("booking.holds.email_hint")}
                </p>
              </form>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
