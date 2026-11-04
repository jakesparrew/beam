import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { PermanentError } from "@beam/core/errors";
import type { BlockDocument } from "@beam/core/email";
import { LOCALES, MissingTranslationError, t, type Locale } from "@beam/core/i18n";
import { EmailLayout, EmailText } from "./layout";
import { buildFooter, DEFAULT_FOOTER_SETTINGS } from "./layout/footer";
import { extractLinks, renderEmail } from "./render";
import { defineTemplate, type TemplateDef } from "./templates/define";
import { templates } from "./templates/platform";
import { TEMPLATE_REGISTRY } from "./templates/registry.generated";

const MAGIC_URL = "https://beam.example.com/nl/account/login/verify?token=abc123&email=customer1%40example.com";

const FIXTURES: Record<string, unknown> = {
  magic_link: { url: MAGIC_URL, expiresMinutes: 15 },
  staff_invite: { url: "https://beam.example.com/admin/invite/tok_1", expiresHours: 72 },
  password_reset: { url: "https://beam.example.com/admin/reset/tok_2", expiresMinutes: 60 },
  mfa_changed: { change: "password_changed", occurredAt: "2026-11-03T09:15:00.000Z", url: "https://beam.example.com/admin/account" },
  monthly_report: {
    period: "2026-10",
    uptimePct: 99.95,
    uptimeSource: "betterstack",
    downtimeMinutes: 22,
    incidents: { critical: 0, high: 1, normal: 2 },
    support: { received: 14, resolved: 12, breaches: 1 },
    deadJobs: 3,
    alertsSent: 9,
    backupsOk: 31,
    backupsFailed: 0,
    aiSpendCents: 1234,
    notes: "Planned maintenance on 12 October.",
    url: "https://beam.example.com/admin/system/reports/r1",
  },
};

const EXPECTED_KEYS = ["platform.magic_link", "platform.staff_invite", "platform.password_reset", "platform.mfa_changed", "platform.monthly_report"];

describe("platform templates", () => {
  it("are registered under platform.<name> with file names matching", () => {
    expect(templates.map((tpl) => `platform.${tpl.name}`)).toEqual(EXPECTED_KEYS);
    for (const key of EXPECTED_KEYS) expect(Object.keys(TEMPLATE_REGISTRY)).toContain(key);
  });

  it("every slot key exists in the platform catalogue in all three locales", () => {
    for (const tpl of templates) {
      expect(Object.keys(tpl.slots)).toEqual(expect.arrayContaining(["subject", "preheader", "heading", "body", "cta"]));
      for (const key of Object.values(tpl.slots)) {
        expect(key.startsWith(`platform.email.${tpl.name}.`)).toBe(true);
        for (const locale of LOCALES) expect(t.has(locale, key), `${locale} ${key}`).toBe(true);
      }
    }
  });

  it("fixture props pass each template's props schema", () => {
    for (const tpl of templates) expect(tpl.props.safeParse(FIXTURES[tpl.name]).success, tpl.name).toBe(true);
  });

  describe.each(templates.map((tpl) => [tpl.name, tpl] as const))("%s", (name, tpl) => {
    it.each(LOCALES)("renders in %s with html, text and subject", async (locale) => {
      const out = await renderEmail(tpl as TemplateDef, { locale, props: FIXTURES[name] });
      expect(out.subject.trim()).not.toBe("");
      expect(out.html).toContain(`lang="${locale}"`);
      expect(out.html).toContain(t(locale, "platform.email.layout.footer"));
      expect(out.text.length).toBeGreaterThan(40);
      expect(out.text).not.toContain("<");
      expect(out.html).not.toMatch(/⟦/);
      const params = Object.fromEntries(Object.entries(FIXTURES[name] as object).filter(([, v]) => typeof v === "string" || typeof v === "number"));
      const body = t(locale, `platform.email.${name}.body`, params);
      expect(out.text.replace(/\s+/g, " ")).toContain(body.slice(0, 30));
    });
  });

  it("the magic link contains the URL in html and text, and its validity in the copy", async () => {
    const tpl = templates.find((x) => x.name === "magic_link") as TemplateDef;
    const nl = await renderEmail(tpl, { locale: "nl-BE", props: FIXTURES.magic_link });
    expect(nl.html).toContain(MAGIC_URL.replace(/&/g, "&amp;"));
    expect(nl.text).toContain(MAGIC_URL);
    expect(nl.subject).toBe("Je aanmeldlink voor BEAM");
    expect(nl.text).toContain("15 minuten");
    const fr = await renderEmail(tpl, { locale: "fr-BE", props: FIXTURES.magic_link });
    expect(fr.subject).toBe("Votre lien de connexion BEAM");
  });

  it("the security notice names the change; the monthly report shows its figures", async () => {
    const mfa = await renderEmail(templates.find((x) => x.name === "mfa_changed") as TemplateDef, { locale: "en", props: { ...(FIXTURES.mfa_changed as object), change: "mfa_reset" } });
    expect(mfa.text).toContain("Two-step verification was reset");
    const report = await renderEmail(templates.find((x) => x.name === "monthly_report") as TemplateDef, { locale: "en", props: FIXTURES.monthly_report });
    expect(report.subject).toBe("BEAM platform report 2026-10");
    expect(report.text).toContain("99.95%");
    expect(report.text).toContain("Planned maintenance");
  });

  it("refuses invalid props permanently and uses edited copy when given", async () => {
    const tpl = templates.find((x) => x.name === "magic_link") as TemplateDef;
    await expect(renderEmail(tpl, { locale: "en", props: { url: "not a url", expiresMinutes: 15 } })).rejects.toBeInstanceOf(PermanentError);
    const out = await renderEmail(tpl, { locale: "en", props: FIXTURES.magic_link, copy: { subject: "Sign in ({expiresMinutes} min)" } });
    expect(out.subject).toBe("Sign in (15 min)");
  });

  it("a missing copy slot throws MissingTranslationError, never another language", async () => {
    const broken = defineTemplate({ ...(templates[0] as TemplateDef), name: "broken", slots: { subject: "platform.email.nope.subject" } });
    const err = await renderEmail(broken, { locale: "fr-BE", props: FIXTURES.magic_link }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MissingTranslationError);
    expect((err as MissingTranslationError).missing).toEqual(["fr-BE"]);
  });

  it("renders a plain element with an explicit subject (Wave 0 overload)", async () => {
    const el = createElement(EmailLayout, { locale: "en", children: createElement(EmailText, null, "Hello there, this is a plain test message body.") });
    const out = await renderEmail(el, { locale: "en", subject: "Test" });
    expect(out).toMatchObject({ subject: "Test" });
    expect(out.text).toContain("Hello there");
    await expect(renderEmail(el, { locale: "en", subject: " " })).rejects.toBeInstanceOf(PermanentError);
  });

  it("defineTemplate rejects bad names", () => {
    expect(() => defineTemplate({ ...(templates[0] as TemplateDef), name: "platform/magic-link" })).toThrow();
    expect(() => defineTemplate({ ...(templates[0] as TemplateDef), name: "Magic" })).toThrow();
  });
});

