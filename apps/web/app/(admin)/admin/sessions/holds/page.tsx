import { Badge } from "@beam/ui";
import { BOOKING_CONFLICT_REASONS, brusselsTime } from "@beam/core/booking";
import { formatDate, type Locale, type LocalizedText } from "@beam/core/i18n";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { listCompanyOptions, listHoldableSessions, listHolds } from "@/modules/booking/queries";
import { DeleteHoldButton, HoldForm } from "@/modules/booking/ui/hold-form";

const show = (text: LocalizedText | null | undefined, locale: Locale) => text?.[locale] || text?.["nl-BE"] || text?.en || text?.["fr-BE"] || "";
const KINDS = ["staff", "partner", "host", "speaker", "blocked"] as const;

/**
 * `/admin/sessions/holds` (`bookings.read`; changes need `bookings.write`, booking spec 5.1, R11):
 * holds across sessions that have not ended (session, kind, places, used, company, note) and the
 * add form. Partner self-service (`partner.own`) is R3 (booking-P9).
 */
export default async function HoldsPage() {
  const actor = await requireStaff({ permission: "bookings.read" });
  const canWrite = hasPermission(actor, "bookings.write");
  const locale = await adminLocale();
  const tr = translator(locale);
  const db = await getAppDb();
  const [holds, sessions, companies] = await Promise.all([listHolds(db), canWrite ? listHoldableSessions(db) : Promise.resolve([]), canWrite ? listCompanyOptions(db) : Promise.resolve([])]);
  const errors = {
    ...Object.fromEntries(BOOKING_CONFLICT_REASONS.map((r) => [r, tr(`booking.errors.${r}`)])),
    capacity_below_bookings: tr("booking.holds.below_bookings"),
    validation: tr("platform.errors.validation"),
    forbidden: tr("platform.errors.forbidden"),
    not_found: tr("platform.errors.not_found"),
  };
  const sessionLabel = (s: { title: LocalizedText; startsAt: Date }) => `${formatDate(s.startsAt, locale)} ${brusselsTime(s.startsAt)} · ${show(s.title, locale)}`;

  return (
    <div className="grid gap-8">
      <h1 className="text-2xl font-semibold">{tr("booking.holds.title")}</h1>
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
