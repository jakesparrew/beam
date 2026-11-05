/**
 * The block document of block-backed templates (email spec rules 16-22). Pure.
 *
 * `{ schemaVersion: 1, locales: { 'nl-BE'?: Block[], 'fr-BE'?: Block[], en?: Block[] } }`; every
 * block has a stable `id` (nanoid, 10 characters). Locales may differ in structure. Nesting:
 * `columns` may not contain `columns` or `dynamic`; `dynamic` may not contain `dynamic`. At most
 * 200 blocks per locale (nested blocks count) and 256 KB of JSON per document.
 */
import { z } from "zod";
import { LOCALES, type Locale } from "../i18n/locales";

export const BLOCK_TYPES = [
  "heading",
  "text",
  "image",
  "button",
  "divider",
  "spacer",
  "columns",
  "product",
  "event",
  "dynamic",
  "webinar",
] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];

export const MAX_BLOCKS_PER_LOCALE = 200;
export const MAX_DOCUMENT_BYTES = 256 * 1024;

/** nanoid alphabet, length 10. */
export const BLOCK_ID_PATTERN = /^[A-Za-z0-9_-]{10}$/;
/** `https://...` or a URL that starts with a personalisation token (`{{portal_url}}`, `{{webinar.access_url}}`). */
export const BUTTON_HREF_PATTERN = /^(https:\/\/[^\s]+|\{\{\s*[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)?\s*\}\}[^\s]*)$/;

const NANOID_ALPHABET = "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";

/** A fresh block id (10 characters of the nanoid alphabet). */
export function newBlockId(): string {
  const bytes = new Uint8Array(10);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += NANOID_ALPHABET[b & 63];
  return out;
}

export type PersonStatusCondition = { status: "lead" | "customer" | "member" };
export type AssessmentCondition = { assessmentOutcome: { formSlug: string; outcomeKeys: string[] } };
export type DynamicCondition = PersonStatusCondition | AssessmentCondition;

export type HeadingBlock = { id: string; type: "heading"; level: 1 | 2 | 3; text: string };
/** Limited Markdown: bold, italic, links, bullet and numbered lists. */
export type TextBlock = { id: string; type: "text"; markdown: string };
/** `alt` is required; decorative images use `alt: ""` explicitly. */
export type ImageBlock = { id: string; type: "image"; fileId: string; alt: string; href?: string; width?: number };
export type ButtonBlock = { id: string; type: "button"; label: string; href: string; style: "primary" | "secondary" };
export type DividerBlock = { id: string; type: "divider" };
export type SpacerBlock = { id: string; type: "spacer"; height: number };
export type ProductBlock = { id: string; type: "product"; productId: string; showPrice: boolean; ctaLabel: string };
/**
 * `showLeadWindow` (R2, email-P8): while a Lead Magnet session is in its lead window with no
 * general seat left, a recipient whose status is not `lead` sees "Opens for you on <date time>"
 * instead of the booking button (booking `getSessionCards().opensForCustomersAt`, scenario 3).
 * Absent means false.
 */
export type EventBlock = { id: string; type: "event"; sessionId: string; ctaLabel: string; showLeadWindow?: boolean };
/** R2 (email-P8): a webinar card (`webinar.getWebinarCards`): title, Brussels date and time, and a button to its landing page. */
export type WebinarBlock = { id: string; type: "webinar"; webinarId: string; ctaLabel: string };

/** A block that holds no other blocks. */
export type LeafBlock = HeadingBlock | TextBlock | ImageBlock | ButtonBlock | DividerBlock | SpacerBlock | ProductBlock | EventBlock | WebinarBlock;
export type Column = { width: number; blocks: LeafBlock[] };
export type ColumnsBlock = { id: string; type: "columns"; columns: Column[]; stackOnMobile: boolean };
export type DynamicVariant = { when: DynamicCondition; blocks: (LeafBlock | ColumnsBlock)[] };
export type DynamicBlock = { id: string; type: "dynamic"; variants: DynamicVariant[]; fallback: (LeafBlock | ColumnsBlock)[] };

