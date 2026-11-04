const randomUUID = (): string => globalThis.crypto.randomUUID();
import { describe, expect, it } from "vitest";
import type { Block } from "./blocks";
import { checkPublishable, collectRefs, issuesByLocale, PUBLISH_ISSUE_CODES, type PublishIssue, type RefFacts, type VersionContent } from "./completeness";
import { paragraphDoc } from "./rich-text";

const pageId = randomUUID();
const img = randomUUID();
const desc = "Een rustige dag in de sauna met tuin, warmte en stilte voor iedereen.";

const text = (t = "Tekst"): Block => ({ id: randomUUID(), type: "rich_text", doc: paragraphDoc(t) });

function version(over: Partial<VersionContent> = {}): VersionContent {
  return {
    title: { "nl-BE": "Over ons", "fr-BE": "À propos", en: "About" },
    paths: { "nl-BE": "over-ons", "fr-BE": "a-propos", en: "about" },
    blocks: { "nl-BE": [text()], "fr-BE": [text()], en: [text()] },
    seo: {
      "nl-BE": { title: "Over ons", description: desc },
      "fr-BE": { title: "À propos", description: desc },
      en: { title: "About", description: desc },
    },
    locales: ["nl-BE", "fr-BE", "en"],
    ...over,
  };
}

function refs(over: Partial<RefFacts> = {}): RefFacts {
  return {
    page: { id: pageId, kind: "standard", legalKey: null, sessionId: null },
    media: {},
    forms: {},
    products: {},
    sessions: {},
    pages: {},
    webinars: {},
    takenPaths: {},
    legalName: "Vibrant Lifestyle Collective BV",
    ...over,
  };
}

const codes = (issues: PublishIssue[]) => issues.map((i) => i.code);
const forLocale = (issues: PublishIssue[], l: string) => issues.filter((i) => i.locale === l).map((i) => i.code);

