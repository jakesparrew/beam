const randomUUID = (): string => globalThis.crypto.randomUUID();
import { describe, expect, it } from "vitest";
import { BLOCK_TYPES, BlockList, BlockSchema, BlocksByLocale, BlockValidationError, MAX_BLOCKS, pageH1, parseBlocks, parseBlocksByLocale, type BlockType } from "./blocks";
import { isSafeHref, LinkSchema, portalPath } from "./links";
import { paragraphDoc, richDocToPlainText, RichDocSchema } from "./rich-text";

const id = () => randomUUID();
const media = randomUUID();
const doc = paragraphDoc("Rust en warmte.");
const pageLink = { kind: "page", pageId: randomUUID() } as const;

const valid: Record<BlockType, Record<string, unknown>> = {
  hero: { type: "hero", heading: "Welkom bij BEAM", subheading: "Sauna en rust", mediaId: media, cta: { label: "Boek", link: { kind: "portal", route: "book_day" } } },
  rich_text: { type: "rich_text", doc },
  image: { type: "image", mediaId: media, caption: "De tuin" },
  image_text: { type: "image_text", mediaId: media, doc, imageSide: "left" },
  cta: { type: "cta", heading: "Klaar?", text: "Kom langs", button: { label: "Meer", link: pageLink } },
  card_grid: { type: "card_grid", heading: "Aanbod", cards: [{ heading: "Dag", text: "Een dag rust", mediaId: media, link: pageLink }] },
  faq: { type: "faq", heading: "Vragen", items: [{ question: "Wat neem ik mee?", answer: doc }] },
  pricing_table: { type: "pricing_table", productIds: [randomUUID()], showMemberPrice: true },
  events_list: { type: "events_list", limit: 6, showFull: true },
  availability_preview: { type: "availability_preview", kind: "day", days: 7 },
  posts_list: { type: "posts_list", limit: 6, paginate: true },
  form_embed: { type: "form_embed", formSlug: "contact" },
  booking_cta: { type: "booking_cta", label: "Boek een nacht", target: { kind: "book_night" } },
  video: { type: "video", youtubeId: "dQw4w9WgXcQ", title: "Rondleiding", posterMediaId: media },
  testimonial: { type: "testimonial", quote: "Heerlijk", authorName: "An", consentConfirmed: true },
  contact_details: { type: "contact_details", showAddress: true, showPhone: true, showEmail: true, showOpeningHours: true },
  map: { type: "map", mediaId: media, linkUrl: "https://maps.example.com/beam" },
  legal_meta: { type: "legal_meta" },
  webinar_signup: { type: "webinar_signup", webinarId: randomUUID() },
};

const invalid: Record<BlockType, Record<string, unknown>> = {
  hero: { type: "hero", heading: "" },
  rich_text: { type: "rich_text", doc: { type: "doc", content: [{ type: "heading", attrs: { level: 1 }, content: [] }] } },
  image: { type: "image", mediaId: "not-a-uuid" },
  image_text: { type: "image_text", mediaId: media, doc, imageSide: "top" },
  cta: { type: "cta", heading: "Klaar?", button: { label: "Meer", link: { kind: "url", href: "javascript:alert(1)" } } },
  card_grid: { type: "card_grid", cards: [] },
  faq: { type: "faq", items: Array.from({ length: 31 }, () => ({ question: "Q", answer: doc })) },
  pricing_table: { type: "pricing_table", productIds: [], showMemberPrice: false },
  events_list: { type: "events_list", limit: 25, showFull: true },
  availability_preview: { type: "availability_preview", kind: "day", days: 15 },
  posts_list: { type: "posts_list", limit: 0, paginate: true },
  form_embed: { type: "form_embed", formSlug: "Contact Form" },
  booking_cta: { type: "booking_cta", label: "Boek", target: { kind: "session" } },
  video: { type: "video", youtubeId: "dQw4w9WgXcQ", title: "Rondleiding" },
  testimonial: { type: "testimonial", quote: "Heerlijk", authorName: "An", consentConfirmed: false },
  contact_details: { type: "contact_details", showAddress: true },
  map: { type: "map", mediaId: media, linkUrl: "http://maps.example.com" },
  legal_meta: { type: "legal_meta", extra: true },
  webinar_signup: { type: "webinar_signup" },
};

