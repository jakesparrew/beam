/**
 * Block document -> MJML body markup (email spec rules 16-22).
 *
 * Consecutive leaf blocks share one `mj-section` / `mj-column`; a `columns` block is its own
 * section with one `mj-column` per column (stacked on mobile unless `stackOnMobile` is false,
 * which wraps them in `mj-group`); a `dynamic` block expands to the blocks of the variant chosen
 * by the `VariantChoice` (the compiler renders one MJML document per variant path). Text is
 * escaped with tokens kept raw, so `personalise()` fills them after compilation. Product and
 * event blocks use the cards resolved once per compile; an inactive or unknown card renders
 * nothing and adds a warning (rule 19).
 */
import type { Block, ButtonBlock, ColumnsBlock, LeafBlock } from "@beam/core/email";
import { formatDateTime, formatMoney, URL_SEGMENT, type Locale } from "@beam/core/i18n";
import { BRAND, type Brand } from "../layout/brand";
import type { Warning } from "./a11y";
import { escapeKeepingTokens, markdownToHtml } from "./markdown";

/** Commerce's product card at send time (`commerce.getProductCards`). */
export type ProductCard = { id: string; name: string; sku: string; priceCents: number | null; active: boolean; imageUrl?: string | null };
/** Booking's session card (`booking.getSessionCards`) with site's event page URL. */
export type EventCard = { id: string; title: string; startsAt: Date | string; url: string; active: boolean };
/** Cards keyed by product id and session id. */
export type ResolvedCards = { products: Readonly<Record<string, ProductCard>>; events: Readonly<Record<string, EventCard>> };
export type CardRefs = { productIds: string[]; sessionIds: string[] };
export type ResolveCards = (refs: CardRefs) => Promise<ResolvedCards> | ResolvedCards;

/** For each top-level dynamic block id, the chosen variant index or `fallback`. */
export type VariantChoice = Readonly<Record<string, number | "fallback">>;

export const EMPTY_CARDS: ResolvedCards = { products: {}, events: {} };

/** Absolute public image URL of a `files` row (rule 22). */
export const IMAGE_BASE_URL = "https://beam.be/api/public/files/";
/** Commerce's portal product page (rule 19). */
export const SHOP_BASE_URL = "https://beam.be";

export type ToMjmlContext = {
  locale: Locale;
  brand?: Brand;
  cards?: ResolvedCards;
  choice?: VariantChoice;
  imageBaseUrl?: string;
  /** Collects card and render warnings. */
  warnings?: Warning[];
};

const attr = (value: string | number): string => escapeKeepingTokens(String(value));

function headingMjml(level: 1 | 2 | 3, text: string, brand: Brand): string {
  const size = level === 1 ? 26 : level === 2 ? 21 : 18;
  return `<mj-text padding="8px 24px"><h${level} style="margin:0;color:${brand.text};font-size:${size}px;line-height:1.3;font-weight:700">${escapeKeepingTokens(text)}</h${level}></mj-text>`;
}

function buttonMjml(label: string, href: string, style: ButtonBlock["style"], brand: Brand): string {
  const colours =
    style === "primary"
      ? `background-color="${brand.color}" color="${brand.buttonText}"`
      : `background-color="${brand.surface}" color="${brand.color}" border="2px solid ${brand.color}"`;
  return `<mj-button href="${attr(href)}" ${colours} font-size="${brand.bodySize}px" font-weight="600" border-radius="6px" inner-padding="12px 24px" padding="12px 24px">${escapeKeepingTokens(label)}</mj-button>`;
}