describe("checkPublishable", () => {
  it("a complete version has no issues", () => {
    expect(checkPublishable(version(), refs())).toEqual([]);
  });

  it("checks only the version's locales", () => {
    const v = version({ locales: ["nl-BE"], title: { "nl-BE": "Over ons" }, paths: { "nl-BE": "over-ons" } });
    expect(checkPublishable(v, refs())).toEqual([]);
    expect(codes(checkPublishable(version({ locales: [] }), refs()))).toContain("locales_empty");
  });

  it("title missing or too long, per locale", () => {
    const issues = checkPublishable(version({ title: { "nl-BE": "x".repeat(121), en: "About" } }), refs());
    expect(forLocale(issues, "nl-BE")).toContain("title_too_long");
    expect(forLocale(issues, "fr-BE")).toContain("title_missing");
    expect(forLocale(issues, "en")).not.toContain("title_missing");
  });

  it("path issues: missing, invalid, reserved, home only, taken by another page", () => {
    const v = version({ paths: { "nl-BE": "Over Ons", "fr-BE": "account", en: "" } });
    const issues = checkPublishable(v, refs());
    expect(forLocale(issues, "nl-BE")).toContain("path_invalid");
    expect(forLocale(issues, "fr-BE")).toContain("path_reserved");
    expect(forLocale(issues, "en")).toContain("path_home_only");
    expect(codes(checkPublishable(version({ paths: { "nl-BE": "over-ons" } }), refs()))).toContain("path_missing");
    const other = randomUUID();
    const taken = checkPublishable(version(), refs({ takenPaths: { "fr-BE:a-propos": other, "nl-BE:over-ons": pageId } }));
    expect(taken).toEqual([expect.objectContaining({ code: "path_taken", locale: "fr-BE" })]);
  });

  it("seo title 1-70 and description 50-170", () => {
    const v = version({ seo: { "nl-BE": { title: "", description: desc }, "fr-BE": { title: "x".repeat(71), description: "kort" }, en: { title: "About", description: "x".repeat(171) } } });
    const issues = checkPublishable(v, refs());
    expect(forLocale(issues, "nl-BE")).toEqual(["seo_title_length"]);
    expect(forLocale(issues, "fr-BE")).toEqual(["seo_title_length", "seo_description_length"]);
    expect(forLocale(issues, "en")).toEqual(["seo_description_length"]);
  });

  it("blocks: empty, invalid (with block id)", () => {
    const bad = { id: randomUUID(), type: "testimonial", quote: "Q", authorName: "A", consentConfirmed: false } as unknown as Block;
    const issues = checkPublishable(version({ blocks: { "nl-BE": [], "fr-BE": [bad], en: [text()] } }), refs());
    expect(forLocale(issues, "nl-BE")).toContain("blocks_empty");
    expect(issues).toContainEqual(expect.objectContaining({ code: "block_invalid", locale: "fr-BE", blockId: bad.id }));
    const tooMany = Array.from({ length: 61 }, () => text());
    expect(codes(checkPublishable(version({ blocks: { "nl-BE": tooMany, "fr-BE": [text()], en: [text()] } }), refs()))).toContain("blocks_too_many");
  });

  it("alt text per locale for non-decorative images; decorative needs none; unknown media is missing", () => {
    const image: Block = { id: randomUUID(), type: "image", mediaId: img };
    const v = version({ blocks: { "nl-BE": [image], "fr-BE": [image], en: [image] } });
    const issues = checkPublishable(v, refs({ media: { [img]: { alt: { "nl-BE": "Tuin", en: "  " }, isDecorative: false } } }));
    expect(issues.filter((i) => i.code === "alt_missing").map((i) => i.locale)).toEqual(["fr-BE", "en"]);
    expect(checkPublishable(v, refs({ media: { [img]: { alt: {}, isDecorative: true } } }))).toEqual([]);
    expect(codes(checkPublishable(v, refs()))).toContain("media_missing");
    const cover = checkPublishable(version({ coverMediaId: img }), refs({ media: { [img]: { alt: { "nl-BE": "x", "fr-BE": "x" }, isDecorative: false } } }));
    expect(cover).toEqual([expect.objectContaining({ code: "alt_missing", locale: "en" })]);
  });

  it("posts, events and landing pages need an excerpt per locale", () => {
    const post = refs({ page: { id: pageId, kind: "post", legalKey: null, sessionId: null } });
    expect(codes(checkPublishable(version(), post)).filter((c) => c === "excerpt_missing")).toHaveLength(3);
    expect(checkPublishable(version({ excerpt: { "nl-BE": "a", "fr-BE": "b", en: "c" } }), post)).toEqual([]);
    expect(codes(checkPublishable(version(), refs({ page: { id: pageId, kind: "landing", legalKey: null, sessionId: null } })))).toContain("excerpt_missing");
  });

  it("event pages need an existing event session", () => {
    const sessionId = randomUUID();
    const ev = (sid: string | null) => refs({ page: { id: pageId, kind: "event", legalKey: null, sessionId: sid } });
    const excerpt = { "nl-BE": "a", "fr-BE": "b", en: "c" };
    expect(codes(checkPublishable(version({ excerpt }), ev(null)))).toEqual(["event_session_missing"]);
    expect(codes(checkPublishable(version({ excerpt }), { ...ev(sessionId), sessions: { [sessionId]: { kind: "day" } } }))).toEqual(["event_session_missing"]);
    expect(checkPublishable(version({ excerpt }), { ...ev(sessionId), sessions: { [sessionId]: { kind: "event" } } })).toEqual([]);
  });

  it("cross-module references: forms, products, sessions, webinars, page links", () => {
    const productId = randomUUID();
    const sessionId = randomUUID();
    const webinarId = randomUUID();
    const target = randomUUID();
    const blocks: Block[] = [
      { id: randomUUID(), type: "form_embed", formSlug: "contact" },
      { id: randomUUID(), type: "pricing_table", productIds: [productId], showMemberPrice: true },
      { id: randomUUID(), type: "booking_cta", label: "Boek", target: { kind: "session", sessionId } },
      { id: randomUUID(), type: "webinar_signup", webinarId },
      { id: randomUUID(), type: "cta", heading: "Meer", button: { label: "Ga", link: { kind: "page", pageId: target } } },
    ];
    const v = version({ locales: ["nl-BE"], title: { "nl-BE": "x" }, paths: { "nl-BE": "x" }, blocks: { "nl-BE": blocks } });
    expect(codes(checkPublishable(v, refs()))).toEqual(["form_unavailable", "product_missing", "session_missing", "webinar_unavailable", "link_target_unavailable"]);
    const good = refs({
      forms: { contact: { locales: ["nl-BE", "en"] } },
      products: { [productId]: { isActive: true } },
      sessions: { [sessionId]: { kind: "event" } },
      webinars: { [webinarId]: true },
      pages: { [target]: { status: "archived", hasRedirect: true } },
    });
    expect(checkPublishable(v, good)).toEqual([]);
    expect(codes(checkPublishable(v, { ...good, products: { [productId]: { isActive: false } } }))).toEqual(["product_inactive"]);
    expect(codes(checkPublishable(v, { ...good, forms: { contact: { locales: ["en"] } } }))).toEqual(["form_locale_missing"]);
    expect(codes(checkPublishable(v, { ...good, pages: { [target]: { status: "draft", hasRedirect: false } } }))).toEqual(["link_target_unavailable"]);
  });

  it("legal_meta only on legal pages", () => {
    const v = version({ locales: ["en"], title: { en: "x" }, paths: { en: "x" }, blocks: { en: [{ id: randomUUID(), type: "legal_meta" }] } });
    expect(codes(checkPublishable(v, refs()))).toEqual(["legal_meta_not_legal"]);
    expect(checkPublishable(v, refs({ page: { id: pageId, kind: "legal", legalKey: "terms", sessionId: null } }))).toEqual([]);
  });

  it("the privacy notice names the controller's legal name in every locale", () => {
    const legal = refs({ page: { id: pageId, kind: "legal", legalKey: "privacy_notice", sessionId: null } });
    const v = version({
      blocks: {
        "nl-BE": [text("Verwerkingsverantwoordelijke: Vibrant Lifestyle Collective BV")],
        "fr-BE": [text("Responsable du traitement : BEAM")],
        en: [text("Controller: Vibrant Lifestyle Collective BV, Gent")],
      },
    });
    expect(checkPublishable(v, legal)).toEqual([expect.objectContaining({ code: "legal_name_missing", locale: "fr-BE" })]);
    expect(codes(checkPublishable(v, { ...legal, legalName: null })).filter((c) => c === "legal_name_missing")).toHaveLength(3);
  });

  it("every issue code is listed once and badges count per locale", () => {
    expect(new Set(PUBLISH_ISSUE_CODES).size).toBe(PUBLISH_ISSUE_CODES.length);
    const issues = checkPublishable(version({ title: {} }), refs());
    expect(issuesByLocale(issues)).toEqual({ "nl-BE": 1, "fr-BE": 1, en: 1 });
  });
});

describe("collectRefs", () => {
  it("collects every reference once across locales, cover and og image", () => {
    const productId = randomUUID();
    const og = randomUUID();
    const v = version({
      coverMediaId: img,
      seo: { en: { title: "t", description: desc, ogImageMediaId: og } },
      blocks: {
        "nl-BE": [{ id: randomUUID(), type: "pricing_table", productIds: [productId], showMemberPrice: false }, { id: randomUUID(), type: "form_embed", formSlug: "contact" }],
        en: [{ id: randomUUID(), type: "booking_cta", label: "Buy", target: { kind: "buy_product", productId } }, { id: randomUUID(), type: "video", youtubeId: "dQw4w9WgXcQ", title: "t", posterMediaId: img }],
      },
    });
    const r = collectRefs(v);
    expect(r.productIds).toEqual([productId]);
    expect(r.formSlugs).toEqual(["contact"]);
    expect(r.mediaIds.sort()).toEqual([img, og].sort());
    expect(r.sessionIds).toEqual([]);
  });
});