describe("renderEmail(input) (email-P2)", () => {
  const COMPANY = {
    legal_name: "Vibrant Lifestyle Collective BV",
    trade_name: "BEAM Vitality Center",
    vat_number: "BE0123456789",
    address: { street: "Voorbeeldstraat 1", postal_code: "9000", city: "Gent", country: "BE" },
    support_email: "support@demo.beam.be",
  };
  const footerFor = (locale: Locale, purpose: "transactional" | "newsletter" = "transactional") =>
    buildFooter({ company: COMPANY, footerSettings: DEFAULT_FOOTER_SETTINGS, legalLinks: { privacy: "https://beam.be/privacy", terms: null }, purpose, locale });
  const magic = () => templates.find((x) => x.name === "magic_link") as TemplateDef;
  const DOC: BlockDocument = {
    schemaVersion: 1,
    locales: {
      en: [
        { id: "hd00000001", type: "heading", level: 1, text: "Hello {{first_name|friend}}" },
        {
          id: "dy00000001",
          type: "dynamic",
          variants: [{ when: { status: "member" }, blocks: [{ id: "tx00000001", type: "text", markdown: "Member news: see [your portal]({{portal_url}})." }] }],
          fallback: [{ id: "tx00000002", type: "text", markdown: "Join us: read [the offer](https://beam.be/en/offer)." }],
        },
      ],
    },
  };

  it("code-backed: renders the legal footer in html and text and returns the links", async () => {
    const out = await renderEmail({
      source: "code",
      template: magic(),
      locale: "en",
      props: FIXTURES.magic_link,
      footer: footerFor("en"),
      values: { preferences_url: "https://beam.be/en/preferences?t=tok" },
    });
    expect(out.html).toContain("Vibrant Lifestyle Collective BV");
    expect(out.html).not.toContain(t("en", "platform.email.layout.footer"));
    expect(out.text).toContain("Manage email preferences (https://beam.be/en/preferences?t=tok)");
    expect(out.text).toContain(MAGIC_URL);
    expect(out.links).toContain(MAGIC_URL);
    expect(out.links).toContain("https://beam.be/en/preferences?t=tok");
    expect(out.html).not.toContain("{{preferences_url}}");
  });

  it("code-backed: an edited copy slot beats the catalogue default, per locale", async () => {
    const copy = { heading: { en: "Your personal sign-in link", "nl-BE": "Je persoonlijke link" } };
    const en = await renderEmail({ source: "code", template: magic(), locale: "en", props: FIXTURES.magic_link, copy });
    expect(en.html).toContain("Your personal sign-in link");
    expect(en.html).not.toContain(t("en", "platform.email.magic_link.heading"));
    const fr = await renderEmail({ source: "code", template: magic(), locale: "fr-BE", props: FIXTURES.magic_link, copy });
    expect(fr.html).toContain(t("fr-BE", "platform.email.magic_link.heading"));
  });

  it("block-backed: compiles on the fly for the recipient's variant and personalises", async () => {
    const member = await renderEmail({
      source: "blocks",
      locale: "en",
      subject: { en: "News for {{first_name|you}}" },
      document: DOC,
      recipient: { status: "member", outcomes: {} },
      footer: footerFor("en", "newsletter"),
      values: { first_name: "Ann", portal_url: "https://beam.be/en/account", preferences_url: "https://beam.be/p", unsubscribe_url: "https://beam.be/u" },
    });
    expect(member.subject).toBe("News for Ann");
    expect(member.html).toContain("Hello Ann");
    expect(member.html).toContain("Member news");
    expect(member.html).not.toContain("Join us");
    expect(member.text).toContain("your portal (https://beam.be/en/account)");
    expect(member.links).toEqual(expect.arrayContaining(["https://beam.be/en/account", "https://beam.be/p", "https://beam.be/u", "https://beam.be/privacy"]));
    const lead = await renderEmail({ source: "blocks", locale: "en", subject: { en: "News" }, document: DOC, recipient: { status: "lead", outcomes: {} }, footer: footerFor("en", "newsletter") });
    expect(lead.html).toContain("Join us");
    expect(lead.html).toContain("Hello {{first_name|friend}}");
  });

  it("block-backed: uses the precompiled html_by_locale and text_by_locale of the version", async () => {
    const compiled = {
      htmlByLocale: { en: { "dy00000001:0": '<html lang="en"><p>M {{first_name}}</p></html>', "dy00000001:f": '<html lang="en"><p>F</p></html>' } },
      textByLocale: { en: { "dy00000001:0": "M {{first_name}}", "dy00000001:f": "F" } },
    };
    const out = await renderEmail({ source: "blocks", locale: "en", subject: { en: "S" }, compiled, variant: "dy00000001:0", values: { first_name: "<Ann>" } });
    expect(out.html).toContain("M &lt;Ann&gt;");
    expect(out.text).toBe("M <Ann>");
    const fallback = await renderEmail({ source: "blocks", locale: "en", subject: { en: "S" }, compiled });
    expect(fallback.text).toBe("F");
    await expect(renderEmail({ source: "blocks", locale: "en", subject: { en: "S" }, compiled, variant: "nope" })).rejects.toBeInstanceOf(PermanentError);
  });

  it("a missing locale throws MissingTranslationError on both paths", async () => {
    const noSubject = await renderEmail({ source: "blocks", locale: "fr-BE", subject: { en: "S" }, document: DOC, footer: footerFor("fr-BE") }).catch((e: unknown) => e);
    expect(noSubject).toBeInstanceOf(MissingTranslationError);
    const noBlocks = await renderEmail({ source: "blocks", locale: "nl-BE", subject: { "nl-BE": "S" }, document: DOC, footer: footerFor("nl-BE") }).catch((e: unknown) => e);
    expect(noBlocks).toBeInstanceOf(MissingTranslationError);
    expect((noBlocks as MissingTranslationError).missing).toEqual(["nl-BE"]);
    const broken = defineTemplate({ ...magic(), name: "broken", slots: { subject: "platform.email.nope.subject" } });
    await expect(renderEmail({ source: "code", template: broken, locale: "nl-BE", props: FIXTURES.magic_link })).rejects.toBeInstanceOf(MissingTranslationError);
  });

  it("a message without a text part fails with missing_text_part", async () => {
    const compiled = { htmlByLocale: { en: { default: "<p>x</p>" } }, textByLocale: { en: { default: "  " } } };
    await expect(renderEmail({ source: "blocks", locale: "en", subject: { en: "S" }, compiled })).rejects.toThrow(/missing_text_part/);
  });

  it("extractLinks lists absolute links once, in order", () => {
    const html = '<a href="https://a.be/?x=1&amp;y=2">a</a><a href="mailto:x@example.com">m</a><a class="b" href="https://b.be">b</a><a href="https://a.be/?x=1&amp;y=2">again</a>';
    expect(extractLinks(html)).toEqual(["https://a.be/?x=1&y=2", "https://b.be"]);
  });
});
