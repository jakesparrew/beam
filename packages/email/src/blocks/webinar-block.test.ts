/**
 * email-P8: the `webinar` block (email spec section 12, R2): title, Brussels date and time and a
 * button to the webinar's landing page, from `webinar.getWebinarCards`; a webinar without a card
 * (unknown, draft, cancelled or archived) renders nothing.
 */
import { describe, expect, it, vi } from "vitest";
import { validateDocument, type Block, type BlockDocument, type WebinarBlock } from "@beam/core/email";
import { formatDateTime } from "@beam/core/i18n";
import { buildFooter, DEFAULT_FOOTER_SETTINGS } from "../layout/footer";
import { compileDocument, compileMarketing } from "./compile";
import { blocksToMjml, cardRefs, type ResolvedCards, type WebinarCard } from "./to-mjml";
import { blocksToText } from "./to-text";

const WEBINAR = "44444444-4444-4444-8444-444444444444";
const MISSING = "55555555-5555-4555-8555-555555555555";
const STARTS_AT = new Date("2026-12-10T19:00:00.000Z");

const COMPANY = {
  legal_name: "Vibrant Lifestyle Collective BV",
  trade_name: "BEAM Vitality Center",
  vat_number: "BE0123456789",
  address: { street: "Voorbeeldstraat 1", postal_code: "9000", city: "Gent", country: "BE" },
  support_email: "support@demo.beam.be",
};
const footerFor = (locale: "en" | "nl-BE" | "fr-BE") =>
  buildFooter({
    company: COMPANY,
    footerSettings: DEFAULT_FOOTER_SETTINGS,
    legalLinks: { privacy: "https://beam.be/en/privacy", terms: "https://beam.be/en/terms" },
    purpose: "events",
    locale,
  });

const card = (overrides: Partial<WebinarCard> = {}): WebinarCard => ({
  id: WEBINAR,
  title: "Sleep better in winter",
  startsAt: STARTS_AT,
  landingUrl: "https://beam.be/en/webinars/sleep-better",
  ...overrides,
});

const webinarBlock = (webinarId = WEBINAR): WebinarBlock => ({ id: "wb00000001", type: "webinar", webinarId, ctaLabel: "Save my seat" });
const doc = (blocks: Block[]): BlockDocument => ({ schemaVersion: 1, locales: { en: blocks } });
const cards = (webinars: Record<string, WebinarCard>): ResolvedCards => ({ products: {}, events: {}, webinars });

describe("webinar block: document", () => {
  it("is a valid leaf block, also inside columns and dynamic branches", () => {
    const blocks: Block[] = [
      webinarBlock(),
      { id: "co00000001", type: "columns", stackOnMobile: true, columns: [{ width: 50, blocks: [{ ...webinarBlock(), id: "wb00000002" }] }, { width: 50, blocks: [] }] },
      { id: "dy00000001", type: "dynamic", variants: [{ when: { status: "lead" }, blocks: [{ ...webinarBlock(), id: "wb00000003" }] }], fallback: [] },
    ];
    expect(validateDocument(doc(blocks))).toEqual({ ok: true });
    expect(cardRefs([blocks]).webinarIds).toEqual([WEBINAR]);
  });

  it("refuses a webinar id that is not a uuid and an unknown field", () => {
    expect(validateDocument({ schemaVersion: 1, locales: { en: [{ ...webinarBlock(), webinarId: "nope" }] } }).ok).toBe(false);
    expect(validateDocument({ schemaVersion: 1, locales: { en: [{ ...webinarBlock(), url: "https://beam.be" }] } }).ok).toBe(false);
  });
});

