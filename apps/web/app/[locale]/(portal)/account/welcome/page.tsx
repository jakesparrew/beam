import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { MARKETING_PURPOSES } from "@beam/core/crm";
import { localeFromSegment, LOCALES, URL_SEGMENT } from "@beam/core/i18n";
import { requireCustomer } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { messageTemplate, translator } from "@/lib/i18n";
import { getMyOnboarding } from "@/modules/crm/queries";
import { OnboardingFlow } from "@/modules/crm/ui/onboarding-flow";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const locale = localeFromSegment((await params).locale);
  if (!locale) return {};
  return { title: translator(locale)("crm.portal.onboarding.title"), robots: { index: false, follow: false } };
}

/**
 * `/[locale]/account/welcome` (owner requirements item 10): the first-sign-in onboarding, one
 * optional question per screen. The portal home opens it once (while `persons.onboarding` is
 * empty); the "Complete your profile" card on the home opens it again at the first open step.
 */
export default async function WelcomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: segment } = await params;
  const locale = localeFromSegment(segment);
  if (!locale) notFound();
  const actor = await requireCustomer(locale);
  const tr = translator(locale);
  const data = await getMyOnboarding(await getAppDb(), actor.personId);
  if (!data) notFound();
  const o = (k: string) => tr(`crm.portal.onboarding.${k}`);
  const p = (k: string) => tr(`crm.portal.profile.${k}`);
  const base = `/${URL_SEGMENT[locale]}/account`;
  const { profile, preferences } = data;
  return (
    <OnboardingFlow
      start={data.progress.next}
      homeHref={base}
      profileHref={`${base}/profile`}
      prefill={{
        emergency: profile.emergencyContact,
        purposes: preferences.purposes,
        suppressedAll: preferences.suppressedAll,
        channel: profile.preferredChannel,
        company: data.company,
        birthOn: profile.birthOn,
        locale: profile.locale,
      }}
      purposes={MARKETING_PURPOSES.map((purpose) => ({ purpose, label: tr(`crm.enums.consent_purpose.${purpose}`), wording: preferences.wordings[purpose]?.[locale] ?? null }))}
      channels={(["email", "phone", "whatsapp"] as const).map((c) => ({ value: c, label: tr(`crm.enums.preferred_channel.${c}`) }))}
      locales={LOCALES.map((l) => ({ value: l, label: tr(`crm.enums.locale.${l.replace("-", "_")}`) }))}
      labels={{
        title: o("title"),
        intro: o("intro"),
        progress: messageTemplate(locale, "crm.portal.onboarding.progress"),
        continue: o("continue"),
        skip: o("skip"),
        later: o("later"),
        saving: o("saving"),
        error: o("error"),
        enterHint: o("enter_hint"),
        emergencyTitle: o("emergency_title"),
        emergencyBody: o("emergency_body"),
        emergencyName: p("emergency_name"),
        emergencyPhone: p("emergency_phone"),
        emergencyRelation: o("emergency_relation"),
        emergencyIncomplete: o("emergency_incomplete"),
        communicationTitle: o("communication_title"),
        communicationBody: o("communication_body"),
        communicationAlways: o("communication_always"),
        channel: o("channel"),
        confirmSent: o("confirm_sent"),
        suppressed: o("suppressed"),
        companyTitle: o("company_title"),
        companyBody: o("company_body"),
        vat: o("vat"),
        vatHint: o("vat_hint"),
        vatInvalid: o("vat_invalid"),
        companyName: o("company_name"),
        companyNameRequired: o("company_name_required"),
        companyLinked: messageTemplate(locale, "crm.portal.onboarding.company_linked"),
        street: p("street"),
        number: p("number"),
        postalCode: p("postal_code"),
        city: p("city"),
        country: p("country"),
        aboutTitle: o("about_title"),
        aboutBody: o("about_body"),
        birthOn: p("birth_on"),
        language: p("language"),
        doneTitle: o("done_title"),
        doneBody: o("done_body"),
        doneHome: o("done_home"),
        doneProfile: o("done_profile"),
      }}
    />
  );
}
