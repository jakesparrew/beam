/**
 * The home page keeps every line of beam.be's home (docs/research/beam-be/home.md and
 * en-home.md, the crawl of the old site): headings, paragraphs and list items, up to the Google
 * reviews widget. Layout may change, the words may not. A failure names the missing line.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { seedPageStrings } from "./site";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(path.join(here, rel), "utf8");

/** Lowercase words only: punctuation, markdown marks and line breaks do not count as differences. */
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** Typos of the old site that the new page corrects. */
const CORRECTED: [RegExp, string][] = [[/fuctioning/g, "functioning"]];

/** The text lines of a crawled page, from under its front matter up to the reviews widget. */
function sourceLines(file: string): string[] {
  let body = read(`../../../../docs/research/beam-be/${file}`).replace(/^---[\s\S]*?\n---\n/, "");
  body = body.slice(0, body.indexOf("**Google reviews widget"));
  for (const [typo, fix] of CORRECTED) body = body.replace(typo, fix);
  return body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && l !== "---" && !l.startsWith("![") && !/^(\[[^\]]*\]\([^)]*\)\s*)+$/.test(l)) // rules, images and button rows
    .map((l) => l.replace(/^(#+|-)\s+/, ""));
}

/** What the page shows: the seeded blocks plus the review intro, which the reviews block reads from the messages. */
function pageText(i: number, locale: string): string {
  const messages = JSON.parse(read(`../../../core/src/i18n/messages/${locale}/site.json`)) as { site: { blocks: { reviews: Record<string, string> } } };
  return norm([...seedPageStrings("home", i), ...Object.values(messages.site.blocks.reviews)].join(" "));
}

describe("home page keeps the story of beam.be", () => {
  it.each([
    ["home.md", 0, "nl-BE"],
    ["en-home.md", 2, "en"],
  ] as const)("%s: no line is missing", (file, i, locale) => {
    const text = pageText(i, locale);
    const lines = sourceLines(file);
    expect(lines.length).toBeGreaterThan(40);
    expect(lines.filter((l) => !text.includes(norm(l)))).toEqual([]);
  });
});
