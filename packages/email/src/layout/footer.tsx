/**
 * The legal footer of every email (email spec rules 4, 5, 55; decision 35).
 *
 * Belgian company identification (Code of Companies 2:20): legal name and form, trade name,
 * registered office, enterprise number (`BE 0123.456.789`, from the VAT number) and the RPR
 * register entry per locale; the support address; the privacy and terms links from
 * `site.getLegalLinks(locale)`; the reason sentence from `settings.email_footer.reasons`.
 * Marketing footers add the commercial-message sentence (Code of Economic Law XII.12) and the
 * links "Manage preferences" and "Unsubscribe from <category>"; transactional footers carry one
 * "Manage email preferences" link. Without `preferenceUrls` the links hold the tokens
 * `{{preferences_url}}` and `{{unsubscribe_url}}`, which `personalise()` fills per message.
 *
 * There is no fallback language: a missing RPR or reason in `locale` throws
 * `MissingTranslationError`. The fixed wording lives in `FOOTER_COPY` until email's catalogue
 * (`email.footer.*`, owned by a later email package) takes it over.
 */
import { PermanentError } from "@beam/core/errors";
import { formatDate, MissingTranslationError, pick, type Locale, type LocalizedText } from "@beam/core/i18n";
import { escapeHtml } from "@beam/core/email";
import type { MarketingPurpose } from "@beam/core/email";
import { BRAND, type Brand } from "./brand";

export type FooterPurpose = MarketingPurpose | "transactional";

/** The subset of `settings.company` the footer reads. */
export type FooterCompany = {
  legal_name: string;
  trade_name: string;
  vat_number: string;
  address: { street: string; postal_code: string; city: string; country: string };
  support_email: string;
};

/** `settings.email_footer`: reason sentences per purpose (and `transactional`) and the RPR line, per locale. */
export type FooterSettings = {
  reasons: Partial<Record<FooterPurpose, LocalizedText>>;
  rpr: LocalizedText;
};

/** `site.getLegalLinks(locale)`. */
export type LegalLinks = { privacy: string | null; terms: string | null; cookies?: string | null; accessibility?: string | null };

/** crm's `buildPreferenceUrls(linkToken, locale)` (the one-click URL goes into the headers, not the footer). */
export type FooterPreferenceUrls = { preferencesUrl: string; unsubscribeUrl?: string | null };

export type BuildFooterInput = {
  company: FooterCompany;
  footerSettings: FooterSettings;
  legalLinks: LegalLinks;
  purpose: FooterPurpose;
  /** Consent `recorded_at` (marketing); replaces `{date}` in the reason. */
  consentDate?: Date | string | null;
  preferenceUrls?: FooterPreferenceUrls | null;
  locale: Locale;
  brand?: Brand;
};

export type FooterParts = { html: string; text: string };

type Copy = {
  manageEmailPreferences: string;
  managePreferences: string;
  unsubscribe: Record<MarketingPurpose, string>;
  commercial: (name: string) => string;
  enterpriseNumber: string;
  privacy: string;
  terms: string;
  questions: string;
  country: Record<string, string>;
};

/** Fixed footer wording per locale (`en` is the source). */
export const FOOTER_COPY: Readonly<Record<Locale, Copy>> = {
  en: {
    manageEmailPreferences: "Manage email preferences",
    managePreferences: "Manage preferences",
    unsubscribe: {
      newsletter: "Unsubscribe from the newsletter",
      events: "Unsubscribe from event emails",
      member_comms: "Unsubscribe from member news",
      b2b: "Unsubscribe from business emails",
    },
    commercial: (name) => `This is a commercial message from ${name}.`,
    enterpriseNumber: "Enterprise number",
    privacy: "Privacy policy",
    terms: "Terms and conditions",
    questions: "Questions? Write to",
    country: { BE: "Belgium" },
  },
  "nl-BE": {
    manageEmailPreferences: "E-mailvoorkeuren beheren",
    managePreferences: "Voorkeuren beheren",
    unsubscribe: {
      newsletter: "Uitschrijven voor de nieuwsbrief",
      events: "Uitschrijven voor e-mails over evenementen",
      member_comms: "Uitschrijven voor ledennieuws",
      b2b: "Uitschrijven voor zakelijke e-mails",
    },
    commercial: (name) => `Dit is een commerciële boodschap van ${name}.`,
    enterpriseNumber: "Ondernemingsnummer",
    privacy: "Privacyverklaring",
    terms: "Algemene voorwaarden",
    questions: "Vragen? Mail naar",
    country: { BE: "België" },
  },
  "fr-BE": {
    manageEmailPreferences: "Gérer mes préférences e-mail",
    managePreferences: "Gérer mes préférences",
    unsubscribe: {
      newsletter: "Se désinscrire de la newsletter",
      events: "Se désinscrire des e-mails sur les événements",
      member_comms: "Se désinscrire des nouvelles des membres",
      b2b: "Se désinscrire des e-mails professionnels",
    },
    commercial: (name) => `Ceci est un message commercial de ${name}.`,
    enterpriseNumber: "Numéro d'entreprise",
    privacy: "Politique de confidentialité",
    terms: "Conditions générales",
    questions: "Des questions ? Écrivez à",
    country: { BE: "Belgique" },
  },
};