describe("webinar block: render", () => {
  it("renders title, Brussels date and time and the landing page button in HTML and text", async () => {
    const result = await compileMarketing(doc([{ id: "hd00000001", type: "heading", level: 1, text: "Join us" }, webinarBlock()]), "en", {
      footer: footerFor("en"),
      resolveCards: () => cards({ [WEBINAR]: card() }),
    });
    const { html, text } = result.variants.default!;
    expect(html).toContain("Sleep better in winter");
    expect(html).toContain(formatDateTime(STARTS_AT, "en", "long"));
    expect(html).toContain('href="https://beam.be/en/webinars/sleep-better"');
    expect(html).toContain("Save my seat");
    expect(text).toContain("Sleep better in winter");
    expect(text).toContain("Save my seat (https://beam.be/en/webinars/sleep-better)");
    expect(result.warnings.map((w) => w.code)).not.toContain("event_unavailable");
  });

  it("formats the date in the recipient's locale", async () => {
    const nl: BlockDocument = { schemaVersion: 1, locales: { "nl-BE": [{ ...webinarBlock(), ctaLabel: "Reserveer mijn plaats" }] } };
    const result = await compileMarketing(nl, "nl-BE", { footer: footerFor("nl-BE"), resolveCards: () => cards({ [WEBINAR]: card({ title: "Beter slapen in de winter" }) }) });
    expect(result.variants.default!.html).toContain(formatDateTime(STARTS_AT, "nl-BE", "long"));
    expect(result.variants.default!.html).toContain("Reserveer mijn plaats");
  });

  it("leaves the date out of an on-demand webinar without a start time", () => {
    const mjml = blocksToMjml([webinarBlock()], { locale: "en", cards: cards({ [WEBINAR]: card({ startsAt: null }) }) });
    expect(mjml).toContain("Sleep better in winter");
    expect(mjml).not.toContain("2026");
  });

  it("loads the cards through the webinars loader (getWebinarCards) once per compile, with the locale", async () => {
    const loader = vi.fn(async (ids: string[], locale: string) => ids.filter((id) => id === WEBINAR).map(() => card({ title: `Webinar (${locale})` })));
    const out = await compileDocument(
      { schemaVersion: 1, locales: { en: [webinarBlock()], "fr-BE": [{ ...webinarBlock(), ctaLabel: "Réserver ma place" }] } },
      ["en", "fr-BE"],
      { footerFor, webinars: loader },
    );
    expect(loader).toHaveBeenCalledTimes(2);
    expect(loader).toHaveBeenCalledWith([WEBINAR], "en");
    expect(loader).toHaveBeenCalledWith([WEBINAR], "fr-BE");
    expect(out.htmlByLocale.en!.default).toContain("Webinar (en)");
    expect(out.htmlByLocale["fr-BE"]!.default).toContain("Webinar (fr-BE)");
  });
});

describe("webinar block: missing webinar", () => {
  it("renders nothing and warns when the webinar has no card", async () => {
    const result = await compileMarketing(doc([{ id: "tx00000001", type: "text", markdown: "Our next online session." }, webinarBlock(MISSING)]), "en", {
      footer: footerFor("en"),
      resolveCards: () => cards({ [WEBINAR]: card() }),
    });
    const { html, text } = result.variants.default!;
    expect(html).toContain("Our next online session.");
    expect(html).not.toContain("Save my seat");
    expect(text).not.toContain("Save my seat");
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "event_unavailable", blockId: "wb00000001", detail: MISSING }));
  });

  it("renders nothing without any webinar cards (no loader given)", () => {
    expect(blocksToMjml([webinarBlock()], { locale: "en" })).toBe("");
    expect(blocksToText([webinarBlock()], { locale: "en", cards: { products: {}, events: {} } })).toBe("");
  });

  it("a column holding only a missing webinar still compiles under strict MJML", async () => {
    const blocks: Block[] = [
      { id: "co00000001", type: "columns", stackOnMobile: true, columns: [{ width: 50, blocks: [webinarBlock(MISSING)] }, { width: 50, blocks: [{ id: "tx00000001", type: "text", markdown: "Right." }] }] },
    ];
    const result = await compileMarketing(doc(blocks), "en", { footer: footerFor("en"), webinars: async () => [] });
    expect(result.variants.default!.html).toContain("Right.");
  });
});
