/**
 * Accessibility checks of a block document (email spec rule 15b; EN 301 549 / WCAG 2.1 AA as far
 * as email clients allow). Warnings never block publishing; the editor shows them per block.
 *
 * - `missing_alt`: an image without an `alt` string, or a linked image with an empty one
 *   (decorative images use `alt=""` explicitly and are fine when they are not links);
 * - `vague_link_text`: a button, link or card CTA (product, event, webinar) reading "click here", "hier", "ici", ...;
 * - `heading_order`: a heading more than one level below the previous one (h1 -> h3);
 * - `image_heavy`: images with fewer than 50 words of text in the locale;
 * - `low_contrast` and `small_text`: the brand fails 4.5:1 or body text is below 14 px;
 * - `missing_lang`: compiled HTML without `<html lang="<locale>">` (`checkHtmlAccessibility`).
 */
import type { Block, BlockDocument, LeafBlock } from "@beam/core/email";
import type { Locale } from "@beam/core/i18n";
import { BRAND, brandContrastReport, MIN_BODY_SIZE, type Brand } from "../layout/brand";
import { countWords, markdownLinks, markdownToText } from "./markdown";

export type WarningCode =
  | "missing_alt"
  | "vague_link_text"
  | "heading_order"
  | "image_heavy"
  | "low_contrast"
  | "small_text"
  | "missing_lang"
  | "missing_presentation_role"
  | "html_too_large"
  | "product_unavailable"
  | "event_unavailable"
  | "webinar_unavailable";

/** A non-blocking finding; `blockId` points the editor at the block, `variant` at the compiled variant. */
export type Warning = { code: WarningCode; locale: Locale; blockId?: string; variant?: string; detail?: string };

/** Link texts that say nothing about the target (lower case, punctuation stripped). */
export const VAGUE_LINK_TEXTS: readonly string[] = [
  "click here",
  "click",
  "here",
  "this link",
  "link",
  "read more",
  "more",
  "hier",
  "klik hier",
  "klik",
  "deze link",
  "lees meer",
  "meer",
  "ici",
  "cliquez ici",
  "cliquez",
  "ce lien",
  "lire la suite",
  "plus",
  "en savoir plus",
];

/** The minimum words of text a locale needs next to images (rule 15b). */
export const MIN_WORDS_WITH_IMAGES = 50;

export function isVagueLinkText(label: string): boolean {
  const normal = label
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return VAGUE_LINK_TEXTS.includes(normal);
}

/** Every block of a locale in document order, with every dynamic variant and the fallback. */
function flatten(blocks: readonly Block[]): LeafBlock[] {
  const out: LeafBlock[] = [];
  const visit = (list: readonly Block[]) => {
    for (const b of list) {
      if (b.type === "columns") for (const c of b.columns) visit(c.blocks);
      else if (b.type === "dynamic") {
        for (const v of b.variants) visit(v.blocks);
        visit(b.fallback);
      } else out.push(b);
    }
  };
  visit(blocks);
  return out;
}

/** The heading sequences a reader can see: the base path and each dynamic branch on its own. */
function headingSequences(blocks: readonly Block[]): { id: string; level: number }[][] {
  const base: { id: string; level: number }[] = [];
  const branches: { id: string; level: number }[][] = [];
  const headingsOf = (list: readonly Block[]) => flatten(list).flatMap((b) => (b.type === "heading" ? [{ id: b.id, level: b.level }] : []));
  for (const b of blocks) {
    if (b.type === "dynamic") {
      const before = [...base];
      for (const v of b.variants) branches.push([...before, ...headingsOf(v.blocks)]);
      branches.push([...before, ...headingsOf(b.fallback)]);
    } else base.push(...headingsOf([b]));
  }
  return [base, ...branches];
}

/** The document-level checks of one locale (no HTML needed). */
export function checkAccessibility(doc: BlockDocument, locale: Locale, brand: Brand = BRAND): Warning[] {
  const warnings: Warning[] = [];
  const blocks = doc.locales[locale] ?? [];
  const leaves = flatten(blocks);
  let images = 0;
  let words = 0;

  for (const b of leaves) {
    switch (b.type) {
      case "image": {
        images += 1;
        const alt = (b as { alt?: unknown }).alt;
        if (typeof alt !== "string" || (b.href && !alt.trim())) warnings.push({ code: "missing_alt", locale, blockId: b.id });
        else words += countWords(alt);
        break;
      }
      case "heading":
        words += countWords(b.text);
        break;
      case "text":
        words += countWords(markdownToText(b.markdown));
        for (const link of markdownLinks(b.markdown)) {
          if (isVagueLinkText(link.label)) warnings.push({ code: "vague_link_text", locale, blockId: b.id, detail: link.label });
        }
        break;
      case "button":
        words += countWords(b.label);
        if (isVagueLinkText(b.label)) warnings.push({ code: "vague_link_text", locale, blockId: b.id, detail: b.label });
        break;
      case "product":
      case "event":
      case "webinar":
        words += countWords(b.ctaLabel);
        if (isVagueLinkText(b.ctaLabel)) warnings.push({ code: "vague_link_text", locale, blockId: b.id, detail: b.ctaLabel });
        break;
      default:
        break;
    }
  }

  const reported = new Set<string>();
  for (const seq of headingSequences(blocks)) {
    let previous = 0;
    for (const h of seq) {
      if (h.level > previous + 1 && !reported.has(h.id)) {
        reported.add(h.id);
        warnings.push({ code: "heading_order", locale, blockId: h.id, detail: `h${previous || "-"} -> h${h.level}` });
      }
      previous = h.level;
    }
  }

  if (images > 0 && words < MIN_WORDS_WITH_IMAGES) warnings.push({ code: "image_heavy", locale, detail: `${words} words` });

  for (const c of brandContrastReport(brand)) {
    if (!c.ok) warnings.push({ code: "low_contrast", locale, detail: `${c.pair} ${c.ratio.toFixed(2)}:1` });
  }
  if (brand.bodySize < MIN_BODY_SIZE) warnings.push({ code: "small_text", locale, detail: `${brand.bodySize}px` });
  return warnings;
}

/** Checks on compiled HTML: `<html lang>` of the locale and presentation tables. */
export function checkHtmlAccessibility(html: string, locale: Locale): Warning[] {
  const warnings: Warning[] = [];
  const open = /<html\b[^>]*>/i.exec(html)?.[0] ?? "";
  if (!open.includes(`lang="${locale}"`)) warnings.push({ code: "missing_lang", locale });
  const tables = html.match(/<table\b[^>]*>/gi) ?? [];
  if (tables.some((t) => !/role="presentation"/i.test(t))) warnings.push({ code: "missing_presentation_role", locale });
  return warnings;
}