/** Category names of the marketing purposes, per locale (footers and reports). */
export const CATEGORY_NAMES: Readonly<Record<Locale, Record<MarketingPurpose, string>>> = {
  en: { newsletter: "Newsletter", events: "Events", member_comms: "Member news", b2b: "Business" },
  "nl-BE": { newsletter: "Nieuwsbrief", events: "Evenementen", member_comms: "Ledennieuws", b2b: "Zakelijk" },
  "fr-BE": { newsletter: "Newsletter", events: "Événements", member_comms: "Nouvelles des membres", b2b: "Professionnel" },
};

/**
 * Defaults of `settings.email_footer` (email-P3 declares the setting with these values; staff
 * edit them). `{date}` is the consent date of the recipient for the purpose (marketing only).
 */
export const DEFAULT_FOOTER_SETTINGS: FooterSettings = {
  rpr: { "nl-BE": "RPR Gent", "fr-BE": "RPM Gand", en: "RLE Ghent" },
  reasons: {
    transactional: {
      en: "You receive this email because of your account, booking or purchase with BEAM Vitality Center.",
      "nl-BE": "Je ontvangt deze e-mail omdat je een account, boeking of aankoop hebt bij BEAM Vitality Center.",
      "fr-BE": "Vous recevez cet e-mail en raison de votre compte, réservation ou achat chez BEAM Vitality Center.",
    },
    newsletter: {
      en: "You receive it because you subscribed to the BEAM newsletter on {date}.",
      "nl-BE": "Je ontvangt deze boodschap omdat je je op {date} hebt ingeschreven voor de BEAM-nieuwsbrief.",
      "fr-BE": "Vous la recevez parce que vous vous êtes inscrit à la newsletter BEAM le {date}.",
    },
    events: {
      en: "You receive it because you asked for news about BEAM events on {date}.",
      "nl-BE": "Je ontvangt deze boodschap omdat je op {date} nieuws over BEAM-evenementen hebt gevraagd.",
      "fr-BE": "Vous la recevez parce que vous avez demandé des nouvelles des événements BEAM le {date}.",
    },
    member_comms: {
      en: "You receive it because you are a BEAM member and agreed to member news on {date}.",
      "nl-BE": "Je ontvangt deze boodschap omdat je lid bent van BEAM en op {date} hebt ingestemd met ledennieuws.",
      "fr-BE": "Vous la recevez parce que vous êtes membre de BEAM et avez accepté les nouvelles des membres le {date}.",
    },
    b2b: {
      en: "You receive it because your organisation agreed to business emails from BEAM on {date}.",
      "nl-BE": "Je ontvangt deze boodschap omdat je organisatie op {date} heeft ingestemd met zakelijke e-mails van BEAM.",
      "fr-BE": "Vous la recevez parce que votre organisation a accepté les e-mails professionnels de BEAM le {date}.",
    },
  },
};

/** `BE0123456789` (or `0123456789`, `0123.456.789`) -> `BE 0123.456.789`. */
export function formatEnterpriseNumber(vatNumber: string): string {
  const digits = vatNumber.replace(/[^0-9]/g, "");
  if (digits.length !== 10) throw new PermanentError(`footer_incomplete: enterprise number ${vatNumber} must have 10 digits`);
  return `BE ${digits.slice(0, 4)}.${digits.slice(4, 7)}.${digits.slice(7)}`;
}

/**
 * Rule 5: the items that block publishing a marketing template or scheduling a campaign for
 * `purpose` in `locales`, as `field` or `field:locale` strings. Empty means complete.
 */
export function footerProblems(input: {
  company: Partial<FooterCompany> | null | undefined;
  footerSettings: Partial<FooterSettings> | null | undefined;
  purpose: FooterPurpose;
  locales: readonly Locale[];
}): string[] {
  const out: string[] = [];
  const c = input.company;
  if (!c?.legal_name?.trim()) out.push("company.legal_name");
  const a = c?.address;
  if (!a || !a.street?.trim() || !a.postal_code?.trim() || !a.city?.trim()) out.push("company.address");
  if (!c?.vat_number || c.vat_number.replace(/[^0-9]/g, "").length !== 10) out.push("company.vat_number");
  for (const locale of input.locales) {
    if (!input.footerSettings?.rpr?.[locale]?.trim()) out.push(`email_footer.rpr:${locale}`);
    if (!input.footerSettings?.reasons?.[input.purpose]?.[locale]?.trim()) out.push(`email_footer.reasons.${input.purpose}:${locale}`);
  }
  return out;
}

