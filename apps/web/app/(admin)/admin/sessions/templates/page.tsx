import Link from "next/link";
import type { Route } from "next";
import { Badge } from "@beam/ui";
import { BOOKING_CONFLICT_REASONS, brusselsDate } from "@beam/core/booking";
import { formatDate, type Locale, type LocalizedText } from "@beam/core/i18n";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { listProductOptions, listTemplates } from "@/modules/booking/queries";
import { TemplateActiveToggle, TemplateForm, type TemplateFormLabels } from "@/modules/booking/ui/template-form";

const show = (text: LocalizedText | null | undefined, locale: Locale) => text?.[locale] || text?.["nl-BE"] || text?.en || text?.["fr-BE"] || "";
const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

/** The template form labels (shared with `/admin/sessions/templates/[id]` by copy). */
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
 * `/admin/sessions/templates` (`settings.write`, booking spec 5.1): the schedule table (kind,
 * name, weekdays, time, duration, capacity, credits, product, member-only, validity, active)
 * and "Add schedule", which creates one template per start time.
 */
export default async function TemplatesPage() {
  await requireStaff({ permission: "settings.write" });
  const locale = await adminLocale();
  const tr = translator(locale);
  const db = await getAppDb();
  const [templates, products] = await Promise.all([listTemplates(db), listProductOptions(db)]);
  const productName = new Map(products.map((p) => [p.id, show(p.name, locale)]));
  const labels = templateLabels(tr);
  const toggle = { activate: tr("booking.templates.activate"), deactivate: tr("booking.templates.deactivate"), incomplete: tr("booking.templates.incomplete_name"), error: tr("platform.errors.conflict") };

  return (
    <div className="grid gap-8">
      <h1 className="text-2xl font-semibold">{tr("booking.templates.title")}</h1>
      {templates.length === 0 ? (
        <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">{tr("booking.templates.empty")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left">
                <th className="py-2 pr-3">{tr("booking.templates.kind")}</th>
                <th className="py-2 pr-3">{tr("booking.templates.name")}</th>
                <th className="py-2 pr-3">{tr("booking.templates.weekdays")}</th>
                <th className="py-2 pr-3">{tr("booking.templates.start_time")}</th>
                <th className="py-2 pr-3">{tr("booking.templates.duration")}</th>
                <th className="py-2 pr-3">{tr("booking.session.capacity")}</th>
                <th className="py-2 pr-3">{tr("booking.templates.credit_cost")}</th>
                <th className="py-2 pr-3">{tr("booking.templates.product")}</th>
                <th className="py-2 pr-3">{tr("booking.templates.active_from")}</th>
                <th className="py-2 pr-3">{tr("booking.templates.active")}</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {templates.map((t) => (
                <tr key={t.id} className="border-b align-top">
                  <td className="py-2 pr-3">{tr(`booking.kind.${t.kind}`)}</td>
                  <td className="py-2 pr-3">
                    <Link href={`/admin/sessions/templates/${t.id}` as Route} className="font-medium hover:underline">
                      {show(t.name as LocalizedText, locale)}
                    </Link>
                    {t.isMemberOnly ? <Badge variant="outline" className="ml-2">{tr("booking.templates.member_only")}</Badge> : null}
                    {t.location ? <span className="block text-xs text-muted-foreground">{t.location}</span> : null}
                  </td>
                  <td className="py-2 pr-3">{t.weekdays.map((d) => tr(`booking.weekday.${WEEKDAYS[d - 1]}`).slice(0, 2)).join(" ")}</td>
                  <td className="py-2 pr-3 tabular-nums">{t.startTime.slice(0, 5)}</td>
                  <td className="py-2 pr-3 tabular-nums">{t.durationMinutes}</td>
                  <td className="py-2 pr-3">{t.kind === "night" ? tr("booking.common.beds", { count: t.capacityBeds ?? 0 }) : tr("booking.common.places", { count: t.capacitySeats ?? 0 })}</td>
                  <td className="py-2 pr-3">{t.creditKind ? `${t.creditCost} × ${tr(`booking.kind.${t.creditKind}`)}` : "—"}</td>
                  <td className="py-2 pr-3">{t.productId ? (productName.get(t.productId) ?? "—") : "—"}</td>
                  <td className="py-2 pr-3">
                    {formatDate(t.activeFromOn, locale)}
                    {t.activeToOn ? ` – ${formatDate(t.activeToOn, locale)}` : ""}
                  </td>
                  <td className="py-2 pr-3">{t.isActive ? <Badge variant="success">{tr("booking.templates.active")}</Badge> : <Badge variant="outline">{tr("booking.session.draft")}</Badge>}</td>
                  <td className="py-2">
                    <TemplateActiveToggle id={t.id} isActive={t.isActive} labels={toggle} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <section className="grid max-w-4xl gap-4" aria-labelledby="add-schedule">
        <h2 id="add-schedule" className="text-xl font-semibold">
          {tr("booking.templates.add")}
        </h2>
        <TemplateForm
          initial={{
            kind: "day",
            name: {},
            description: {},
            weekdays: [2, 3, 4, 5, 6, 7],
            startTimes: ["09:00", "11:30", "14:00", "16:30"],
            durationMinutes: 120,
            capacity: 12,
            creditKind: "day",
            creditCost: 1,
            productId: "",
            isMemberOnly: false,
            location: "",
            activeFromOn: brusselsDate(new Date()),
            activeToOn: "",
          }}
          products={products.map((p) => ({ id: p.id, label: `${show(p.name, locale)} (${p.sku})` }))}
          labels={labels}
        />
      </section>
    </div>
  );
}
