import { describe, expect, it } from "vitest";
import { MARKETING_PURPOSES } from "@beam/core/email";
import { PermanentError } from "@beam/core/errors";
import { formatDate, LOCALES, MissingTranslationError } from "@beam/core/i18n";
import { buildFooter, DEFAULT_FOOTER_SETTINGS, FOOTER_COPY, footerProblems, formatEnterpriseNumber, type BuildFooterInput } from "./footer";

const COMPANY = {
  legal_name: "Vibrant Lifestyle Collective BV",
  trade_name: "BEAM Vitality Center",
  vat_number: "BE0123456789",
  address: { street: "Voorbeeldstraat 1", postal_code: "9000", city: "Gent", country: "BE" },
  support_email: "support@demo.beam.be",
};

const base = (over: Partial<BuildFooterInput> = {}): BuildFooterInput => ({
  company: COMPANY,
  footerSettings: DEFAULT_FOOTER_SETTINGS,
  legalLinks: { privacy: "https://beam.be/en/privacy", terms: "https://beam.be/en/terms" },
  purpose: "transactional",
  locale: "en",
  ...over,
});

describe("buildFooter", () => {
  it("states the legal name and form, trade name, registered office and support address", () => {
    const { html, text } = buildFooter(base());
    expect(text).toContain("Vibrant Lifestyle Collective BV (BEAM Vitality Center)");
    expect(text).toContain("Voorbeeldstraat 1, 9000 Gent, Belgium");
    expect(text).toContain("support@demo.beam.be");
    expect(html).toContain('href="mailto:support@demo.beam.be"');
  });

  it("formats the enterprise number BE 0123.456.789", () => {
    expect(formatEnterpriseNumber("BE0123456789")).toBe("BE 0123.456.789");
    expect(formatEnterpriseNumber("0123.456.789")).toBe("BE 0123.456.789");
    expect(() => formatEnterpriseNumber("BE123")).toThrow(PermanentError);
    expect(buildFooter(base()).text).toContain("Enterprise number BE 0123.456.789");
  });

  it("writes the RPR entry per locale and has no fallback language", () => {
    expect(buildFooter(base({ locale: "nl-BE" })).text).toContain("Ondernemingsnummer BE 0123.456.789 · RPR Gent");
    expect(buildFooter(base({ locale: "fr-BE" })).text).toContain("Numéro d'entreprise BE 0123.456.789 · RPM Gand");
    const noFr = { ...DEFAULT_FOOTER_SETTINGS, rpr: { "nl-BE": "RPR Gent", en: "RLE Ghent" } };
    const err = (() => {
      try {
        buildFooter(base({ locale: "fr-BE", footerSettings: noFr }));
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(MissingTranslationError);
  });

  it("links the privacy policy and the terms from site.getLegalLinks", () => {
    const { html, text } = buildFooter(base());
    expect(html).toContain('href="https://beam.be/en/privacy"');
    expect(html).toContain('href="https://beam.be/en/terms"');
    expect(text).toContain("Privacy policy (https://beam.be/en/privacy)");
    expect(buildFooter(base({ legalLinks: { privacy: "https://beam.be/en/privacy", terms: null } })).text).not.toContain("Terms and conditions");
  });

  it("gives the reason per purpose, with the consent date for marketing", () => {
    for (const purpose of MARKETING_PURPOSES) {
      const { text } = buildFooter(base({ purpose, consentDate: "2026-03-14T10:00:00.000Z", preferenceUrls: { preferencesUrl: "https://beam.be/p/t", unsubscribeUrl: "https://beam.be/u/t" } }));
      expect(text, purpose).toContain((DEFAULT_FOOTER_SETTINGS.reasons[purpose]?.en ?? "").replace("{date}", formatDate("2026-03-14T10:00:00.000Z", "en", "long")));
    }
    const nl = buildFooter(base({ purpose: "newsletter", locale: "nl-BE", consentDate: "2026-03-14T10:00:00.000Z" })).text;
    expect(nl).toContain("op 14 maart 2026");
    const undated = buildFooter(base({ purpose: "newsletter" })).text;
    expect(undated).toContain("You receive it because you subscribed to the BEAM newsletter.");
    expect(undated).not.toContain("{date}");
  });

  it("gives the transactional reason and one Manage email preferences link, no unsubscribe", () => {
    const { html, text } = buildFooter(base({ preferenceUrls: { preferencesUrl: "https://beam.be/en/preferences?t=tok" } }));
    expect(text).toContain(DEFAULT_FOOTER_SETTINGS.reasons.transactional?.en);
    expect(text).toContain("Manage email preferences (https://beam.be/en/preferences?t=tok)");
    expect(html).toContain('href="https://beam.be/en/preferences?t=tok"');
    expect(text).not.toMatch(/Unsubscribe/);
    const tokens = buildFooter(base());
    expect(tokens.html).toContain('href="{{preferences_url}}"');
  });

  it("adds the commercial-message sentence and the category unsubscribe link only for marketing", () => {
    for (const locale of LOCALES) {
      const sentence = FOOTER_COPY[locale].commercial("BEAM Vitality Center");
      const marketing = buildFooter(base({ purpose: "events", locale })).text;
      expect(marketing).toContain(sentence);
      expect(marketing).toContain(FOOTER_COPY[locale].managePreferences);
      expect(marketing).toContain(`${FOOTER_COPY[locale].unsubscribe.events} ({{unsubscribe_url}})`);
      const transactional = buildFooter(base({ locale })).text;
      expect(transactional).not.toContain(sentence);
      expect(transactional).toContain(FOOTER_COPY[locale].manageEmailPreferences);
    }
  });

  it("escapes values in the HTML", () => {
    const { html } = buildFooter(base({ company: { ...COMPANY, trade_name: "BEAM <Vitality> & Co" } }));
    expect(html).toContain("BEAM &lt;Vitality&gt; &amp; Co");
  });

  it("footerProblems lists what blocks publishing (rule 5)", () => {
    expect(footerProblems({ company: COMPANY, footerSettings: DEFAULT_FOOTER_SETTINGS, purpose: "newsletter", locales: LOCALES })).toEqual([]);
    const problems = footerProblems({
      company: { ...COMPANY, legal_name: "", vat_number: "BE0", address: { ...COMPANY.address, street: "" } },
      footerSettings: { rpr: { en: "RLE Ghent" }, reasons: { newsletter: { en: "x", "nl-BE": "y" } } },
      purpose: "newsletter",
      locales: LOCALES,
    });
    expect(problems).toEqual([
      "company.legal_name",
      "company.address",
      "company.vat_number",
      "email_footer.rpr:nl-BE",
      "email_footer.rpr:fr-BE",
      "email_footer.reasons.newsletter:fr-BE",
    ]);
  });
});
