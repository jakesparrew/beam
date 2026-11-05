import type { Route } from "next";
import { notFound, redirect } from "next/navigation";
import { Badge } from "@beam/ui";
import { BOOKING_CONFLICT_REASONS, brusselsTime } from "@beam/core/booking";
import { ForbiddenError } from "@beam/core/errors";
import { formatDate, type Locale, type LocalizedText } from "@beam/core/i18n";
import { hasPermission, requireStaff } from "@/lib/auth";
import { createCtx, getAppDb, type Tx } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { assignHoldSeat, unassignHoldSeat } from "@/modules/booking/actions";
import { listCompanyOptions, listHoldableSessions, listHolds, listMyPartnerHolds, type PartnerHoldRow } from "@/modules/booking/queries";
import { DeleteHoldButton, HoldForm } from "@/modules/booking/ui/hold-form";
import { partnerScope } from "@/modules/platform/api";

const show = (text: LocalizedText | null | undefined, locale: Locale) => text?.[locale] || text?.["nl-BE"] || text?.en || text?.["fr-BE"] || "";
const KINDS = ["staff", "partner", "host", "speaker", "blocked"] as const;
const HERE = "/admin/sessions/holds";
const input = "h-11 rounded-md border border-input bg-background px-3 text-sm";
const button = "inline-flex h-11 items-center rounded-md border px-4 text-sm font-medium hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2";

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
 * `/admin/sessions/holds` (booking spec 5.1, R11; R3 booking-P9). Staff (`bookings.read`; changes
 * need `bookings.write`): holds across sessions that have not ended (session, kind, places, used,
 * company, note), the add form and the names on held places. Partner mode (`partner.own`: an
 * `external_partner`, or a user with `partner.own` but without `bookings.read`): only the holds
 * of their own company from platform's `partnerScope`, with counts and the names they entered,
 * never another attendee and never the staff note; they add and remove names, nothing else.
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
      <div className="grid gap-6">
        <header className="grid gap-2">
          <h1 className="text-2xl font-semibold">{tr("booking.holds.partner_title")}</h1>
          <p className="max-w-prose text-muted-foreground">{tr("booking.holds.partner_intro")}</p>
        </header>
        {status}
        {seatHolds.length === 0 ? (
          <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">{tr("booking.holds.empty")}</p>
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
    <div className="grid gap-8">
      <h1 className="text-2xl font-semibold">{tr("booking.holds.title")}</h1>
      {status}
      {holds.length === 0 ? (
        <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">{tr("booking.holds.empty")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left">
                <th className="py-2 pr-3">{tr("booking.holds.session")}</th>
                <th className="py-2 pr-3">{tr("booking.holds.kind")}</th>
                <th className="py-2 pr-3">{tr("booking.holds.quantity")}</th>
                <th className="py-2 pr-3">{tr("booking.holds.used")}</th>
                <th className="py-2 pr-3">{tr("booking.holds.company")}</th>
                <th className="py-2 pr-3">{tr("booking.holds.note")}</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {holds.map((h) => (
                <tr key={h.id} className="border-b align-top">
                  <td className="py-2 pr-3">{sessionLabel({ title: h.sessionTitle, startsAt: h.startsAt })}</td>
                  <td className="py-2 pr-3">
                    <Badge variant="outline">{tr(`booking.holdKind.${h.kind}`)}</Badge>
                  </td>
                  <td className="py-2 pr-3 tabular-nums">{h.quantity}</td>
                  <td className="py-2 pr-3 tabular-nums">{h.used}</td>
                  <td className="py-2 pr-3">{h.companyName ?? "—"}</td>
                  <td className="py-2 pr-3">{h.note ?? ""}</td>
                  <td className="py-2">{canWrite ? <DeleteHoldButton id={h.id} label={tr("booking.common.delete")} errors={errors} /> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {seatHolds.length > 0 ? (
        <section aria-labelledby="hold-seats" className="grid gap-4">
          <header className="grid gap-1">
            <h2 id="hold-seats" className="text-xl font-semibold">
              {tr("booking.holds.seats_title")}
            </h2>
            <p className="max-w-prose text-sm text-muted-foreground">{tr("booking.holds.seats_intro")}</p>
          </header>
          <HoldSeats holds={seatHolds} canAssign={canWrite} tr={tr} sessionLabel={sessionLabel} />
        </section>
      ) : null}
      {canWrite ? (
        <section aria-labelledby="add-hold" className="grid max-w-3xl gap-4">
          <h2 id="add-hold" className="text-xl font-semibold">
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
              saved: tr("booking.common.save"),
              errors,
            }}
          />
        </section>
      ) : null}
    </div>
  );
}

/** The outcome of the last assign or unassign, announced to screen readers. */
function statusLine(sp: Search, tr: (key: string, params?: Record<string, string | number>) => string) {
  if (sp.assigned) return <p role="status" className="rounded-md border p-3 text-sm">{tr("booking.holds.assigned")}</p>;
  if (sp.unassigned) return <p role="status" className="rounded-md border p-3 text-sm">{tr("booking.holds.unassigned")}</p>;
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
    <p role="alert" className="rounded-md border border-destructive p-3 text-sm text-destructive">
      {text}
    </p>
  );
}

/** R3: one card per hold with its counts, the names on it and the form to add one. */
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
    <ul className="grid gap-4">
      {holds.map((h) => {
        const left = Math.max(0, h.quantity - h.used);
        const locked = h.isStarted || h.isCancelled;
        const titleId = `hold-${h.id}`;
        return (
          <li key={h.id} aria-labelledby={titleId} className="grid gap-3 rounded-md border p-4">
            <div className="flex flex-wrap items-center gap-2">
              <h3 id={titleId} className="font-medium">
                {sessionLabel({ title: h.sessionTitle, startsAt: h.startsAt })}
              </h3>
              <Badge variant="outline">{tr(`booking.holdKind.${h.kind}`)}</Badge>
              {h.companyName ? <span className="text-sm text-muted-foreground">{h.companyName}</span> : null}
            </div>
            <p className="text-sm tabular-nums">
              {tr("booking.holds.used")}: {h.used} / {h.quantity} · {tr("booking.holds.seats_left", { count: left })}
            </p>
            {h.note ? <p className="text-sm text-muted-foreground">{h.note}</p> : null}
            {h.seats.length === 0 ? (
              <p className="text-sm text-muted-foreground">{tr("booking.holds.seats_none")}</p>
            ) : (
              <ul className="grid gap-1">
                {h.seats.map((s) => (
                  <li key={s.bookingId} className="flex flex-wrap items-center gap-3">
                    <span>{[s.firstName, s.lastName].filter(Boolean).join(" ")}</span>
                    <span className="text-sm text-muted-foreground">{tr(`booking.status.${s.status}`)}</span>
                    {canAssign && !locked ? (
                      <form action={unassign}>
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
              <p className="text-sm text-muted-foreground">{tr("booking.holds.seats_cancelled")}</p>
            ) : h.isStarted ? (
              <p className="text-sm text-muted-foreground">{tr("booking.holds.seats_started")}</p>
            ) : left === 0 ? (
              <p className="text-sm text-muted-foreground">{tr("booking.holds.seats_full")}</p>
            ) : canAssign ? (
              <form action={assign} className="flex flex-wrap items-end gap-3">
                <input type="hidden" name="holdId" value={h.id} />
                <label className="grid gap-1 text-sm">
                  {tr("booking.holds.first_name")}
                  <input name="firstName" required maxLength={100} autoComplete="off" className={input} />
                </label>
                <label className="grid gap-1 text-sm">
                  {tr("booking.holds.last_name")}
                  <input name="lastName" required maxLength={100} autoComplete="off" className={input} />
                </label>
                <label className="grid gap-1 text-sm">
                  {tr("booking.holds.email")}
                  <input name="email" type="email" maxLength={254} autoComplete="off" aria-describedby={`${titleId}-email-hint`} className={input} />
                </label>
                <button type="submit" className={button}>
                  {tr("booking.holds.assign")}
                </button>
                <p id={`${titleId}-email-hint`} className="w-full text-xs text-muted-foreground">
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
