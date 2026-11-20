/**
 * The corporate pages keep every line of beam.be/bedrijven (+ /en/corporates),
 * /corporate-reset-day, /corporate-venue and /discovery-experience (docs/research/beam-be/, the
 * crawl of the old site). The last three existed in Dutch only, so only nl is checked for them.
 * Layout may change, the words may not. A failure names the missing lines.
 */
import { describe, expect, it } from "vitest";
import { missingLines, sourceLines, type CoverageOptions } from "../site-coverage";

const fix = (...pairs: [RegExp, string][]): CoverageOptions => ({ corrected: pairs });

describe("corporate pages keep the story of beam.be", () => {
  it.each([
    ["bedrijven.md", "corporate", 0, fix([/iznet/g, "inzet"])],
    ["en-corporates.md", "corporate", 2, fix([/ornaganisations/g, "organisations"])],
    ["corporate-reset-day.md", "corporate-reset-day", 0, {}],
    // Word breaks left in the old text ("bedrijfs-presentaties") and a missing article.
    ["corporate-venue.md", "corporate-venue", 0, fix([/biedt unieke/g, "biedt een unieke"], [/bedrijfs-presentaties/g, "bedrijfspresentaties"], [/bijeen-komsten/g, "bijeenkomsten"])],
    ["discovery-experience.md", "discovery-experience", 0, fix([/generern/g, "genereren"])],
  ] as const)("%s: no line is missing", (file, slug, i, opts) => {
    expect(sourceLines(file, opts).length).toBeGreaterThan(30);
    expect(missingLines(file, [slug], i, opts)).toEqual([]);
  });
});
