/**
 * Review warnings (rule 45): non-blocking flags shown on the diff of a proposal or draft. They
 * flag a currency amount in text (prices come from the catalogue), a changed path, removed blocks,
 * a changed legal page and text longer than the recommended limits.
 */
import { LOCALES, type Locale } from "../i18n";
import type { Block } from "./blocks";
import { blockTexts, type VersionContent } from "./completeness";

export type WarningCode = "currency_in_text" | "path_changed" | "blocks_removed" | "legal_page_changed" | "text_too_long";
export const WARNING_CODES: readonly WarningCode[] = ["currency_in_text", "path_changed", "blocks_removed", "legal_page_changed", "text_too_long"];

export type Warning = { code: WarningCode; locale?: Locale; blockId?: string; message: string };

/** Recommended lengths; longer text is allowed but flagged. */
export const TEXT_LIMITS = { heading: 80, subheading: 200, text: 400, label: 40, quote: 500 } as const;

const CURRENCY_RE = /(€\s?\d)|(\d[\d.,]*\s?€)|(\bEUR\s?\d)|(\d[\d.,]*\s?(EUR|euro)\b)/i;

/** True when a text contains a money amount (`€ 35`, `35,00 EUR`, `35 euro`). */
export function hasCurrencyAmount(text: string): boolean {
  return CURRENCY_RE.test(text);
}

function longTexts(b: Block): { what: string; length: number; limit: number }[] {
  const out: { what: string; length: number; limit: number }[] = [];
  const check = (what: string, value: string | undefined, limit: number) => {
    if (value && value.trim().length > limit) out.push({ what, length: value.trim().length, limit });
  };
  switch (b.type) {
    case "hero":
      check("heading", b.heading, TEXT_LIMITS.heading);
      check("subheading", b.subheading, TEXT_LIMITS.subheading);
      check("cta.label", b.cta?.label, TEXT_LIMITS.label);
      break;
    case "cta":
      check("heading", b.heading, TEXT_LIMITS.heading);
      check("text", b.text, TEXT_LIMITS.text);
      check("button.label", b.button.label, TEXT_LIMITS.label);
      break;
    case "card_grid":
      b.cards.forEach((c, i) => {
        check(`cards.${i}.heading`, c.heading, TEXT_LIMITS.heading);
        check(`cards.${i}.text`, c.text, TEXT_LIMITS.text);
      });
      break;
    case "booking_cta":
      check("label", b.label, TEXT_LIMITS.label);
      break;
    case "testimonial":
      check("quote", b.quote, TEXT_LIMITS.quote);
      break;
    default:
      break;
  }
  return out;
}

/** Warnings for `next` compared with `base` (null for a new page). */
export function reviewWarnings(base: VersionContent | null, next: VersionContent, context: { isLegal?: boolean } = {}): Warning[] {
  const warnings: Warning[] = [];
  let anyChange = false;
  for (const l of LOCALES) {
    if (!next.locales.includes(l) && !base?.locales.includes(l)) continue;
    const nextBlocks = next.blocks?.[l] ?? [];
    const baseBlocks = base?.blocks?.[l] ?? [];
    const baseTexts = new Set(baseBlocks.flatMap(blockTexts));
    for (const b of nextBlocks) {
      for (const text of blockTexts(b)) {
        if (text && hasCurrencyAmount(text) && !baseTexts.has(text)) {
          warnings.push({ code: "currency_in_text", locale: l, blockId: b.id, message: "Text contains a price; prices should come from the catalogue" });
          break;
        }
      }
      for (const t of longTexts(b)) {
        warnings.push({ code: "text_too_long", locale: l, blockId: b.id, message: `${t.what} has ${t.length} characters (recommended ${t.limit})` });
      }
    }
    if (base) {
      const oldPath = base.paths?.[l];
      const newPath = next.paths?.[l];
      if (oldPath !== undefined && newPath !== undefined && oldPath !== newPath) {
        warnings.push({ code: "path_changed", locale: l, message: `Path changes from "${oldPath}" to "${newPath}"; a redirect is created on publish` });
      }
      const nextIds = new Set(nextBlocks.map((b) => b.id));
      const removed = baseBlocks.filter((b) => !nextIds.has(b.id));
      if (removed.length) warnings.push({ code: "blocks_removed", locale: l, message: `${removed.length} block(s) removed` });
      if (JSON.stringify(baseBlocks) !== JSON.stringify(nextBlocks) || base.title?.[l] !== next.title?.[l]) anyChange = true;
    }
  }
  if (context.isLegal && (anyChange || !base)) {
    warnings.push({ code: "legal_page_changed", message: next.isMaterialChange ? "Legal text changes (material: customers are asked to accept again)" : "Legal text changes" });
  }
  return warnings;
}