export type Block = LeafBlock | ColumnsBlock | DynamicBlock;
export type BlockDocument = { schemaVersion: 1; locales: Partial<Record<Locale, Block[]>> };

const blockId = z.string().regex(BLOCK_ID_PATTERN, "block id must be a 10-character nanoid");
const href = z.string().regex(BUTTON_HREF_PATTERN, "href must be https or a token URL");

export const HeadingBlockSchema = z.object({ id: blockId, type: z.literal("heading"), level: z.union([z.literal(1), z.literal(2), z.literal(3)]), text: z.string() }).strict();
export const TextBlockSchema = z.object({ id: blockId, type: z.literal("text"), markdown: z.string() }).strict();
export const ImageBlockSchema = z
  .object({
    id: blockId,
    type: z.literal("image"),
    fileId: z.string().uuid(),
    alt: z.string({ error: "image alt is required (use an empty string for decorative images)" }),
    href: href.optional(),
    width: z.number().int().min(100).max(600).optional(),
  })
  .strict();
export const ButtonBlockSchema = z
  .object({ id: blockId, type: z.literal("button"), label: z.string(), href, style: z.enum(["primary", "secondary"]) })
  .strict();
export const DividerBlockSchema = z.object({ id: blockId, type: z.literal("divider") }).strict();
export const SpacerBlockSchema = z.object({ id: blockId, type: z.literal("spacer"), height: z.number().int().min(8).max(64) }).strict();
export const ProductBlockSchema = z
  .object({ id: blockId, type: z.literal("product"), productId: z.string().uuid(), showPrice: z.boolean(), ctaLabel: z.string() })
  .strict();
export const EventBlockSchema = z
  .object({ id: blockId, type: z.literal("event"), sessionId: z.string().uuid(), ctaLabel: z.string(), showLeadWindow: z.boolean().optional() })
  .strict();
export const WebinarBlockSchema = z.object({ id: blockId, type: z.literal("webinar"), webinarId: z.string().uuid(), ctaLabel: z.string() }).strict();

export const LeafBlockSchema = z.discriminatedUnion("type", [
  HeadingBlockSchema,
  TextBlockSchema,
  ImageBlockSchema,
  ButtonBlockSchema,
  DividerBlockSchema,
  SpacerBlockSchema,
  ProductBlockSchema,
  EventBlockSchema,
  WebinarBlockSchema,
]);

export const ColumnsBlockSchema = z
  .object({
    id: blockId,
    type: z.literal("columns"),
    columns: z
      .array(z.object({ width: z.number().int().min(1).max(100), blocks: z.array(LeafBlockSchema) }).strict())
      .min(2)
      .max(3),
    stackOnMobile: z.boolean().default(true),
  })
  .strict()
  .refine((b) => b.columns.reduce((sum, c) => sum + c.width, 0) === 100, { message: "column widths must sum to 100", path: ["columns"] });

export const DynamicConditionSchema = z.union([
  z.object({ status: z.enum(["lead", "customer", "member"]) }).strict(),
  z.object({ assessmentOutcome: z.object({ formSlug: z.string().min(1), outcomeKeys: z.array(z.string().min(1)).min(1) }).strict() }).strict(),
]);

const NestedInDynamicSchema = z.union([LeafBlockSchema, ColumnsBlockSchema]);

export const DynamicBlockSchema = z
  .object({
    id: blockId,
    type: z.literal("dynamic"),
    variants: z.array(z.object({ when: DynamicConditionSchema, blocks: z.array(NestedInDynamicSchema) }).strict()).min(1),
    fallback: z.array(NestedInDynamicSchema).default([]),
  })
  .strict();

/** Any block, with the nesting rules of rule 17 built into the shape. */
export const BlockSchema = z.union([LeafBlockSchema, ColumnsBlockSchema, DynamicBlockSchema]);

