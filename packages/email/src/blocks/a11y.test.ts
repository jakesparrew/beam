import { describe, expect, it } from "vitest";
import type { Block, BlockDocument } from "@beam/core/email";
import { LOCALES } from "@beam/core/i18n";
import { BRAND, brandContrastReport, contrastRatio, MIN_BODY_SIZE, MIN_CONTRAST } from "../layout/brand";
import { buildFooter, DEFAULT_FOOTER_SETTINGS } from "../layout/footer";
import { checkAccessibility, checkHtmlAccessibility, isVagueLinkText } from "./a11y";
import { compileMarketing } from "./compile";

const FILE = "33333333-3333-4333-8333-333333333333";
const WORDS = "Our sauna and yoga programme helps you recover from a busy week with calm guided sessions every evening. ".repeat(4);
const doc = (blocks: Block[], locale: "en" | "nl-BE" | "fr-BE" = "en"): BlockDocument => ({ schemaVersion: 1, locales: { [locale]: blocks } });
const codes = (d: BlockDocument, locale: "en" | "nl-BE" | "fr-BE" = "en") => checkAccessibility(d, locale).map((w) => w.code);

describe("checkAccessibility", () => {
  it("warns on a missing alt and on a linked image with empty alt; a decorative image is fine", () => {
    const noAlt = { id: "im00000001", type: "image", fileId: FILE } as unknown as Block;
    const linkedEmpty: Block = { id: "im00000002", type: "image", fileId: FILE, alt: "", href: "https://beam.be/en" };
    const decorative: Block = { id: "im00000003", type: "image", fileId: FILE, alt: "" };
    const text: Block = { id: "tx00000001", type: "text", markdown: WORDS };
    const warnings = checkAccessibility(doc([noAlt, linkedEmpty, decorative, text]), "en");
    expect(warnings.filter((w) => w.code === "missing_alt").map((w) => w.blockId)).toEqual(["im00000001", "im00000002"]);
  });

  it('warns on "click here" link texts in every locale', () => {
    expect(["Click here!", "hier", "Klik hier", "ici", "Cliquez ici", "lees meer"].every(isVagueLinkText)).toBe(true);
    expect(isVagueLinkText("Book your sauna session")).toBe(false);
    const d = doc([
      { id: "tx00000001", type: "text", markdown: `${WORDS} [Click here](https://beam.be/en) or [our programme](https://beam.be/en/p).` },
      { id: "bt00000001", type: "button", label: "Hier", href: "https://beam.be/nl", style: "primary" },
      { id: "pr00000001", type: "product", productId: "11111111-1111-4111-8111-111111111111", showPrice: false, ctaLabel: "ici" },
    ]);
    const vague = checkAccessibility(d, "en").filter((w) => w.code === "vague_link_text");
    expect(vague.map((w) => [w.blockId, w.detail])).toEqual([
      ["tx00000001", "Click here"],
      ["bt00000001", "Hier"],
      ["pr00000001", "ici"],
    ]);
  });

  it("warns when headings skip a level, per dynamic branch", () => {
    const ok = doc([
      { id: "hd00000001", type: "heading", level: 1, text: "Title" },
      { id: "hd00000002", type: "heading", level: 2, text: "Part" },
      { id: "hd00000003", type: "heading", level: 3, text: "Detail" },
      { id: "hd00000004", type: "heading", level: 2, text: "Next part" },
      { id: "tx00000001", type: "text", markdown: WORDS },
    ]);
    expect(codes(ok)).not.toContain("heading_order");
    const skip = doc([
      { id: "hd00000001", type: "heading", level: 1, text: "Title" },
      {
        id: "dy00000001",
        type: "dynamic",
        variants: [{ when: { status: "member" }, blocks: [{ id: "hd00000005", type: "heading", level: 3, text: "Members" }] }],
        fallback: [{ id: "hd00000006", type: "heading", level: 2, text: "Everyone" }],
      },
    ]);
    const warnings = checkAccessibility(skip, "en").filter((w) => w.code === "heading_order");
    expect(warnings.map((w) => w.blockId)).toEqual(["hd00000005"]);
  });

  it("warns on an image-only document (fewer than 50 words with images)", () => {
    const image: Block = { id: "im00000001", type: "image", fileId: FILE, alt: "Winter offer" };
    expect(codes(doc([image]))).toContain("image_heavy");
    expect(codes(doc([image, { id: "tx00000001", type: "text", markdown: WORDS }]))).not.toContain("image_heavy");
    expect(codes(doc([{ id: "tx00000002", type: "text", markdown: "Short note." }]))).not.toContain("image_heavy");
  });

  it.each(LOCALES)("sets the lang attribute and presentation tables for %s", async (locale) => {
    const d = doc([{ id: "tx00000001", type: "text", markdown: WORDS }], locale);
    const footer = buildFooter({
      company: {
        legal_name: "Vibrant Lifestyle Collective BV",
        trade_name: "BEAM Vitality Center",
        vat_number: "BE0123456789",
        address: { street: "Voorbeeldstraat 1", postal_code: "9000", city: "Gent", country: "BE" },
        support_email: "support@demo.beam.be",
      },
      footerSettings: DEFAULT_FOOTER_SETTINGS,
      legalLinks: { privacy: null, terms: null },
      purpose: "events",
      locale,
    });
    const { variants, warnings } = await compileMarketing(d, locale, { footer });
    const html = variants.default?.html ?? "";
    expect(html).toMatch(new RegExp(`<html[^>]*lang="${locale}"[^>]*dir="ltr"`));
    expect(checkHtmlAccessibility(html, locale)).toEqual([]);
    expect(warnings.map((w) => w.code)).not.toContain("missing_lang");
    const other = LOCALES.find((l) => l !== locale) ?? "en";
    expect(checkHtmlAccessibility(html, other).map((w) => w.code)).toEqual(["missing_lang"]);
  });

  it("the brand colours reach a contrast of at least 4.5:1 and body text is at least 14 px", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777777", "#ffffff")).toBeLessThan(MIN_CONTRAST);
    for (const check of brandContrastReport(BRAND)) expect(check.ratio, check.pair).toBeGreaterThanOrEqual(MIN_CONTRAST);
    expect(BRAND.bodySize).toBeGreaterThanOrEqual(MIN_BODY_SIZE);
    const d = doc([{ id: "tx00000001", type: "text", markdown: WORDS }]);
    expect(checkAccessibility(d, "en")).toEqual([]);
    const weak = checkAccessibility(d, "en", { ...BRAND, color: "#c8a24a", bodySize: 12 }).map((w) => w.code);
    expect(weak).toEqual(expect.arrayContaining(["low_contrast", "small_text"]));
  });
});
