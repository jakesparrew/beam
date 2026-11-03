import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { PermanentError } from "@beam/core/errors";
import { LOCALES, MissingTranslationError, t } from "@beam/core/i18n";
import { EmailLayout, EmailText } from "./layout";
import { renderEmail } from "./render";
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