export const BlockDocumentSchema = z
  .object({
    schemaVersion: z.literal(1),
    locales: z
      .object({ "nl-BE": z.array(BlockSchema).optional(), "fr-BE": z.array(BlockSchema).optional(), en: z.array(BlockSchema).optional() })
      .strict(),
  })
  .strict();

// Compile-time proof that the schemas produce the declared types.
type Assert<T extends true> = T;
export type _BlockSchemaMatches = Assert<z.output<typeof BlockSchema> extends Block ? (Block extends z.output<typeof BlockSchema> ? true : false) : false>;
export type _DocumentSchemaMatches = Assert<z.output<typeof BlockDocumentSchema> extends BlockDocument ? true : false>;

// ---------------------------------------------------------------------------
// Validation with precise issues
// ---------------------------------------------------------------------------

export type DocIssueCode =
  | "invalid_document"
  | "invalid_block"
  | "unknown_block_type"
  | "nested_columns"
  | "nested_dynamic"
  | "too_many_blocks"
  | "too_large"
  | "image_alt_missing"
  | "button_href_invalid"
  | "column_widths"
  | "duplicate_block_id";

export type DocIssue = {
  code: DocIssueCode;
  /** Path inside the document, for example `['locales', 'en', 2, 'columns', 0, 'blocks', 1]`. */
  path: (string | number)[];
  locale?: Locale;
  blockId?: string;
  message: string;
};

type Raw = Record<string, unknown>;
const isObject = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);

/** UTF-8 size of the document's JSON. */
export function documentBytes(doc: unknown): number {
  return new TextEncoder().encode(JSON.stringify(doc) ?? "").length;
}

/** Every block of a list, depth first, nested blocks included. */
export function walkBlocks(blocks: readonly Block[], visit: (block: Block, depth: number) => void, depth = 0): void {
  for (const block of blocks) {
    visit(block, depth);
    if (block.type === "columns") for (const c of block.columns) walkBlocks(c.blocks, visit, depth + 1);
    if (block.type === "dynamic") {
      for (const v of block.variants) walkBlocks(v.blocks, visit, depth + 1);
      walkBlocks(block.fallback, visit, depth + 1);
    }
  }
}

/** Number of blocks in a list, nested blocks included. */
export function countBlocks(blocks: readonly Block[]): number {
  let n = 0;
  walkBlocks(blocks, () => {
    n += 1;
  });
  return n;
}

type Walk = { locale: Locale; issues: DocIssue[]; ids: Set<string>; count: number };

