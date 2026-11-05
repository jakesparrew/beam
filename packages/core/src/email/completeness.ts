/**
 * Translation completeness of a template version (email spec rules 10, 26 and 30). Pure.
 *
 * A version is complete in a locale when `subject`, `preheader` and every text slot have a
 * non-blank value there: the `copy` slots of a code-backed template, or every text field of the
 * block document of that locale (heading text, text markdown, button label, product, event and
 * webinar CTA labels; an image `alt` of `""` is an explicit decorative image and counts as present).
 */
import { LOCALES, type Locale } from "../i18n/locales";
import type { LocalizedText } from "../i18n/localized-text";
import { walkBlocks, type Block, type BlockDocument } from "./blocks";

export type CompletenessInput = {
  subject: LocalizedText | null | undefined;
  preheader: LocalizedText | null | undefined;
  document?: BlockDocument | null;
  copy?: Record<string, LocalizedText> | null;
};

export type LocaleCompleteness = { locale: Locale; missing: string[] };

const blank = (v: unknown) => typeof v !== "string" || v.trim().length === 0;

/** The text fields of one block that must be filled (`[field, value]`). */
function textFields(block: Block): [string, unknown][] {
  switch (block.type) {
    case "heading":
      return [["text", block.text]];
    case "text":
      return [["markdown", block.markdown]];
    case "button":
      return [["label", block.label]];
    case "product":
    case "event":
    case "webinar":
      return [["ctaLabel", block.ctaLabel]];
    case "image":
      return typeof block.alt === "string" ? [] : [["alt", block.alt]];
    default:
      return [];
  }
}

/** Missing block texts of one locale's blocks, as `blocks.<blockId>.<field>`. */
export function missingBlockTexts(blocks: readonly Block[]): string[] {
  const missing: string[] = [];
  walkBlocks(blocks, (block) => {
    for (const [field, value] of textFields(block)) if (blank(value)) missing.push(`blocks.${block.id}.${field}`);
  });
  return missing;
}

/**
 * Per requested locale, the paths that are missing: `subject`, `preheader`, `document` (no
 * blocks in that locale), `blocks.<id>.<field>`, `copy.<slot>`. `slots` names copy slots that
 * must exist even when the version's `copy` lacks the key (the registry's declared slots).
 */
export function templateCompleteness(
  version: CompletenessInput,
  locales: readonly Locale[] = LOCALES,
  options: { slots?: readonly string[] } = {},
): LocaleCompleteness[] {
  const wanted = LOCALES.filter((l) => locales.includes(l));
  const slotKeys = [...new Set([...Object.keys(version.copy ?? {}), ...(options.slots ?? [])])].sort();
  return wanted.map((locale) => {
    const missing: string[] = [];
    if (blank(version.subject?.[locale])) missing.push("subject");
    if (blank(version.preheader?.[locale])) missing.push("preheader");
    if (version.document) {
      const blocks = version.document.locales[locale];
      if (!blocks || blocks.length === 0) missing.push("document");
      else missing.push(...missingBlockTexts(blocks));
    }
    if (version.copy || options.slots?.length) {
      for (const slot of slotKeys) if (blank(version.copy?.[slot]?.[locale])) missing.push(`copy.${slot}`);
    }
    return { locale, missing };
  });
}

/** The `locale:path` items of a completeness result (the `validation` payload of publish). */
export function completenessIssues(result: readonly LocaleCompleteness[]): string[] {
  return result.flatMap((r) => r.missing.map((m) => `${r.locale}:${m}`));
}

/** The locales with nothing missing. */
export function completeLocales(result: readonly LocaleCompleteness[]): Locale[] {
  return result.filter((r) => r.missing.length === 0).map((r) => r.locale);
}

/** True when every requested locale is complete. */
export function isTemplateComplete(version: CompletenessInput, locales: readonly Locale[] = LOCALES, options: { slots?: readonly string[] } = {}): boolean {
  return templateCompleteness(version, locales, options).every((r) => r.missing.length === 0);
}
