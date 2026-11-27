import Link from "next/link";
import type { Route } from "next";
import { cn, EmptyState } from "@beam/ui";
import { BOOKING_CONFLICT_REASONS, brusselsDate } from "@beam/core/booking";
import { formatDate, type Locale, type LocalizedText } from "@beam/core/i18n";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { listProductOptions, listTemplates } from "@/modules/booking/queries";
import { TemplateActiveToggle, TemplateForm, type TemplateFormLabels } from "@/modules/booking/ui/template-form";
import { PageHeader, StatusPill, stepFormLabels, Surface, td, th } from "@/modules/platform/ui/admin-kit";
import { aboveRow, rowClass, rowLink } from "@/modules/platform/ui/admin-list-kit";

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
    stepKind: tr("booking.session.step_kind"),
    stepContent: tr("booking.session.step_content"),
    stepSchedule: tr("booking.templates.step_schedule"),
    stepAccess: tr("booking.session.step_access"),
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
    <div className="grid gap-4">
      <PageHeader title={tr("booking.templates.title")} description={tr("booking.templates.subtitle")} />
      {templates.length === 0 ? (
        <EmptyState title={tr("booking.templates.empty")} />
      ) : (
        <Surface flush>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[64rem] text-[0.8125rem]">
              <caption className="sr-only">{tr("booking.templates.title")}</caption>
              <thead className="bg-[#faf9f6]">
                <tr className="border-b border-border">
                  <th scope="col" className={th}>{tr("booking.templates.name")}</th>
                  <th scope="col" className={cn(th, "w-36")}>{tr("booking.templates.weekdays")}</th>
                  <th scope="col" className={cn(th, "w-20 text-right")}>{tr("booking.templates.start_time")}</th>
                  <th scope="col" className={cn(th, "w-20 text-right")}>{tr("booking.templates.duration")}</th>
                  <th scope="col" className={cn(th, "w-28 text-right")}>{tr("booking.session.capacity")}</th>
                  <th scope="col" className={cn(th, "w-32")}>{tr("booking.templates.credit_cost")}</th>
                  <th scope="col" className={cn(th, "w-40")}>{tr("booking.templates.product")}</th>
                  <th scope="col" className={cn(th, "w-44")}>{tr("booking.templates.active_from")}</th>
                  <th scope="col" className={cn(th, "w-40")}>{tr("booking.templates.active")}</th>
                </tr>
              </thead>
              <tbody>
                {templates.map((t) => (
                  <tr key={t.id} className={rowClass}>
                    <td className={td}>
                      <span className="grid leading-tight">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <Link href={`/admin/sessions/templates/${t.id}` as Route} className={cn(rowLink, "font-semibold hover:underline")}>
                            {show(t.name as LocalizedText, locale)}
                          </Link>
                          {t.isMemberOnly ? <StatusPill tone="info">{tr("booking.templates.member_only")}</StatusPill> : null}
                        </span>
                        <span className="text-[0.75rem] text-muted-foreground">
                          {tr(`booking.kind.${t.kind}`)}
                          {t.location ? ` · ${t.location}` : ""}
                        </span>
                      </span>
                    </td>
                    <td className={td}>{t.weekdays.map((d) => tr(`booking.weekday.${WEEKDAYS[d - 1]}`).slice(0, 2)).join(" ")}</td>
                    <td className={cn(td, "text-right font-semibold tabular-nums")}>{t.startTime.slice(0, 5)}</td>
                    <td className={cn(td, "text-right tabular-nums")}>{t.durationMinutes}</td>
                    <td className={cn(td, "text-right tabular-nums")}>{t.kind === "night" ? tr("booking.common.beds", { count: t.capacityBeds ?? 0 }) : tr("booking.common.places", { count: t.capacitySeats ?? 0 })}</td>
                    <td className={td}>{t.creditKind ? `${t.creditCost} × ${tr(`booking.kind.${t.creditKind}`)}` : "–"}</td>
                    <td className={cn(td, "text-muted-foreground")}>{t.productId ? (productName.get(t.productId) ?? "–") : "–"}</td>
                    <td className={cn(td, "whitespace-nowrap")}>
                      {formatDate(t.activeFromOn, locale)}
                      {t.activeToOn ? ` – ${formatDate(t.activeToOn, locale)}` : ""}
                    </td>
                    <td className={td}>
                      <span className={cn(aboveRow, "flex items-center gap-2")}>
                        <StatusPill tone={t.isActive ? "ok" : "muted"}>{t.isActive ? tr("booking.templates.active") : tr("booking.session.draft")}</StatusPill>
                        <TemplateActiveToggle id={t.id} isActive={t.isActive} labels={toggle} />
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Surface>
      )}
      <Surface className="grid gap-4" aria-labelledby="add-schedule">
        <h2 id="add-schedule" className="text-[0.9375rem] font-semibold">
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
          labels={{ ...labels, steps: stepFormLabels(tr) }}
        />
      </Surface>
    </div>
  );
}