function checkRaw(list: unknown, path: (string | number)[], parent: "root" | "columns" | "dynamic", w: Walk): void {
  if (!Array.isArray(list)) return;
  list.forEach((raw, i) => {
    const at = [...path, i];
    if (!isObject(raw)) return;
    w.count += 1;
    const id = typeof raw.id === "string" ? raw.id : undefined;
    const base = { path: at, locale: w.locale, ...(id ? { blockId: id } : {}) };
    if (id) {
      if (w.ids.has(id)) w.issues.push({ ...base, code: "duplicate_block_id", message: `block id ${id} is used twice in ${w.locale}` });
      w.ids.add(id);
    }
    const type = raw.type;
    if (typeof type !== "string" || !(BLOCK_TYPES as readonly string[]).includes(type)) {
      w.issues.push({ ...base, code: "unknown_block_type", message: `unknown block type ${String(type)}` });
      return;
    }
    if (type === "columns" && parent === "columns") {
      w.issues.push({ ...base, code: "nested_columns", message: "a columns block may not contain columns" });
    }
    if (type === "dynamic" && parent !== "root") {
      w.issues.push({ ...base, code: "nested_dynamic", message: `a ${parent} block may not contain a dynamic block` });
    }
    if (type === "image" && typeof raw.alt !== "string") {
      w.issues.push({ ...base, code: "image_alt_missing", message: "image alt is required (use an empty string for decorative images)" });
    }
    if (type === "button" && (typeof raw.href !== "string" || !BUTTON_HREF_PATTERN.test(raw.href))) {
      w.issues.push({ ...base, code: "button_href_invalid", message: "button href must start with https:// or a token" });
    }
    if (type === "image" && raw.href !== undefined && (typeof raw.href !== "string" || !BUTTON_HREF_PATTERN.test(raw.href))) {
      w.issues.push({ ...base, code: "button_href_invalid", message: "image link must start with https:// or a token" });
    }
    if (type === "columns" && Array.isArray(raw.columns)) {
      const sum = raw.columns.reduce<number>((s, c) => s + (isObject(c) && typeof c.width === "number" ? c.width : 0), 0);
      if (sum !== 100) w.issues.push({ ...base, code: "column_widths", message: `column widths sum to ${sum}, not 100` });
      raw.columns.forEach((c, ci) => {
        if (isObject(c)) checkRaw(c.blocks, [...at, "columns", ci, "blocks"], "columns", w);
      });
    }
    if (type === "dynamic") {
      if (Array.isArray(raw.variants)) {
        raw.variants.forEach((v, vi) => {
          if (isObject(v)) checkRaw(v.blocks, [...at, "variants", vi, "blocks"], "dynamic", w);
        });
      }
      checkRaw(raw.fallback, [...at, "fallback"], "dynamic", w);
    }
  });
}

const PRECISE: ReadonlySet<DocIssueCode> = new Set([
  "unknown_block_type",
  "nested_columns",
  "nested_dynamic",
  "image_alt_missing",
  "button_href_invalid",
  "column_widths",
]);

/**
 * Validates a block document against rules 16, 17 and 20: shape, nesting, block count per
 * locale, JSON size, image alt, button URL scheme, column widths and unique block ids.
 */
export function validateDocument(doc: unknown): { ok: true } | { ok: false; issues: DocIssue[] } {
  const issues: DocIssue[] = [];
  const bytes = documentBytes(doc);
  if (bytes > MAX_DOCUMENT_BYTES) {
    issues.push({ code: "too_large", path: [], message: `document is ${bytes} bytes, the limit is ${MAX_DOCUMENT_BYTES}` });
  }
  if (isObject(doc) && isObject(doc.locales)) {
    for (const locale of LOCALES) {
      const list = doc.locales[locale];
      const w: Walk = { locale, issues, ids: new Set(), count: 0 };
      checkRaw(list, ["locales", locale], "root", w);
      if (w.count > MAX_BLOCKS_PER_LOCALE) {
        issues.push({ code: "too_many_blocks", path: ["locales", locale], locale, message: `${w.count} blocks in ${locale}, the limit is ${MAX_BLOCKS_PER_LOCALE}` });
      }
    }
  }
  const parsed = BlockDocumentSchema.safeParse(doc);
  if (!parsed.success) {
    const precisePaths = new Set(issues.filter((i) => PRECISE.has(i.code)).map((i) => i.path.join(".")));
    for (const zi of parsed.error.issues) {
      const path = zi.path.filter((p): p is string | number => typeof p === "string" || typeof p === "number");
      const key = path.join(".");
      // A Zod issue on the branch of a block that already has a precise issue adds nothing.
      if ([...precisePaths].some((p) => key === p || key.startsWith(`${p}.`) || p.startsWith(`${key}.`))) continue;
      const locale = path[0] === "locales" && LOCALES.includes(path[1] as Locale) ? (path[1] as Locale) : undefined;
      issues.push({ code: path.length > 2 ? "invalid_block" : "invalid_document", path, ...(locale ? { locale } : {}), message: zi.message });
    }
  }
  return issues.length ? { ok: false, issues } : { ok: true };
}

/** An empty document (`{ schemaVersion: 1, locales: {} }`). */
export function emptyDocument(): BlockDocument {
  return { schemaVersion: 1, locales: {} };
}
