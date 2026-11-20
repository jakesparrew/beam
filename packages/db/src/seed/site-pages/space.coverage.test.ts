/**
 * The environment and technology pages keep every line of beam.be's /omgeving and /technologie
 * (docs/research/beam-be/omgeving.md, en-environment.md, technologie.md, en-technology.md), up to
 * the image list. Layout may change, the words may not. A failure names the missing lines.
 */
import { describe, expect, it } from "vitest";
import { missingLines, sourceLines, type CoverageOptions } from "../site-coverage";

/** Typos of the old Dutch pages that the new pages correct. */
const OMGEVING: CoverageOptions = {
  corrected: [
    [/in synchron gingen/g, "in synchronie gingen"],
    [/werzaam/g, "werkzaam"],
    [/langetermijn dimensie/g, "langetermijndimensie"],
  ],
};
const TECHNOLOGIE: CoverageOptions = { corrected: [[/EESysteem/g, "EESystem"]] };

describe("space pages keep the story of beam.be", () => {
  it.each([
    ["omgeving.md", "environment", 0, OMGEVING],
    ["en-environment.md", "environment", 2, {}],
    ["technologie.md", "technology", 0, TECHNOLOGIE],
    ["en-technology.md", "technology", 2, {}],
  ] as const)("%s: no line is missing", (file, slug, i, opts) => {
    expect(sourceLines(file, opts).length).toBeGreaterThan(40);
    expect(missingLines(file, [slug], i, opts)).toEqual([]);
  });
});
