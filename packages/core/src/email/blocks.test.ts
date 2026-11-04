import { describe, expect, it } from "vitest";
import {
  BlockDocumentSchema,
  BlockSchema,
  countBlocks,
  MAX_BLOCKS_PER_LOCALE,
  newBlockId,
  validateDocument,
  type Block,
  type BlockDocument,
  type LeafBlock,
} from "./blocks";

let n = 0;
const bid = () => `blk${String(++n).padStart(7, "0")}`;
const FILE = "7f1c1c1e-4a1b-4d4e-9c1a-0b8e2f3a4b5c";
const PRODUCT = "1a2b3c4d-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const SESSION = "2b3c4d5e-2b3c-4d4e-9f0a-1b2c3d4e5f6a";

const heading = (text = "Welcome"): LeafBlock => ({ id: bid(), type: "heading", level: 1, text });
const text = (markdown = "**Hello** {{first_name|friend}}"): LeafBlock => ({ id: bid(), type: "text", markdown });
const image = (alt = "Sauna at dusk"): LeafBlock => ({ id: bid(), type: "image", fileId: FILE, alt, width: 600 });
const button = (href = "https://beam.be/nl"): LeafBlock => ({ id: bid(), type: "button", label: "Book now", href, style: "primary" });

function fullDocument(): BlockDocument {
  const one = (): Block[] => [
    heading(),
    text(),
    image(),
    button(),
    { id: bid(), type: "divider" },
    { id: bid(), type: "spacer", height: 24 },
    {
      id: bid(),
      type: "columns",
      stackOnMobile: true,
      columns: [
        { width: 50, blocks: [text("Left")] },
        { width: 50, blocks: [{ id: bid(), type: "product", productId: PRODUCT, showPrice: true, ctaLabel: "Buy" }] },
      ],
    },
    { id: bid(), type: "event", sessionId: SESSION, ctaLabel: "Reserve" },
    {
      id: bid(),
      type: "dynamic",
      variants: [
        { when: { status: "member" }, blocks: [text("Members first")] },
        { when: { assessmentOutcome: { formSlug: "sleep-check", outcomeKeys: ["low"] } }, blocks: [heading("Rest")] },
      ],
      fallback: [text("For everyone")],
    },
  ];
  return { schemaVersion: 1, locales: { "nl-BE": one(), "fr-BE": one(), en: one() } };
}

const codes = (doc: unknown) => {
  const r = validateDocument(doc);
  return r.ok ? [] : r.issues.map((i) => i.code);
};

