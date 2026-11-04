import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { localeFromCode, parseWxr, wxrCdnOrigins } from "./wxr";

const xml = readFileSync(new URL("./__fixtures__/beam-sample.wxr.xml", import.meta.url), "utf8");

describe("parseWxr", () => {
  const { items, errors } = parseWxr(xml);

  it("counts the fixture's pages, posts and attachments and ignores other post types", () => {
    expect(errors).toEqual([]);
    const count = (t: string) => items.filter((i) => i.wpType === t).length;
    expect({ pages: count("page"), posts: count("post"), attachments: count("attachment") }).toEqual({ pages: 10, posts: 4, attachments: 6 });
    expect(items.find((i) => i.wpId === 90)).toBeUndefined();
  });

  it("never returns authors or comments", () => {
    const dump = JSON.stringify(items);
    for (const secret of ["author@example.com", "Author Demo", "beamadmin", "commenter@example.com", "Commenter Demo", "192.0.2.7", "private comment text"]) {
      expect(dump).not.toContain(secret);
    }
    for (const item of items) expect(Object.keys(item).sort()).not.toEqual(expect.arrayContaining(["author", "comments"]));
  });

  it("reads WPML and Polylang locales and translation groups", () => {
    const by = (id: number) => items.find((i) => i.wpId === id)!;
    expect(by(10)).toMatchObject({ locale: "nl-BE", translationGroup: "101", title: "Over ons", wpPath: "/over-ons", slug: "over-ons" });
    expect(by(11)).toMatchObject({ locale: "fr-BE", translationGroup: "101", title: "À propos", wpPath: "/fr/a-propos" });
    expect(by(20)).toMatchObject({ locale: "nl-BE", translationGroup: "pll_65a1" });
    expect(by(21)).toMatchObject({ locale: "fr-BE", translationGroup: "pll_65a1" });
    expect(by(22)).toMatchObject({ translationGroup: null, publishedAt: new Date("2024-03-01T09:00:00Z") });
    const groups = new Set(items.filter((i) => i.wpType === "page").map((i) => i.translationGroup));
    expect(groups.size).toBe(5);
  });

  it("drafts default to skip; published items and inherit attachments to import", () => {
    const draft = items.find((i) => i.wpId === 23)!;
    expect(draft).toMatchObject({ wpStatus: "draft", decision: "skip", publishedAt: null, wpPath: "/?p=23" });
    expect(items.filter((i) => i.decision === "skip").map((i) => i.wpId)).toEqual([23]);
    expect(items.find((i) => i.wpId === 30)).toMatchObject({ wpStatus: "inherit", decision: "import", parentWpId: 10, attachmentUrl: "https://www.beam.be/wp-content/uploads/2024/01/pool.jpg", contentHtml: null });
  });

  it("lists the CDN origin of attachments on another host", () => {
    expect(wxrCdnOrigins(items, "https://www.beam.be")).toEqual(["https://cdn.beam.be"]);
  });

  it("reports the line of malformed XML", () => {
    const broken = "<?xml version=\"1.0\"?>\n<rss>\n<channel>\n<item><title>x</title>\n</channel>\n</rss>";
    const out = parseWxr(broken);
    expect(out.items).toEqual([]);
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]!.line).toBe(5);
    expect(out.errors[0]!.message).toMatch(/item|channel/i);
  });

  it("refuses a file that is not a WordPress export", () => {
    expect(parseWxr("<html><body/></html>").errors[0]!.message).toMatch(/rss/);
  });

  it("maps language codes", () => {
    expect([localeFromCode("nl"), localeFromCode("fr_BE"), localeFromCode("en-GB"), localeFromCode("de")]).toEqual(["nl-BE", "fr-BE", "en", null]);
  });
});
