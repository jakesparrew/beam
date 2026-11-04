import { BOOKING_CONFLICT_REASONS } from "@beam/core/booking";
import type { Locale, LocalizedText } from "@beam/core/i18n";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { listCompanyOptions, listProductOptions } from "@/modules/booking/queries";
import { SessionForm, type SessionFormLabels } from "@/modules/booking/ui/template-form";

const show = (text: LocalizedText | null | undefined, locale: Locale) => text?.[locale] || text?.["nl-BE"] || text?.en || text?.["fr-BE"] || "";
const CATEGORIES = ["lecture", "concert", "member_event", "experience", "webinar", "special_activity", "partner_event"] as const;

/**
 * `/admin/sessions/new` (`bookings.override`, booking spec 5.1, R5, R50): a one-off session or an
 * event, created as a draft or published at once; publishing stays disabled while the title
 * misses a locale.
 */
export default async function NewSessionPage() {
  await requireStaff({ permission: "bookings.override" });
  const locale = await adminLocale();
  const tr = translator(locale);
  const db = await getAppDb();
  const [products, companies] = await Promise.all([listProductOptions(db), listCompanyOptions(db)]);
  const localeNames = { "nl-BE": tr("platform.shell.locale_nl"), "fr-BE": tr("platform.shell.locale_fr"), en: tr("platform.shell.locale_en") };
  const localized = (field: string) => ({ field, locales: localeNames, missing: tr("platform.settings.locale_missing"), complete: tr("platform.settings.locale_complete") });

  const labels: SessionFormLabels = {
    kind: tr("booking.templates.kind"),
    kinds: { day: tr("booking.kind.day"), night: tr("booking.kind.night"), event: tr("booking.kind.event") },
    title: localized(tr("booking.templates.name")),
    description: localized(tr("booking.templates.description")),
    startsAt: `${tr("booking.exceptions.date")} · ${tr("booking.print.time")}`,
    duration: tr("booking.templates.duration"),
    seats: tr("booking.templates.capacity_seats"),
    beds: tr("booking.templates.capacity_beds"),
    creditKind: tr("booking.templates.credit_kind"),
    creditCost: tr("booking.templates.credit_cost"),
    product: tr("booking.templates.product"),
    none: "—",
    memberOnly: tr("booking.templates.member_only"),
    location: tr("booking.templates.location"),
    eventCategory: tr("booking.session.event_category"),
    eventCategories: Object.fromEntries(CATEGORIES.map((c) => [c, tr(`booking.eventCategory.${c}`)])) as SessionFormLabels["eventCategories"],
    company: tr("booking.holds.company"),
    save: tr("booking.common.save"),
    saving: tr("platform.settings.saving"),
    createDraft: `${tr("booking.common.save")} · ${tr("booking.session.draft")}`,
    createPublish: tr("booking.session.publish"),
    missingLocales: tr("booking.session.publish_missing_locales", { locales: "{locales}" }),
    localeNames,
    warningOverlap: tr("booking.session.warning_location_overlap"),
    errors: {
      ...Object.fromEntries(BOOKING_CONFLICT_REASONS.map((r) => [r, tr(`booking.errors.${r}`)])),
      validation: tr("platform.errors.validation"),
      forbidden: tr("platform.errors.forbidden"),
      not_found: tr("platform.errors.not_found"),
    },
  };

  return (
    <div className="grid max-w-4xl gap-6">
      <h1 className="text-2xl font-semibold">{tr("booking.calendar.new_session")}</h1>
      <SessionForm
        products={products.map((p) => ({ id: p.id, label: `${show(p.name, locale)} (${p.sku})` }))}
        companies={companies.map((c) => ({ id: c.id, label: c.name }))}
        labels={labels}
      />
    </div>
  );
}
