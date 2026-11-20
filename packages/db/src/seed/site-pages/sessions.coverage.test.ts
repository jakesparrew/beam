/**
 * The session pages keep every line of beam.be's /sessies/ (docs/research/beam-be/sessies.md and
 * en-sessions.md) across day sessions, nights and pricing, and the membership page every line of
 * /membership/ (membership.md, en-membership.md). Layout may change, the words may not. Checked
 * with the catalogue (live price cards, what `seedPageStrings` builds) and without it (prices as text),
 * and both builds must pass the strict block schema.
 */
import { describe, expect, it } from "vitest";
import { BlockList } from "@beam/core/site";
import { seedUuid } from "../site";
import { missingLines, sourceLines, type CoverageOptions } from "../site-coverage";
import type { BuildCtx } from "../site-kit";
import { PAGES } from "./sessions";

const SESSION_PAGES = ["day-sessions", "nights", "pricing"];

/** Notes of the crawl on the old price-table widget (tabs) and typos of the old site. */
const CORRECTED: [RegExp, string][] = [
  // Price tables hidden on the live site (display:none, an old promotion): never shown, not carried over.
  [/\*\*\[HIDDEN ON LIVE SITE[\s\S]*?HIDDEN ON LIVE SITE - end\]\*\*/, ""],
  // "#### Tab: Nachtsessies >": the tab label is the heading of that price list on the pricing page.
  [/^#### Tab: (.*?) >$/gm, "#### $1"],
  // "#### Price table: 10 uren pakket": the table name is the label of its line in the price list.
  [/^#### Price table: /gm, "#### "],
  // "Ribbon: Populair": the ribbon is the word "populair" on that line.
  [/^Ribbon: /gm, ""],
  // Typo of en-sessions.md: "from 20pm to 8am".
  [/from 20pm to 8am/, "from 8pm to 8am"],
  // en-membership.md repeats the first step's sentence with no space between ("BEAM.Each member").
  [/BEAM\.Each member receives a personal BEAM Membership Card, a physical card that symbolises your connection to the field of BEAM\./, "BEAM."],
];

const SKIP = [
  // The old price widget's instruction to click a tab: every price list shows at once now.
  "Klik op het type pakket om de inhoud en de prijzen ervan te zien:",
  "Click on the package type to view its contents and prices:",
];

/**
 * "**Price: €1260 bespaar €900**": the amount is the live catalogue price of the price cards
 * (`pricing_table`), never typed on the page; the saving is on that table's line of the price list.
 */
const priceLines = (file: string) => sourceLines(file, { corrected: CORRECTED }).filter((l) => l.startsWith("**Price:"));

const options = (file: string): CoverageOptions => ({ corrected: CORRECTED, skip: [...SKIP, ...priceLines(file)] });

/** The blocks of a page of this group, with (`catalogue`) or without the catalogue products. */
function build(slug: string, i: number, catalogue: boolean) {
  const stub = seedUuid("stub");
  const c: BuildCtx = { id: (part) => seedUuid(`${slug}:${i}:${part}`), page: () => ({ kind: "page", pageId: stub }), product: () => (catalogue ? stub : undefined), media: () => stub };
  return PAGES[slug]!.build(i, c);
}

/** Every string of the blocks except structural keys (as `seedPageStrings` reads them). */
const strings = (v: unknown): string[] =>
  typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => (["id", "type", "marks", "attrs"].includes(k) ? [] : strings(x))) : [];

const CASES = [
  ["sessies.md", 0, SESSION_PAGES],
  ["en-sessions.md", 2, SESSION_PAGES],
  ["membership.md", 0, ["memberships"]],
  ["en-membership.md", 2, ["memberships"]],
] as const;

describe("session pages keep the story of beam.be", () => {
  it.each(CASES)("%s: no line is missing with the catalogue", (file, i, slugs) => {
    const opts = options(file);
    expect(sourceLines(file, opts).length).toBeGreaterThan(file.includes("membership") ? 25 : 90);
    expect(missingLines(file, [...slugs], i, opts)).toEqual([]);
  });

  it.each(CASES)("%s: no line is missing without the catalogue", (file, i, slugs) => {
    const extra = slugs.flatMap((s) => strings(build(s, i, false)));
    expect(missingLines(file, [], i, { ...options(file), extra })).toEqual([]);
  });

  it("every page passes the block schema in all locales, with and without the catalogue", () => {
    for (const slug of Object.keys(PAGES))
      for (const i of [0, 1, 2])
        for (const catalogue of [true, false]) {
          const parsed = BlockList.safeParse(build(slug, i, catalogue));
          expect(parsed.success, `${slug} ${i} ${catalogue}: ${parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 3))}`).toBe(true);
        }
  });
});
