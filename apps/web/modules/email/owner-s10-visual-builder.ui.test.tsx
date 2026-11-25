/**
 * Owner's review, section 10 (visual email builder): the canvas draws the blocks as the email
 * shows them (heading, text with Markdown, button, nested columns), keeps one `data-block-id`
 * button per block in document order, stacks columns at mobile width, and drag and drop moves a
 * block within its own list only.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Block } from "@beam/core/email";
import { BlockCanvas, reorderBlock } from "./ui/editor/BlockCanvas";

const blocks: Block[] = [
  { id: "aaaaaaaaaa", type: "heading", level: 1, text: "Hello" },
  { id: "bbbbbbbbbb", type: "text", markdown: "Hi **{{first_name|friend}}**\n- one" },
  { id: "cccccccccc", type: "button", label: "Book now", href: "https://beam.be", style: "primary" },
  {
    id: "dddddddddd",
    type: "columns",
    stackOnMobile: true,
    columns: [
      { width: 50, blocks: [{ id: "eeeeeeeeee", type: "divider" }] },
      { width: 50, blocks: [{ id: "ffffffffff", type: "spacer", height: 24 }] },
    ],
  },
];

const html = (width: 600 | 375) =>
  renderToStaticMarkup(createElement(BlockCanvas, { blocks, selectedId: "cccccccccc", onSelect: () => undefined, onChange: () => undefined, onInsert: () => undefined, warnedIds: new Set(["bbbbbbbbbb"]), labels: {}, width }));

describe("visual email canvas", () => {
  it("draws the blocks as the email looks, one select button per block in document order", () => {
    const out = html(600);
    expect([...out.matchAll(/data-block-id="(\w+)"/g)].map((m) => m[1])).toEqual(["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc", "dddddddddd", "eeeeeeeeee", "ffffffffff"]);
    expect(out).toContain("font-size:26px");
    expect(out).toContain("<strong>{{first_name|friend}}</strong>");
    expect(out).toContain("• ");
    expect(out).toContain("Book now");
    expect(out).toContain('data-testid="block-toolbar"');
    expect(out).toContain("width:600px");
    expect(out).toContain('data-testid="canvas-drop-end"');
  });

  it("stacks columns at mobile width", () => {
    expect(html(600)).toContain("flex-basis:50%");
    const mobile = html(375);
    expect(mobile).toContain("width:375px");
    expect(mobile).not.toContain("flex-basis:50%");
  });

  it("drag and drop moves a block within its own list only", () => {
    expect(reorderBlock(blocks, "cccccccccc", "aaaaaaaaaa").map((b) => b.id)).toEqual(["cccccccccc", "aaaaaaaaaa", "bbbbbbbbbb", "dddddddddd"]);
    expect(reorderBlock(blocks, "aaaaaaaaaa", "cccccccccc").map((b) => b.id)).toEqual(["bbbbbbbbbb", "cccccccccc", "aaaaaaaaaa", "dddddddddd"]);
    const nested = reorderBlock(blocks, "eeeeeeeeee", "aaaaaaaaaa");
    expect(nested).toEqual(blocks);
  });
});
