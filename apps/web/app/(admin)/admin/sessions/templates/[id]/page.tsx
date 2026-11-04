import Link from "next/link";
import type { Route } from "next";
import { notFound } from "next/navigation";
import { Alert, AlertDescription } from "@beam/ui";
import { BOOKING_CONFLICT_REASONS, brusselsTime } from "@beam/core/booking";
import { formatDate, formatDateTime, type Locale, type LocalizedText } from "@beam/core/i18n";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { getRegenerationStatus, getTemplate, listProductOptions } from "@/modules/booking/queries";
import { TemplateActiveToggle, TemplateForm, type TemplateFormLabels } from "@/modules/booking/ui/template-form";

const show = (text: LocalizedText | null | undefined, locale: Locale) => text?.[locale] || text?.["nl-BE"] || text?.en || text?.["fr-BE"] || "";
const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function templateLabels(tr: (key: string, params?: Record<string, string | number>) => string): TemplateFormLabels {
  const localeNames = { "nl-BE": tr("platform.shell.locale_nl"), "fr-BE": tr("platform.shell.locale_fr"), en: tr("platform.shell.locale_en") };
  const localized = (field: string) => ({ field, locales: localeNames, missing: tr("platform.settings.locale_missing"), complete: tr("platform.settings.locale_complete") });
  return {
    kind: tr("booking.templates.kind"),
    kinds: { day: tr("booking.kind.day"), night: tr("booking.kind.night"), event: tr("booking.kind.event") },
    name: localized(tr("booking.templates.name")),
    description: localized(tr("booking.templates.description")),
    weekdays: tr("booking.templates.weekdays"),
    weekdayNames: WEEKDAYS.map((d) => tr(`booking.weekday.${d}`)),
    startTimes: tr("booking.templates.start_times"),
    startTime: tr("booking.templates.start_time"),
    duration: tr("booking.templates.duration"),
    seats: tr("booking.templates.capacity_seats"),
    beds: tr("booking.templates.capacity_beds"),
    creditKind: tr("booking.templates.credit_kind"),
    creditCost: tr("booking.templates.credit_cost"),
    product: tr("booking.templates.product"),
    none: "—",
    memberOnly: tr("booking.templates.member_only"),
    location: tr("booking.templates.location"),
    activeFrom: tr("booking.templates.active_from"),
    activeTo: tr("booking.templates.active_to"),
    save: tr("booking.common.save"),
    saving: tr("platform.settings.saving"),
    saved: tr("booking.templates.regeneration_running"),
    incompleteName: tr("booking.templates.incomplete_name"),
    warningOverlap: tr("booking.session.warning_location_overlap"),
    warningHours: tr("booking.session.warning_outside_business_hours"),
    errors: {
      ...Object.fromEntries(BOOKING_CONFLICT_REASONS.map((r) => [r, tr(`booking.errors.${r}`)])),
      validation: tr("platform.errors.validation"),
      forbidden: tr("platform.errors.forbidden"),
      not_found: tr("platform.errors.not_found"),
    },
  };
}

/**
 * `/admin/sessions/templates/[id]` (`settings.write`, booking spec 5.1, R2, edge case 4): the edit
 * form, the next 14 days it plans, the future sessions kept because they are booked, held,
 * waited on or edited, and the status of the regeneration job of the current version.
 */
export default async function TemplatePage({ params }: { params: Promise<{ id: string }> }) {
  await requireStaff({ permission: "settings.write" });
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const locale = await adminLocale();
  const tr = translator(locale);
  const db = await getAppDb();
  const found = await getTemplate(db, id);
  if (!found) notFound();
  const { template: t, preview, kept } = found;
  const [products, job] = await Promise.all([listProductOptions(db), getRegenerationStatus(db, t)]);
  const labels = templateLabels(tr);

  return (
    <div className="grid gap-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">
          {show(t.name, locale)} · {t.startTime.slice(0, 5)}
        </h1>
        <div className="flex flex-wrap items-center gap-2">
          <TemplateActiveToggle
            id={t.id}
            isActive={t.isActive}
            labels={{ activate: tr("booking.templates.activate"), deactivate: tr("booking.templates.deactivate"), incomplete: tr("booking.templates.incomplete_name"), error: tr("platform.errors.conflict") }}
          />
          <Link href="/admin/sessions/templates" className="text-sm underline">
            {tr("booking.common.back")}
          </Link>
        </div>
      </div>
      {job && (job.status === "pending" || job.status === "running") ? (
        <Alert role="status">
          <AlertDescription>{tr("booking.templates.regeneration_running")}</AlertDescription>
        </Alert>
      ) : null}
      {job && (job.status === "failed" || job.status === "dead") ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>
            {tr("booking.templates.regeneration_failed")}{" "}
            <Link href={`/admin/system/jobs/${job.jobId}` as Route} className="underline">
              {tr("booking.common.retry")}
            </Link>
          </AlertDescription>
        </Alert>
      ) : null}
      <section className="grid max-w-4xl gap-4">
        <TemplateForm
          initial={{
            id: t.id,
            version: t.version,
            kind: t.kind,
            name: (t.name ?? {}),
            description: (t.description ?? {}),
            weekdays: t.weekdays,
            startTimes: [t.startTime.slice(0, 5)],
            durationMinutes: t.durationMinutes,
            capacity: t.kind === "night" ? t.capacityBeds : t.capacitySeats,
            creditKind: t.creditKind ?? "",
            creditCost: t.creditCost,
            productId: t.productId ?? "",
            isMemberOnly: t.isMemberOnly,
            location: t.location ?? "",
            activeFromOn: t.activeFromOn,
            activeToOn: t.activeToOn ?? "",
          }}
          products={products.map((p) => ({ id: p.id, label: `${show(p.name, locale)} (${p.sku})` }))}
          labels={labels}
        />
      </section>
      <div className="grid gap-6 md:grid-cols-2">
        <section aria-labelledby="preview" className="grid content-start gap-2">
          <h2 id="preview" className="text-lg font-semibold">
            {tr("booking.templates.preview")}
          </h2>
          <ul className="grid gap-1 text-sm">
            {preview.map((p) => (
              <li key={p.startsAt.toISOString()}>
                {formatDate(p.startsAt, locale, "full")} · {brusselsTime(p.startsAt)}–{brusselsTime(p.endsAt)}
              </li>
            ))}
          </ul>
        </section>
        <section aria-labelledby="kept" className="grid content-start gap-2">
          <h2 id="kept" className="text-lg font-semibold">
            {tr("booking.templates.kept_because_booked")}
          </h2>
          <ul className="grid gap-1 text-sm">
            {kept.map((k) => (
              <li key={k.sessionId}>
                {formatDateTime(k.startsAt, locale, "full")} · {tr("booking.day.attendees", { count: k.bookings })}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
