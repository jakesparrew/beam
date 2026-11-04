import { notFound } from "next/navigation";
import { MARKETING_PURPOSES } from "@beam/core/crm";
import { localeFromSegment } from "@beam/core/i18n";
import { requireCustomer } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { translator } from "@/lib/i18n";
import { getMyPreferences } from "@/modules/crm/queries";
import { PreferenceSwitches, type PreferenceSwitchesLabels } from "@/modules/crm/ui/preference-switches";

/**
 * `/[locale]/account/preferences` (crm spec 5.2): one switch per marketing purpose with the
 * published wording of each, the note that booking and payment emails always arrive, and
 * "Unsubscribe from all marketing". A suppressed address shows disabled switches. The language
 * of emails is the profile's language (`/account/profile`).
 */
export default async function AccountPreferencesPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: segment } = await params;
  const locale = localeFromSegment(segment);
  if (!locale) notFound();
  const actor = await requireCustomer(locale);
  const tr = translator(locale);
  const prefs = await getMyPreferences(await getAppDb(), actor.personId);
  if (!prefs) notFound();
  const labels: PreferenceSwitchesLabels = {
    on: tr("crm.common.switch_on"),
    off: tr("crm.common.switch_off"),
    save: tr("crm.portal.preferences.save"),
    saving: tr("crm.common.saving"),
    saved: tr("crm.portal.preferences.saved"),
    error: tr("crm.common.error"),
    expired: tr("crm.common.error"),
    unsubscribeAll: tr("crm.portal.preferences.unsubscribe_all"),
    unsubscribedAll: tr("crm.portal.preferences.unsubscribed_all"),
    minor: tr("crm.portal.preferences.minor"),
    confirmSent: tr("crm.portal.preferences.confirm_sent"),
    suppressed: tr("crm.portal.preferences.suppressed"),
    alwaysArrive: tr("crm.portal.preferences.always_arrive"),
  };
  return (
    <section aria-labelledby="preferences-title" className="grid max-w-2xl gap-6">
      <header className="grid gap-1">
        <h1 id="preferences-title" className="text-2xl font-semibold">
          {tr("crm.portal.preferences.title")}
        </h1>
        <p className="text-sm">{tr("crm.portal.preferences.intro")}</p>
      </header>
      <PreferenceSwitches
        mode={{ kind: "portal" }}
        items={MARKETING_PURPOSES.map((purpose) => ({ purpose, label: tr(`crm.enums.consent_purpose.${purpose}`), wording: prefs.wordings[purpose]?.[locale] ?? null }))}
        initial={prefs.purposes}
        suppressedAll={prefs.suppressedAll}
        labels={labels}
      />
    </section>
  );
}
