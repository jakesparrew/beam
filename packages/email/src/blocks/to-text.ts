/**
 * Block document -> plain-text part (email spec rule 3: every message has a text part).
 *
 * Headings are underlined (`=` for level 1, `-` below), Markdown links and buttons become
 * `text (url)`, lists keep `- ` and `1. ` markers, images contribute their alt text (and link),
 * dividers become a rule, dynamic blocks expand to the chosen variant. Tokens stay as
 * placeholders for `personalise()` with `escape: false`.
 */
import type { Block, LeafBlock } from "@beam/core/email";
import { formatDateTime, formatMoney, URL_SEGMENT, type Locale } from "@beam/core/i18n";
import { markdownToText } from "./markdown";
import { EMPTY_CARDS, expandBlocks, SHOP_BASE_URL, type ResolvedCards, type VariantChoice } from "./to-mjml";

export type ToTextContext = { locale: Locale; cards?: ResolvedCards; choice?: VariantChoice };

const RULE = "----------------------------------------";

function underline(text: string, char: string): string {
  return `${text}\n${char.repeat(Math.max(3, Math.min(60, text.length)))}`;
}

function leafText(block: LeafBlock, locale: Locale, cards: ResolvedCards): string {
  switch (block.type) {
    case "heading":
      return underline(block.text.trim(), block.level === 1 ? "=" : "-");
    case "text":
      return markdownToText(block.markdown);
    case "image": {
      const alt = (block.alt ?? "").trim();
      if (block.href) return alt ? `${alt} (${block.href})` : block.href;
      return alt ? `[${alt}]` : "";
    }
    case "button":
      return `${block.label} (${block.href})`;
    case "divider":
      return RULE;
    case "spacer":
      return "";
    case "product": {
      const card = cards.products[block.productId];
      if (!card || !card.active) return "";
      const url = `${SHOP_BASE_URL}/${URL_SEGMENT[locale]}/account/shop/${encodeURIComponent(card.sku)}`;
      const price = block.showPrice && card.priceCents !== null ? `\n${formatMoney(card.priceCents, locale)}` : "";
      return `${card.name}${price}\n${block.ctaLabel} (${url})`;
    }
    case "event": {
      const card = cards.events[block.sessionId];
      if (!card || !card.active) return "";
      return `${card.title}\n${formatDateTime(card.startsAt, locale, "long")}\n${block.ctaLabel} (${card.url})`;
    }
  }
}

/** The plain text of one locale's blocks for one variant choice (without the footer). */
export function blocksToText(blocks: readonly Block[], context: ToTextContext): string {
  const cards = context.cards ?? EMPTY_CARDS;
  const parts: string[] = [];
  for (const b of expandBlocks(blocks, context.choice)) {
    if (b.type === "columns") {
      for (const c of b.columns) for (const leaf of c.blocks) parts.push(leafText(leaf, context.locale, cards));
    } else parts.push(leafText(b, context.locale, cards));
  }
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .join("\n\n");
}
