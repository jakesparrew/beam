/**
 * The home page keeps every line of beam.be's home (docs/research/beam-be/home.md and
 * en-home.md, the crawl of the old site) up to the Google reviews widget. Layout may change,
 * the words may not. A failure names the missing lines.
 */
import { describe, expect, it } from "vitest";
import { missingLines, siteMessages, sourceLines } from "./site-coverage";

describe("home page keeps the story of beam.be", () => {
  it.each([
    ["home.md", 0, "nl-BE"],
    ["en-home.md", 2, "en"],
  ] as const)("%s: no line is missing", (file, i, locale) => {
    const opts = { corrected: [[/fuctioning/g, "functioning"]] as [RegExp, string][], extra: Object.values(siteMessages(locale).site.blocks.reviews ?? {}) };
    expect(sourceLines(file, opts).length).toBeGreaterThan(40);
    expect(missingLines(file, ["home"], i, opts)).toEqual([]);
  });
});
