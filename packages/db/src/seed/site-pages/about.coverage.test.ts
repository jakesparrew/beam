/**
 * The about and founders pages keep every line of beam.be/beam and beam.be/oprichters
 * (docs/research/beam-be/beam.md, en-beam.md, oprichters.md, en-founders.md, the crawl of the
 * old site). Layout may change, the words may not. A failure names the missing lines.
 */
import { describe, expect, it } from "vitest";
import { missingLines, sourceLines, type CoverageOptions } from "../site-coverage";

const ABOUT: CoverageOptions = {
  // The crawl marks the titles of the values accordion with "Q:"; the page shows the titles alone.
  corrected: [[/\*\*Q: /g, "**"]],
  // The partner logo strip (five linked SVG logos, no text) closes the page: crawl stops there.
  stopAt: ["[![](https://beam.be/wp-content/uploads/2026/04/1-1.svg)]"],
};

describe("about pages keep the story of beam.be", () => {
  it.each([
    ["beam.md", "about", 0, ABOUT],
    ["en-beam.md", "about", 2, ABOUT],
    ["oprichters.md", "founders", 0, {}],
    ["en-founders.md", "founders", 2, {}],
  ] as const)("%s: no line is missing", (file, slug, i, opts) => {
    expect(sourceLines(file, opts).length).toBeGreaterThan(slug === "about" ? 50 : 5);
    expect(missingLines(file, [slug], i, opts)).toEqual([]);
  });
});