describe("block schemas", () => {
  it.each(BLOCK_TYPES)("accepts a valid %s block", (type) => {
    expect(BlockSchema.safeParse({ id: id(), ...valid[type] }).success).toBe(true);
  });

  it.each(BLOCK_TYPES)("rejects an invalid %s block", (type) => {
    expect(BlockSchema.safeParse({ id: id(), ...invalid[type] }).success).toBe(false);
  });

  it("rejects unknown block types and a missing id", () => {
    expect(BlockSchema.safeParse({ id: id(), type: "iframe", src: "https://example.com" }).success).toBe(false);
    expect(BlockSchema.safeParse({ type: "legal_meta" }).success).toBe(false);
  });

  it("rejects javascript: and data: hrefs in links and rich text", () => {
    for (const href of ["javascript:alert(1)", "JavaScript:alert(1)", "data:text/html,x", "//evil.example.com", "http://example.com", " https://x.example.com"]) {
      expect(isSafeHref(href), href).toBe(false);
      expect(LinkSchema.safeParse({ kind: "url", href }).success).toBe(false);
      const linked = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "link", attrs: { href } }] }] }] };
      expect(RichDocSchema.safeParse(linked).success).toBe(false);
    }
    for (const href of ["https://www.beam.be/nl", "mailto:info@example.com", "tel:+3291234567","/nl/over-ons"]) expect(isSafeHref(href), href).toBe(true);
  });

  it("strips Tiptap link attrs it does not store", () => {
    const parsed = RichDocSchema.parse({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "link", attrs: { href: "https://example.com", target: "_blank", rel: null } }] }] }],
    });
    expect(JSON.stringify(parsed)).not.toContain("_blank");
  });

  it("allows a hero only as the first block", () => {
    const hero = { id: id(), ...valid.hero };
    const text = { id: id(), ...valid.rich_text };
    expect(BlockList.safeParse([hero, text]).success).toBe(true);
    expect(BlockList.safeParse([text, hero]).success).toBe(false);
  });

  it("rejects duplicate block ids within a locale", () => {
    const blockId = id();
    expect(BlockList.safeParse([{ id: blockId, ...valid.rich_text }, { id: blockId, ...valid.image }]).success).toBe(false);
  });

  it("caps a locale at 60 blocks", () => {
    const many = (n: number) => Array.from({ length: n }, () => ({ id: id(), ...valid.rich_text }));
    expect(BlockList.safeParse(many(MAX_BLOCKS)).success).toBe(true);
    expect(BlockList.safeParse(many(MAX_BLOCKS + 1)).success).toBe(false);
  });

  it("parseBlocks throws BlockValidationError with the locale; BlocksByLocale rejects unknown locales", () => {
    expect(() => parseBlocks("fr-BE", [{ id: id(), ...invalid.testimonial }])).toThrow(BlockValidationError);
    try {
      parseBlocks("fr-BE", [{ id: id(), ...invalid.video }]);
    } catch (e) {
      expect((e as BlockValidationError).locale).toBe("fr-BE");
    }
    expect(BlocksByLocale.safeParse({ de: [] }).success).toBe(false);
    expect(() => parseBlocksByLocale({ de: [] })).toThrow(BlockValidationError);
    expect(parseBlocksByLocale({ en: [{ id: id(), ...valid.legal_meta }] }).en).toHaveLength(1);
  });

  it("the h1 is the hero heading when the first block is a hero, else the title", () => {
    const hero = parseBlocks("nl-BE", [{ id: id(), ...valid.hero }]);
    expect(pageH1(hero, "Titel")).toBe("Welkom bij BEAM");
    expect(pageH1(parseBlocks("nl-BE", [{ id: id(), ...valid.rich_text }]), "Titel")).toBe("Titel");
  });

  it("rich text renders to plain text with blank lines between blocks", () => {
    const d = RichDocSchema.parse({
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Huisregels" }] },
        { type: "paragraph", content: [{ type: "text", text: "Stilte in de " }, { type: "text", text: "sauna", marks: [{ type: "bold" }] }] },
        { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Handdoek" }] }] }] },
      ],
    });
    expect(richDocToPlainText(d)).toBe("Huisregels\n\nStilte in de sauna\n\n- Handdoek");
  });

  it("builds portal paths per locale", () => {
    expect(portalPath("nl-BE", "book_day")).toBe("/nl/account/book?kind=day");
    expect(portalPath("fr-BE", "home")).toBe("/fr/account");
    expect(portalPath("en", "bookings", { tab: "past" })).toBe("/en/account/bookings?tab=past");
  });
});