type FooterLink = { label: string; href: string };

type FooterModel = { lines: string[]; supportLabel: string; supportEmail: string; legal: FooterLink[]; preferences: FooterLink[] };

function model(input: BuildFooterInput): FooterModel {
  const { company, locale, purpose } = input;
  const copy = FOOTER_COPY[locale];
  if (!company.legal_name?.trim()) throw new PermanentError("footer_incomplete: company.legal_name");
  const a = company.address;
  if (!a?.street?.trim() || !a.postal_code?.trim() || !a.city?.trim()) throw new PermanentError("footer_incomplete: company.address");
  const rpr = pick(input.footerSettings.rpr, locale, "email_footer.rpr");
  const reasonText = input.footerSettings.reasons?.[purpose];
  if (!reasonText?.[locale]?.trim()) throw new MissingTranslationError([locale], `email_footer.reasons.${purpose}`);
  let reason = reasonText[locale];
  if (purpose !== "transactional" && input.consentDate) {
    reason = reason.replace(/\{date\}/g, formatDate(input.consentDate, locale, "long"));
  } else {
    reason = reason
      // Without a date the phrase "on {date}" / "op {date}" / "le {date}" goes as a whole.
      .replace(/\s*(?:\b(?:on|op|le|since|sinds|depuis)\s+)?\{date\}/g, "")
      .replace(/\s+([.,;:])/g, "$1")
      .trim();
  }
  const country = copy.country[a.country] ?? a.country;
  const lines = [
    company.trade_name?.trim() && company.trade_name !== company.legal_name ? `${company.legal_name} (${company.trade_name})` : company.legal_name,
    `${a.street}, ${a.postal_code} ${a.city}, ${country}`,
    `${copy.enterpriseNumber} ${formatEnterpriseNumber(company.vat_number)} · ${rpr}`,
  ];
  const reasonLine = purpose === "transactional" ? reason : `${copy.commercial(company.trade_name?.trim() || company.legal_name)} ${reason}`;
  lines.push(reasonLine);

  const legal: FooterLink[] = [];
  if (input.legalLinks.privacy) legal.push({ label: copy.privacy, href: input.legalLinks.privacy });
  if (input.legalLinks.terms) legal.push({ label: copy.terms, href: input.legalLinks.terms });

  const prefsUrl = input.preferenceUrls?.preferencesUrl ?? "{{preferences_url}}";
  const preferences: FooterLink[] =
    purpose === "transactional"
      ? [{ label: copy.manageEmailPreferences, href: prefsUrl }]
      : [
          { label: copy.managePreferences, href: prefsUrl },
          { label: copy.unsubscribe[purpose], href: input.preferenceUrls?.unsubscribeUrl ?? "{{unsubscribe_url}}" },
        ];
  return { lines, supportLabel: copy.questions, supportEmail: company.support_email, legal, preferences };
}

/** The footer as an HTML fragment (inline styles, for `mj-text` and react-email) and as plain text. */
export function buildFooter(input: BuildFooterInput): FooterParts {
  const m = model(input);
  const brand = input.brand ?? BRAND;
  const p = `margin:0 0 8px;color:${brand.muted};font-family:${brand.font};font-size:${brand.footerSize}px;line-height:18px`;
  const link = (l: FooterLink) => `<a href="${escapeHtml(l.href)}" style="color:${brand.muted};text-decoration:underline">${escapeHtml(l.label)}</a>`;
  const html = [
    ...m.lines.map((line) => `<p style="${p}">${escapeHtml(line)}</p>`),
    m.supportEmail
      ? `<p style="${p}">${escapeHtml(m.supportLabel)} <a href="mailto:${escapeHtml(m.supportEmail)}" style="color:${brand.muted};text-decoration:underline">${escapeHtml(m.supportEmail)}</a></p>`
      : "",
    m.legal.length ? `<p style="${p}">${m.legal.map(link).join(" · ")}</p>` : "",
    `<p style="${p}">${m.preferences.map(link).join(" · ")}</p>`,
  ]
    .filter(Boolean)
    .join("\n");
  const text = [
    ...m.lines,
    m.supportEmail ? `${m.supportLabel} ${m.supportEmail}` : "",
    m.legal.map((l) => `${l.label} (${l.href})`).join(" · "),
    ...m.preferences.map((l) => `${l.label} (${l.href})`),
  ]
    .filter(Boolean)
    .join("\n");
  return { html: `<div class="beam-footer">\n${html}\n</div>`, text };
}

/** The footer fragment inside a react-email layout. */
export function FooterHtml({ footer }: { footer: FooterParts }) {
  return <div dangerouslySetInnerHTML={{ __html: footer.html }} />;
}
