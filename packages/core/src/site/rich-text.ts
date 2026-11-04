/**
 * `RichDoc` (rule 19): a Tiptap-compatible JSON document with paragraphs, headings 2-4, bullet
 * and numbered lists, blockquote, bold, italic, links and hard breaks. Rendered by site's own
 * renderer; no HTML string is ever injected. Unknown node types are rejected; unknown attrs that
 * Tiptap adds (`target`, `rel`, `class`) are stripped.
 */
import { z } from "zod";
import { SafeHref } from "./links";

export type RichMark = { type: "bold" } | { type: "italic" } | { type: "link"; attrs: { href: string } };
export type RichTextNode = { type: "text"; text: string; marks?: RichMark[] };
export type RichHardBreak = { type: "hardBreak" };
export type RichInline = RichTextNode | RichHardBreak;
export type RichParagraph = { type: "paragraph"; content?: RichInline[] };
export type RichHeading = { type: "heading"; attrs: { level: 2 | 3 | 4 }; content?: RichInline[] };
export type RichListItem = { type: "listItem"; content: (RichParagraph | RichBulletList | RichOrderedList)[] };
export type RichBulletList = { type: "bulletList"; content: RichListItem[] };
export type RichOrderedList = { type: "orderedList"; attrs?: { start?: number }; content: RichListItem[] };
export type RichBlockquote = { type: "blockquote"; content: (RichParagraph | RichBulletList | RichOrderedList)[] };
export type RichBlockNode = RichParagraph | RichHeading | RichBulletList | RichOrderedList | RichBlockquote;
export type RichDoc = { type: "doc"; content: RichBlockNode[] };

const MarkSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("bold") }),
  z.object({ type: z.literal("italic") }),
  z.object({ type: z.literal("link"), attrs: z.object({ href: SafeHref }) }),
]);

const TextSchema = z.object({ type: z.literal("text"), text: z.string().min(1).max(10000), marks: z.array(MarkSchema).max(3).optional() });
const InlineSchema = z.discriminatedUnion("type", [TextSchema, z.object({ type: z.literal("hardBreak") })]);

const ParagraphSchema = z.object({ type: z.literal("paragraph"), content: z.array(InlineSchema).max(500).optional() });
const HeadingSchema = z.object({
  type: z.literal("heading"),
  attrs: z.object({ level: z.union([z.literal(2), z.literal(3), z.literal(4)]) }),
  content: z.array(InlineSchema).max(100).optional(),
});

const ListItemSchema: z.ZodType<RichListItem> = z.object({
  type: z.literal("listItem"),
  get content() {
    return z.array(z.union([ParagraphSchema, BulletListSchema, OrderedListSchema])).min(1).max(20);
  },
});
const BulletListSchema: z.ZodType<RichBulletList> = z.object({
  type: z.literal("bulletList"),
  get content() {
    return z.array(ListItemSchema).min(1).max(100);
  },
});
const OrderedListSchema: z.ZodType<RichOrderedList> = z.object({
  type: z.literal("orderedList"),
  attrs: z.object({ start: z.number().int().min(1).optional() }).optional(),
  get content() {
    return z.array(ListItemSchema).min(1).max(100);
  },
});
const BlockquoteSchema = z.object({
  type: z.literal("blockquote"),
  content: z.array(z.union([ParagraphSchema, BulletListSchema, OrderedListSchema])).min(1).max(50),
});

export const RichDocSchema: z.ZodType<RichDoc> = z.object({
  type: z.literal("doc"),
  content: z.array(z.union([ParagraphSchema, HeadingSchema, BulletListSchema, OrderedListSchema, BlockquoteSchema])).max(500),
});

function inlineText(content: readonly RichInline[] | undefined): string {
  return (content ?? []).map((n) => (n.type === "text" ? n.text : "\n")).join("");
}

function blockText(node: RichBlockNode | RichListItem, out: string[]): void {
  switch (node.type) {
    case "paragraph":
    case "heading": {
      const text = inlineText(node.content).trim();
      if (text) out.push(text);
      return;
    }
    case "bulletList":
    case "orderedList":
      node.content.forEach((item, i) => {
        const parts: string[] = [];
        for (const child of item.content) blockText(child, parts);
        if (parts.length) out.push(`${node.type === "orderedList" ? `${(node.attrs?.start ?? 1) + i}.` : "-"} ${parts.join("\n")}`);
      });
      return;
    case "blockquote":
    case "listItem":
      for (const child of node.content) blockText(child, out);
      return;
  }
}

/** Headings and paragraphs as plain text, blank-line separated (for print, declarations and diffs). */
export function richDocToPlainText(doc: RichDoc | null | undefined): string {
  if (!doc) return "";
  const out: string[] = [];
  for (const node of doc.content) blockText(node, out);
  return out.join("\n\n");
}

/** Every link href inside a document, in order. */
export function richDocHrefs(doc: RichDoc | null | undefined): string[] {
  const hrefs: string[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const n = node as { marks?: RichMark[]; content?: unknown[] };
    for (const m of n.marks ?? []) if (m.type === "link") hrefs.push(m.attrs.href);
    for (const c of n.content ?? []) visit(c);
  };
  visit(doc);
  return hrefs;
}

/** A one-paragraph document (seeds, tests, WordPress import fallbacks). */
export function paragraphDoc(...paragraphs: string[]): RichDoc {
  return { type: "doc", content: paragraphs.map((text) => ({ type: "paragraph", content: text ? [{ type: "text", text }] : [] })) };
}
