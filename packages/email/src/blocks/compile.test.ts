import { describe, expect, it } from "vitest";
import type { Block, BlockDocument, TextBlock } from "@beam/core/email";
import { PermanentError } from "@beam/core/errors";
import { MissingTranslationError } from "@beam/core/i18n";
import { buildFooter, DEFAULT_FOOTER_SETTINGS } from "../layout/footer";
import { compileDocument, compileMarketing, decodeVariant, encodeVariant, MAX_HTML_BYTES, selectVariant, variantChoices } from "./compile";

const COMPANY = {
  legal_name: "Vibrant Lifestyle Collective BV",
  trade_name: "BEAM Vitality Center",
  vat_number: "BE0123456789",
  address: { street: "Voorbeeldstraat 1", postal_code: "9000", city: "Gent", country: "BE" },
  support_email: "support@demo.beam.be",
};
const footerFor = (locale: "en" | "nl-BE" | "fr-BE") =>
  buildFooter({ company: COMPANY, footerSettings: DEFAULT_FOOTER_SETTINGS, legalLinks: { privacy: "https://beam.be/privacy", terms: null }, purpose: "newsletter", locale });

const text = (id: string, markdown: string): TextBlock => ({ id, type: "text", markdown });

/** A newsletter with a status block (lead, customer, member) and an assessment outcome block. */
const BLOCKS: Block[] = [
  { id: "hd00000001", type: "heading", level: 1, text: "Your BEAM update" },
  {
    id: "dystatus01",
    type: "dynamic",
    variants: [
      { when: { status: "lead" }, blocks: [text("tx0000lead", "LEAD: try your first session at half price.")] },
      { when: { status: "customer" }, blocks: [text("tx000custo", "CUSTOMER: welcome back, your next session awaits.")] },
      { when: { status: "member" }, blocks: [text("tx00member", "MEMBER: your member evening is on Friday.")] },
    ],
    fallback: [text("tx0000fall", "FALLBACK: discover BEAM.")],
  },
  {
    id: "dyassess01",
    type: "dynamic",
    variants: [
      { when: { assessmentOutcome: { formSlug: "stress-check", outcomeKeys: ["high", "very_high"] } }, blocks: [text("tx000hstrs", "STRESS: book a recovery programme.")] },
    ],
    fallback: [],
  },
];
const DOC: BlockDocument = { schemaVersion: 1, locales: { en: BLOCKS, "nl-BE": [text("tx00000nl1", "Alleen Nederlandse tekst.")] } };

describe("compileMarketing", () => {
  it("renders one variant per path: lead, customer and member content blocks display correctly", async () => {
    const { variants } = await compileMarketing(DOC, "en", { footer: footerFor("en") });
    expect(Object.keys(variants)).toHaveLength(4 * 2);
    for (const [status, marker] of [
      ["lead", "LEAD:"],
      ["customer", "CUSTOMER:"],
      ["member", "MEMBER:"],
    ] as const) {
      const path = selectVariant(DOC, "en", { status, outcomes: {} });
      const v = variants[path];
      expect(v, path).toBeDefined();
      expect(v?.html).toContain(marker);
      expect(v?.text).toContain(marker);
      for (const other of ["LEAD:", "CUSTOMER:", "MEMBER:", "FALLBACK:"].filter((m) => m !== marker)) {
        expect(v?.html).not.toContain(other);
        expect(v?.text).not.toContain(other);
      }
      expect(v?.html).not.toContain("STRESS:");
    }
    const unknown = variants[selectVariant(DOC, "en", { status: null, outcomes: {} })];
    expect(unknown?.html).toContain("FALLBACK:");
  });

  it("assessment outcome variants follow the latest outcome of the form", async () => {
    const { variants } = await compileMarketing(DOC, "en", { footer: footerFor("en") });
    const high = selectVariant(DOC, "en", { status: "member", outcomes: { "stress-check": "very_high" } });
    expect(high).toBe("dystatus01:2,dyassess01:0");
    expect(variants[high]?.html).toContain("STRESS:");
    expect(variants[high]?.html).toContain("MEMBER:");
    const low = selectVariant(DOC, "en", { status: "member", outcomes: { "stress-check": "low", "other-form": "high" } });
    expect(variants[low]?.html).not.toContain("STRESS:");
  });

  it("encodes and decodes variant paths; a locale without dynamic blocks has the default path", async () => {
    expect(variantChoices(BLOCKS)).toHaveLength(8);
    const choice = decodeVariant("dystatus01:1,dyassess01:f");
    expect(choice).toEqual({ dystatus01: 1, dyassess01: "fallback" });
    expect(encodeVariant(choice, BLOCKS)).toBe("dystatus01:1,dyassess01:f");
    const nl = await compileMarketing(DOC, "nl-BE", { footer: footerFor("nl-BE") });
    expect(Object.keys(nl.variants)).toEqual(["default"]);
    expect(nl.variants.default?.html).toContain('lang="nl-BE"');
    expect(nl.variants.default?.text).toContain("Alleen Nederlandse tekst.");
    expect(nl.variants.default?.text).toContain("Vibrant Lifestyle Collective BV");
  });

  it("a missing locale throws MissingTranslationError, an invalid document a PermanentError", async () => {
    const err = await compileMarketing(DOC, "fr-BE", { footer: footerFor("fr-BE") }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MissingTranslationError);
    expect((err as MissingTranslationError).missing).toEqual(["fr-BE"]);
    const bad = { schemaVersion: 1, locales: { en: [{ id: "short", type: "text", markdown: "x" }] } } as unknown as BlockDocument;
    await expect(compileMarketing(bad, "en", { footer: footerFor("en") })).rejects.toBeInstanceOf(PermanentError);
  });

  it("warns above 102 KB of HTML and still compiles", async () => {
    const paragraph = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(14);
    const big: BlockDocument = { schemaVersion: 1, locales: { en: Array.from({ length: 150 }, (_v, i) => text(`big${String(i).padStart(7, "0")}`, paragraph)) } };
    const result = await compileMarketing(big, "en", { footer: footerFor("en") });
    expect(Buffer.byteLength(result.variants.default?.html ?? "")).toBeGreaterThan(MAX_HTML_BYTES);
    expect(result.warnings.map((w) => w.code)).toContain("html_too_large");
    const small = await compileMarketing(DOC, "nl-BE", { footer: footerFor("nl-BE") });
    expect(small.warnings.map((w) => w.code)).not.toContain("html_too_large");
  });

  it("compileDocument fills html_by_locale and text_by_locale per locale and variant", async () => {
    const out = await compileDocument(DOC, ["en", "nl-BE"], { footerFor, subject: { en: "Update", "nl-BE": "Nieuws" } });
    expect(Object.keys(out.htmlByLocale)).toEqual(["en", "nl-BE"]);
    expect(Object.keys(out.htmlByLocale.en ?? {})).toHaveLength(8);
    expect(out.textByLocale["nl-BE"]?.default).toContain("Alleen Nederlandse tekst.");
    expect(out.htmlByLocale["nl-BE"]?.default).toContain("<title>Nieuws</title>");
  });
});
