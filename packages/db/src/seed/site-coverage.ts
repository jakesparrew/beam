/**
 * Test helper: which lines of a crawled beam.be page (`docs/research/beam-be/<file>.md`) a seeded
 * page does not show. Lines are compared as lowercase words, so punctuation, markdown marks and
 * line breaks do not count; buttons, images and rules are skipped, and the crawl stops at the
 * first marker in `stopAt` (a widget, a form, the image list).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seedPageStrings } from "./site";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "../../../..");

export const normWords = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

export type CoverageOptions = {
  /** The crawl is read up to the first line that starts with one of these (default: the image list and the reviews widget). */
  stopAt?: string[];
  /** Typos of the old site the new page corrects. */
  corrected?: [RegExp, string][];
  /** Extra text the page shows outside its blocks (messages of a block), joined to the page text. */
  extra?: string[];
  /** Lines of the crawl that are deliberately not on the page (navigation leftovers, a form's field labels). */
  skip?: string[];
};

const DEFAULT_STOP = ["## Images on this page", "**Google reviews widget", "## Background images", "## External / booking links", "## Popups"];

/** The text lines of a crawled page, from under its front matter up to the first stop marker. */
export function sourceLines(file: string, opts: CoverageOptions = {}): string[] {
  let body = readFileSync(path.join(repo, "docs/research/beam-be", file), "utf8").replace(/^---[\s\S]*?\n---\n/, "");
  const stops = [...DEFAULT_STOP, ...(opts.stopAt ?? [])].map((m) => body.indexOf(m)).filter((n) => n >= 0);
  if (stops.length) body = body.slice(0, Math.min(...stops));
  for (const [typo, fix] of opts.corrected ?? []) body = body.replace(typo, fix);
  const skip = new Set((opts.skip ?? []).map(normWords));
  return body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && l !== "---" && !l.startsWith("![") && !/^(\[[^\]]*\]\([^)]*\)\s*)+$/.test(l))
    .map((l) => l.replace(/^(#+|-|\*|>|\d+\.)\s+/, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1"))
    .filter((l) => normWords(l) && !skip.has(normWords(l)));
}

/** The lines of `file` that none of the seeded pages `slugs` shows in locale index `i` (0 nl-BE, 1 fr-BE, 2 en). */
export function missingLines(file: string, slugs: string[], i: number, opts: CoverageOptions = {}): string[] {
  const text = normWords([...slugs.flatMap((s) => seedPageStrings(s, i)), ...(opts.extra ?? [])].join(" "));
  return sourceLines(file, opts).filter((l) => !text.includes(normWords(l)));
}

/** The site messages of a locale (`packages/core/src/i18n/messages/<locale>/site.json`). */
export function siteMessages(locale: "nl-BE" | "fr-BE" | "en"): { site: { blocks: Record<string, Record<string, string>> } } {
  return JSON.parse(readFileSync(path.join(repo, `packages/core/src/i18n/messages/${locale}/site.json`), "utf8")) as { site: { blocks: Record<string, Record<string, string>> } };
}
