import { readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { LOCALES } from "@beam/core/i18n";
import { buildFooter, DEFAULT_FOOTER_SETTINGS, FOOTER_COPY } from "../layout/footer";
import { renderEmail } from "../render";
import { defineTemplate, registryProblems, templateFileBasename, TEMPLATE_NAME_PATTERN, type TemplateDef } from "./define";
import { templates as emailTemplates } from "./email";
import { TEMPLATE_REGISTRY } from "./registry.generated";

const DIR = dirname(fileURLToPath(import.meta.url));
const REGISTRY = TEMPLATE_REGISTRY as unknown as Record<string, TemplateDef>;
const KEYS = Object.keys(REGISTRY).sort();

/**
 * Samples for registry entries whose owner has not declared `sample` yet (Wave 0 platform
 * templates; requested from platform). An entry with neither fails the test.
 */
const PENDING_SAMPLES: Record<string, unknown> = {
  "platform.magic_link": { url: "https://beam.example.com/nl/account/login/verify?token=abc123", expiresMinutes: 15 },
  "platform.staff_invite": { url: "https://beam.example.com/admin/invite/tok_1", expiresHours: 72 },
  "platform.password_reset": { url: "https://beam.example.com/admin/reset/tok_2", expiresMinutes: 60 },
  "platform.mfa_changed": { change: "password_changed", occurredAt: "2026-11-03T09:15:00.000Z", url: "https://beam.example.com/admin/account" },
  "platform.monthly_report": {
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

const COMPANY = {
  legal_name: "Vibrant Lifestyle Collective BV",
  trade_name: "BEAM Vitality Center",
  vat_number: "BE0123456789",
  address: { street: "Voorbeeldstraat 1", postal_code: "9000", city: "Gent", country: "BE" },
  support_email: "support@demo.beam.be",
};
const PREFERENCES = "https://beam.be/api/public/preferences?t=sample-token";

function templateFolders(): string[] {
  return readdirSync(DIR).filter((f) => statSync(join(DIR, f)).isDirectory());
}

function componentFiles(folder: string): string[] {
  return readdirSync(join(DIR, folder))
    .filter((f) => /\.(tsx|ts)$/.test(f) && !/^index\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
    .map((f) => f.replace(/\.(tsx|ts)$/, ""));
}

describe("the template registry", () => {
  it("has entries (runs over whatever modules have registered)", () => {
    expect(KEYS.length).toBeGreaterThan(0);
    expect(emailTemplates).toEqual([]);
  });

  it("every key is <m>.<snake_name> with <m> its folder and <snake_name> its file basename; one file is one key", () => {
    for (const key of KEYS) {
      const [folder, name, ...rest] = key.split(".");
      expect(rest, key).toEqual([]);
      expect(TEMPLATE_NAME_PATTERN.test(name ?? ""), key).toBe(true);
      expect(REGISTRY[key]?.name, key).toBe(name);
      expect(componentFiles(folder ?? ""), key).toContain(templateFileBasename(name ?? ""));
    }
    for (const folder of templateFolders()) {
      const keys = KEYS.filter((k) => k.startsWith(`${folder}.`)).map((k) => templateFileBasename(k.slice(folder.length + 1)));
      expect(keys.sort(), folder).toEqual(componentFiles(folder).sort());
    }
    const refs = KEYS.map((key) => {
      const [folder = "", name = ""] = key.split(".");
      return { folder, name, file: `${folder}/${templateFileBasename(name)}.tsx` };
    });
    expect(registryProblems(refs)).toEqual([]);
  });

  describe.each(KEYS)("%s", (key) => {
    const tpl = REGISTRY[key] as TemplateDef;
    const sample = tpl.sample ?? PENDING_SAMPLES[key];

    it("declares a sample that passes its props schema", () => {
      expect(sample, `${key} needs a sample`).toBeDefined();
      expect(tpl.props.safeParse(sample).success).toBe(true);
    });

    it.each(LOCALES)("renders its sample in %s with a text part, the footer with the preferences link and no tracking pixel", async (locale) => {
      const footer = buildFooter({ company: COMPANY, footerSettings: DEFAULT_FOOTER_SETTINGS, legalLinks: { privacy: null, terms: null }, purpose: "transactional", locale });
      const out = await renderEmail({ source: "code", template: tpl, locale, props: sample, footer, values: { preferences_url: PREFERENCES } });
      expect(out.subject.trim()).not.toBe("");
      expect(out.html).toContain(`lang="${locale}"`);
      expect(out.text.length).toBeGreaterThan(40);
      expect(out.text).not.toMatch(/<[a-z]/i);
      const label = FOOTER_COPY[locale].manageEmailPreferences;
      expect(out.html).toMatch(new RegExp(`<a href="${PREFERENCES.replace(/[.?]/g, "\\$&")}"[^>]*>${label}</a>`));
      expect(out.text).toContain(`${label} (${PREFERENCES})`);
      expect(out.html).toContain("Vibrant Lifestyle Collective BV");
      expect(out.html).not.toMatch(/\/api\/public\/track\//);
      expect(out.html).not.toMatch(/<img\b[^>]*\b(width="1"|height="1")/i);
      expect(out.html).not.toMatch(/⟦/);
    });
  });
});

describe("registryProblems and defineTemplate", () => {
  const Props = z.object({ url: z.string().url() });
  const base = { component: () => null as never, props: Props, slots: { subject: "booking.email.booking_confirmed.subject" } };

  it("refuses a duplicate key, a kebab-case name, a name not matching its basename and a slash", () => {
    const problems = registryProblems([
      { folder: "booking", name: "booking_confirmed", file: "booking/booking-confirmed.tsx" },
      { folder: "booking", name: "booking_confirmed", file: "booking/booking-confirmed-copy.tsx" },
      { folder: "booking", name: "booking-cancelled", file: "booking/booking-cancelled.tsx" },
      { folder: "booking", name: "booking_moved", file: "booking/session-moved.tsx" },
      { folder: "booking", name: "booking/reminder", file: "booking/reminder.tsx" },
      { folder: "webinar", name: "replay_available", file: "webinar/replay-available.tsx" },
    ]);
    expect(problems).toHaveLength(4);
    expect(problems[0]).toMatch(/booking\.booking_confirmed: the name does not match its file "booking-confirmed-copy"/);
    expect(problems[1]).toMatch(/booking\.booking-cancelled: the name must be snake_case/);
    expect(problems[2]).toMatch(/booking\.booking_moved: the name does not match its file "session-moved"/);
    expect(problems[3]).toMatch(/slash/);
    const dup = registryProblems([
      { folder: "booking", name: "booking_confirmed", file: "booking/booking-confirmed.tsx" },
      { folder: "booking", name: "booking_confirmed", file: "booking/booking-confirmed.tsx" },
    ]);
    expect(dup).toEqual([expect.stringMatching(/duplicate key/)]);
  });

  it("defineTemplate refuses bad names, a missing subject slot and a sample that fails the schema", () => {
    expect(() => defineTemplate({ ...base, name: "booking-confirmed" })).toThrow();
    expect(() => defineTemplate({ ...base, name: "booking/confirmed" })).toThrow();
    expect(() => defineTemplate({ ...base, name: "ok_name", slots: {} })).toThrow(/subject/);
    expect(() => defineTemplate({ ...base, name: "ok_name", sample: { url: "not a url" } })).toThrow(/sample/);
    expect(defineTemplate({ ...base, name: "ok_name", sample: { url: "https://beam.be" } }).sample).toEqual({ url: "https://beam.be" });
  });
});
