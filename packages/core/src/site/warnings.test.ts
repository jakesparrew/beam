const randomUUID = (): string => globalThis.crypto.randomUUID();
import { describe, expect, it } from "vitest";
import type { Block } from "./blocks";
import type { VersionContent } from "./completeness";
import { paragraphDoc } from "./rich-text";
import { hasCurrencyAmount, reviewWarnings } from "./warnings";

const block = (t: string): Block => ({ id: randomUUID(), type: "rich_text", doc: paragraphDoc(t) });
const v = (blocks: Block[], path = "dagen", over: Partial<VersionContent> = {}): VersionContent => ({
  title: { "nl-BE": "Dagen" },
  paths: { "nl-BE": path },
  blocks: { "nl-BE": blocks },
  seo: {},
  locales: ["nl-BE"],
  ...over,
});
const codes = (w: { code: string }[]) => w.map((x) => x.code);

describe("reviewWarnings (rule 45)", () => {
  it("flags a currency amount in new text", () => {
    for (const t of ["Een dag kost € 35", "Slechts 35,00 EUR", "Vanaf 35€", "Prijs: 35 euro"]) expect(hasCurrencyAmount(t), t).toBe(true);
    expect(hasCurrencyAmount("Open vanaf 9 uur, 35 plaatsen")).toBe(false);
    const base = v([block("Welkom")]);
    const w = reviewWarnings(base, v([block("Een dag kost € 35")]));
    expect(codes(w)).toContain("currency_in_text");
  });

  it("does not re-flag a price text that the base already had", () => {
    const priced = block("Een dag kost € 35");
    expect(codes(reviewWarnings(v([priced]), v([priced])))).not.toContain("currency_in_text");
  });

  it("flags removed blocks", () => {
    const keep = block("A");
    const gone = block("B");
    const w = reviewWarnings(v([keep, gone]), v([keep]));
    expect(w).toContainEqual(expect.objectContaining({ code: "blocks_removed", locale: "nl-BE" }));
  });

  it("flags a path change", () => {
    const b = block("A");
    expect(codes(reviewWarnings(v([b], "dagen"), v([b], "sauna-dagen")))).toEqual(["path_changed"]);
    expect(reviewWarnings(v([b]), v([b]))).toEqual([]);
  });

  it("flags a changed legal page and long text", () => {
    const b = block("A");
    expect(codes(reviewWarnings(v([b]), v([block("B")]), { isLegal: true }))).toContain("legal_page_changed");
    const hero: Block = { id: randomUUID(), type: "hero", heading: "x".repeat(81) };
    expect(codes(reviewWarnings(null, v([hero])))).toEqual(["text_too_long"]);
  });
});