describe("block document", () => {
  it("accepts a valid document with all ten block types", () => {
    const doc = fullDocument();
    expect(validateDocument(doc)).toEqual({ ok: true });
    expect(BlockDocumentSchema.safeParse(doc).success).toBe(true);
    expect(countBlocks(doc.locales.en!)).toBe(14);
  });

  it("allows locales to differ in structure and to be absent in a draft", () => {
    expect(validateDocument({ schemaVersion: 1, locales: { en: [heading()], "nl-BE": [text(), button()] } })).toEqual({ ok: true });
    expect(validateDocument({ schemaVersion: 1, locales: {} })).toEqual({ ok: true });
  });

  it("refuses a wrong schema version, an unknown locale and an unknown block type", () => {
    expect(codes({ schemaVersion: 2, locales: {} })).toContain("invalid_document");
    expect(codes({ schemaVersion: 1, locales: { de: [] } })).toContain("invalid_document");
    expect(codes({ schemaVersion: 1, locales: { en: [{ id: bid(), type: "video" }] } })).toEqual(["unknown_block_type"]);
  });

  it("refuses columns inside columns and dynamic inside columns or dynamic", () => {
    const inner: Block = { id: bid(), type: "columns", stackOnMobile: true, columns: [{ width: 50, blocks: [] }, { width: 50, blocks: [] }] };
    const nestedColumns = { id: bid(), type: "columns", stackOnMobile: true, columns: [{ width: 50, blocks: [inner] }, { width: 50, blocks: [] }] };
    expect(codes({ schemaVersion: 1, locales: { en: [nestedColumns] } })).toEqual(["nested_columns"]);

    const dyn = { id: bid(), type: "dynamic", variants: [{ when: { status: "lead" }, blocks: [] }], fallback: [] };
    const dynInColumns = { id: bid(), type: "columns", stackOnMobile: true, columns: [{ width: 50, blocks: [dyn] }, { width: 50, blocks: [] }] };
    expect(codes({ schemaVersion: 1, locales: { en: [dynInColumns] } })).toEqual(["nested_dynamic"]);

    const dynInDyn = { id: bid(), type: "dynamic", variants: [{ when: { status: "lead" }, blocks: [{ ...dyn, id: bid() }] }], fallback: [] };
    expect(codes({ schemaVersion: 1, locales: { en: [dynInDyn] } })).toEqual(["nested_dynamic"]);

    // columns inside a dynamic variant is allowed
    const colsInDyn = { id: bid(), type: "dynamic", variants: [{ when: { status: "customer" }, blocks: [inner] }], fallback: [] };
    expect(validateDocument({ schemaVersion: 1, locales: { en: [colsInDyn] } })).toEqual({ ok: true });
  });

  it("refuses column widths that do not sum to 100 and a fourth column", () => {
    const cols = { id: bid(), type: "columns", stackOnMobile: true, columns: [{ width: 50, blocks: [] }, { width: 40, blocks: [] }] };
    expect(codes({ schemaVersion: 1, locales: { en: [cols] } })).toEqual(["column_widths"]);
    const four = { id: bid(), type: "columns", stackOnMobile: true, columns: [25, 25, 25, 25].map((width) => ({ width, blocks: [] })) };
    expect(codes({ schemaVersion: 1, locales: { en: [four] } })).toContain("invalid_block");
  });

  it("allows 200 blocks per locale and refuses 201 (nested blocks count)", () => {
    const many = (count: number): LeafBlock[] => Array.from({ length: count }, (): LeafBlock => ({ id: bid(), type: "divider" }));
    expect(validateDocument({ schemaVersion: 1, locales: { en: many(MAX_BLOCKS_PER_LOCALE) } })).toEqual({ ok: true });
    expect(codes({ schemaVersion: 1, locales: { en: many(201) } })).toEqual(["too_many_blocks"]);
    const nested: Block = { id: bid(), type: "columns", stackOnMobile: true, columns: [{ width: 50, blocks: many(2) }, { width: 50, blocks: [] }] };
    expect(codes({ schemaVersion: 1, locales: { en: [...many(198), nested] } })).toEqual(["too_many_blocks"]);
  });

  it("refuses a document above 256 KB", () => {
    const big = "x".repeat(2000);
    const blocks = Array.from({ length: 140 }, () => text(big));
    const r = validateDocument({ schemaVersion: 1, locales: { en: blocks } });
    expect(r.ok).toBe(false);
    expect(r.ok ? [] : r.issues.map((i) => i.code)).toEqual(["too_large"]);
  });

  it("requires image alt, but allows an explicit empty alt for decorative images", () => {
    const { alt: _alt, ...noAlt } = image() as Extract<Block, { type: "image" }>;
    expect(codes({ schemaVersion: 1, locales: { en: [noAlt] } })).toEqual(["image_alt_missing"]);
    expect(validateDocument({ schemaVersion: 1, locales: { en: [image("")] } })).toEqual({ ok: true });
  });

  it("allows https and token button URLs and refuses http, mailto and javascript", () => {
    for (const href of ["https://beam.be/en/account", "{{portal_url}}", "{{webinar.access_url}}?src=mail"]) {
      expect(validateDocument({ schemaVersion: 1, locales: { en: [button(href)] } })).toEqual({ ok: true });
    }
    for (const href of ["http://beam.be", "mailto:info@beam.be", "javascript:alert(1)", "beam.be", "https://beam.be/a b"]) {
      expect(codes({ schemaVersion: 1, locales: { en: [button(href)] } })).toEqual(["button_href_invalid"]);
    }
  });

  it("refuses duplicate block ids inside one locale and keeps them independent across locales", () => {
    const b = heading();
    expect(codes({ schemaVersion: 1, locales: { en: [b, { ...b }] } })).toEqual(["duplicate_block_id"]);
    expect(validateDocument({ schemaVersion: 1, locales: { en: [b], "nl-BE": [{ ...b }] } })).toEqual({ ok: true });
  });

  it("checks spacer height, image width and heading level ranges", () => {
    expect(codes({ schemaVersion: 1, locales: { en: [{ id: bid(), type: "spacer", height: 4 }] } })).toContain("invalid_block");
    expect(codes({ schemaVersion: 1, locales: { en: [{ ...image(), width: 700 }] } })).toContain("invalid_block");
    expect(codes({ schemaVersion: 1, locales: { en: [{ ...heading(), level: 4 }] } })).toContain("invalid_block");
  });

  it("fills stackOnMobile and an empty fallback by default", () => {
    const cols = BlockSchema.parse({ id: bid(), type: "columns", columns: [{ width: 70, blocks: [] }, { width: 30, blocks: [] }] });
    expect(cols).toMatchObject({ stackOnMobile: true });
    const dyn = BlockSchema.parse({ id: bid(), type: "dynamic", variants: [{ when: { status: "lead" }, blocks: [] }] });
    expect(dyn).toMatchObject({ fallback: [] });
  });

  it("makes 10-character nanoid block ids", () => {
    const ids = new Set(Array.from({ length: 50 }, newBlockId));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{10}$/);
  });
});