function leafMjml(block: LeafBlock, ctx: Required<Omit<ToMjmlContext, "warnings" | "choice">> & { warnings?: Warning[] }): string {
  const { brand, locale } = ctx;
  switch (block.type) {
    case "heading":
      return headingMjml(block.level, block.text, brand);
    case "text":
      return `<mj-text padding="8px 24px">${markdownToHtml(block.markdown, { linkColor: brand.color })}</mj-text>`;
    case "image": {
      const width = block.width ? ` width="${block.width}px"` : "";
      const href = block.href ? ` href="${attr(block.href)}"` : "";
      return `<mj-image src="${attr(ctx.imageBaseUrl + block.fileId)}" alt="${attr(block.alt ?? "")}"${width}${href} padding="8px 24px" />`;
    }
    case "button":
      return buttonMjml(block.label, block.href, block.style, brand);
    case "divider":
      return `<mj-divider border-color="${brand.border}" border-width="1px" padding="16px 24px" />`;
    case "spacer":
      return `<mj-spacer height="${block.height}px" />`;
    case "product": {
      const card = ctx.cards.products[block.productId];
      if (!card || !card.active) {
        ctx.warnings?.push({ code: "product_unavailable", locale, blockId: block.id, detail: block.productId });
        return "";
      }
      const url = `${SHOP_BASE_URL}/${URL_SEGMENT[locale]}/account/shop/${encodeURIComponent(card.sku)}`;
      const price = block.showPrice && card.priceCents !== null ? `<p style="margin:4px 0 0;color:${brand.text}">${formatMoney(card.priceCents, locale)}</p>` : "";
      return [
        `<mj-text padding="8px 24px"><p style="margin:0;font-weight:700;color:${brand.text}">${escapeKeepingTokens(card.name)}</p>${price}</mj-text>`,
        buttonMjml(block.ctaLabel, url, "primary", brand),
      ].join("\n");
    }
    case "event": {
      const card = ctx.cards.events[block.sessionId];
      if (!card || !card.active) {
        ctx.warnings?.push({ code: "event_unavailable", locale, blockId: block.id, detail: block.sessionId });
        return "";
      }
      return [
        `<mj-text padding="8px 24px"><p style="margin:0;font-weight:700;color:${brand.text}">${escapeKeepingTokens(card.title)}</p><p style="margin:4px 0 0;color:${brand.text}">${formatDateTime(card.startsAt, locale, "long")}</p></mj-text>`,
        buttonMjml(block.ctaLabel, card.url, "primary", brand),
      ].join("\n");
    }
  }
}

function sectionOf(content: string, brand: Brand): string {
  return `<mj-section background-color="${brand.surface}" padding="0"><mj-column>\n${content}\n</mj-column></mj-section>`;
}

function columnsMjml(block: ColumnsBlock, ctx: Parameters<typeof leafMjml>[1]): string {
  const cols = block.columns
    .map((c) => {
      const inner = c.blocks.map((b) => leafMjml(b, ctx)).filter(Boolean).join("\n");
      // mj-column needs at least one child under strict validation.
      return `<mj-column width="${c.width}%">\n${inner || '<mj-spacer height="1px" />'}\n</mj-column>`;
    })
    .join("\n");
  const body = block.stackOnMobile === false ? `<mj-group>\n${cols}\n</mj-group>` : cols;
  return `<mj-section background-color="${ctx.brand.surface}" padding="0">\n${body}\n</mj-section>`;
}

/** The blocks a reader with `choice` sees: dynamic blocks replaced by their chosen branch. */
export function expandBlocks(blocks: readonly Block[], choice: VariantChoice = {}): Exclude<Block, { type: "dynamic" }>[] {
  const out: Exclude<Block, { type: "dynamic" }>[] = [];
  for (const b of blocks) {
    if (b.type !== "dynamic") {
      out.push(b);
      continue;
    }
    const pick = choice[b.id] ?? "fallback";
    const chosen = pick === "fallback" ? b.fallback : (b.variants[pick]?.blocks ?? b.fallback);
    out.push(...chosen);
  }
  return out;
}

/** The product and session ids a document references (every locale, every variant). */
export function cardRefs(blocksList: readonly (readonly Block[])[]): CardRefs {
  const productIds = new Set<string>();
  const sessionIds = new Set<string>();
  const visit = (list: readonly Block[]) => {
    for (const b of list) {
      if (b.type === "product") productIds.add(b.productId);
      else if (b.type === "event") sessionIds.add(b.sessionId);
      else if (b.type === "columns") for (const c of b.columns) visit(c.blocks);
      else if (b.type === "dynamic") {
        for (const v of b.variants) visit(v.blocks);
        visit(b.fallback);
      }
    }
  };
  for (const blocks of blocksList) visit(blocks);
  return { productIds: [...productIds], sessionIds: [...sessionIds] };
}

/** The `mj-section` elements of one locale's blocks for one variant choice. */
export function blocksToMjml(blocks: readonly Block[], context: ToMjmlContext): string {
  const ctx = {
    locale: context.locale,
    brand: context.brand ?? BRAND,
    cards: context.cards ?? EMPTY_CARDS,
    imageBaseUrl: context.imageBaseUrl ?? IMAGE_BASE_URL,
    ...(context.warnings ? { warnings: context.warnings } : {}),
  };
  const sections: string[] = [];
  let run: string[] = [];
  const flush = () => {
    const content = run.filter(Boolean);
    if (content.length) sections.push(sectionOf(content.join("\n"), ctx.brand));
    run = [];
  };
  for (const b of expandBlocks(blocks, context.choice)) {
    if (b.type === "columns") {
      flush();
      sections.push(columnsMjml(b, ctx));
    } else run.push(leafMjml(b, ctx));
  }
  flush();
  return sections.join("\n");
}
