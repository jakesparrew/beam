const randomUUID = (): string => globalThis.crypto.randomUUID();
import { describe, expect, it } from "vitest";
import type { Block } from "./blocks";
import type { VersionContent } from "./completeness";
import { blockFields, diffVersions, diffWords } from "./diff";
import { paragraphDoc } from "./rich-text";

const a: Block = { id: randomUUID(), type: "rich_text", doc: paragraphDoc("De sauna is open") };
const b: Block = { id: randomUUID(), type: "cta", heading: "Boek nu", button: { label: "Boek", link: { kind: "portal", route: "book_day" } } };
const c: Block = { id: randomUUID(), type: "image", mediaId: randomUUID(), caption: "Tuin" };

const v = (blocks: Block[], over: Partial<VersionContent> = {}): VersionContent => ({
  title: { "nl-BE": "Welkom" },
  paths: { "nl-BE": "welkom" },
  blocks: { "nl-BE": blocks },
  seo: { "nl-BE": { title: "Welkom", description: "d" } },
  locales: ["nl-BE"],
  ...over,
});

describe("diffWords", () => {
  it("marks inserted and deleted words", () => {
    expect(diffWords("de sauna is open", "de grote sauna is dicht")).toEqual([
      { op: "eq", text: "de " },
      { op: "ins", text: "grote " },
      { op: "eq", text: "sauna is " },
      { op: "del", text: "open" },
      { op: "ins", text: "dicht" },
    ]);
  });

  it("handles equal and empty texts", () => {
    expect(diffWords("same", "same")).toEqual([{ op: "eq", text: "same" }]);
    expect(diffWords("", "")).toEqual([]);
    expect(diffWords("", "new")).toEqual([{ op: "ins", text: "new" }]);
    expect(diffWords("old", "")).toEqual([{ op: "del", text: "old" }]);
  });
});

describe("diffVersions", () => {
  it("pairs blocks by id: unchanged, changed, inserted, deleted", () => {
    const changed: Block = { ...a, doc: paragraphDoc("De sauna is dicht") };
    const d = diffVersions(v([a, b]), v([changed, c]));
    const blocks = d.byLocale["nl-BE"]!.blocks;
    expect(blocks.map((x) => [x.blockId, x.status])).toEqual([
      [a.id, "changed"],
      [c.id, "inserted"],
      [b.id, "deleted"],
    ]);
    expect(blocks[0]!.fields.find((f) => f.field === "doc")!.segments).toEqual([
      { op: "eq", text: "De sauna is " },
      { op: "del", text: "open" },
      { op: "ins", text: "dicht" },
    ]);
    expect(d.identical).toBe(false);
  });

  it("detects moved blocks without content change", () => {
    const d = diffVersions(v([a, b, c]), v([c, a, b]));
    const blocks = d.byLocale["nl-BE"]!.blocks;
    expect(blocks.every((x) => x.status === "unchanged")).toBe(true);
    expect(blocks.filter((x) => x.moved).map((x) => x.blockId)).toEqual([c.id]);
    expect(d.byLocale["nl-BE"]!.changed).toBe(true);
  });

  it("identical versions are identical; a null base inserts everything", () => {
    expect(diffVersions(v([a, b]), v([a, b])).identical).toBe(true);
    const fresh = diffVersions(null, v([a]));
    expect(fresh.byLocale["nl-BE"]!.blocks[0]!.status).toBe("inserted");
    expect(fresh.addedLocales).toEqual(["nl-BE"]);
  });

  it("diffs title, path and seo, and lists added and removed locales", () => {
    const next = v([a], { title: { "nl-BE": "Welkom thuis", en: "Welcome" }, paths: { "nl-BE": "thuis", en: "home-page" }, locales: ["nl-BE", "en"], blocks: { "nl-BE": [a], en: [a] } });
    const d = diffVersions(v([a]), next);
    expect(d.byLocale["nl-BE"]!.title.changed).toBe(true);
    expect(d.byLocale["nl-BE"]!.path.segments).toEqual([
      { op: "del", text: "welkom" },
      { op: "ins", text: "thuis" },
    ]);
    expect(d.addedLocales).toEqual(["en"]);
    expect(diffVersions(next, v([a])).removedLocales).toEqual(["en"]);
  });

  it("flattens block fields, rich text as plain text", () => {
    expect(blockFields(b)).toEqual({ heading: "Boek nu", "button.label": "Boek", "button.link": JSON.stringify({ kind: "portal", route: "book_day" }) });
  });
});
