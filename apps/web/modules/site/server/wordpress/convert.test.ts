import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BlockList, type Block, type RichDoc } from "@beam/core/site";
import { htmlToBlocks, mergeReports, NO_POSTER_ID, youtubeIdOf } from "./convert";
import { parseWxr } from "./wxr";

const POOL = "11111111-1111-4111-8111-111111111111";
const ORIGIN = "https://www.beam.be";
let n = 0;
const ctx = (media: Record<string, string> = {}) => ({
  mediaByUrl: new Map(Object.entries(media)),
  siteOrigin: ORIGIN,
  newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
});
const docs = (blocks: Block[]): RichDoc["content"] => blocks.flatMap((b) => (b.type === "rich_text" ? b.doc.content : []));

describe("htmlToBlocks", () => {
  it("turns h1 into h2 and clamps h5/h6 to h4", () => {
    const { blocks } = htmlToBlocks("<h1>Titel</h1><h3>Sub</h3><h5>Klein</h5><h6>Kleiner</h6>", ctx());
    expect(docs(blocks).map((d) => (d.type === "heading" ? d.attrs.level : 0))).toEqual([2, 3, 4, 4]);
  });

  it("keeps bullet, numbered and nested lists", () => {
    const { blocks } = htmlToBlocks("<ul><li>Een</li><li>Twee<ol><li>a</li></ol></li></ul><ol><li>Eerst</li></ol>", ctx());
    const [ul, ol] = docs(blocks);
    expect(ul).toMatchObject({ type: "bulletList", content: [{ content: [{ type: "paragraph", content: [{ text: "Een" }] }] }, { content: [{ type: "paragraph" }, { type: "orderedList" }] }] });
    expect(ol).toMatchObject({ type: "orderedList" });
  });

  it("keeps links, bold and italic; old-site links become site paths; unsafe links keep their text", () => {
    const html = `<p><strong>Vet</strong> <em>schuin</em> <a href="${ORIGIN}/Dagsessies/">intern</a> <a href="https://example.org/x">extern</a> <a href="javascript:alert(1)">kwaad</a> <a href="mailto:info@example.com">mail</a></p>`;
    const { blocks, report } = htmlToBlocks(html, ctx());
    const [p] = docs(blocks);
    expect(p).toEqual({
      type: "paragraph",
      content: [
        { type: "text", text: "Vet", marks: [{ type: "bold" }] },
        { type: "text", text: " " },
        { type: "text", text: "schuin", marks: [{ type: "italic" }] },
        { type: "text", text: " " },
        { type: "text", text: "intern", marks: [{ type: "link", attrs: { href: "/dagsessies" } }] },
        { type: "text", text: " " },
        { type: "text", text: "extern", marks: [{ type: "link", attrs: { href: "https://example.org/x" } }] },
        { type: "text", text: " kwaad " },
        { type: "text", text: "mail", marks: [{ type: "link", attrs: { href: "mailto:info@example.com" } }] },
      ],
    });
    expect(report.unresolvedLinks).toEqual(["javascript:alert(1)"]);
  });

  it("turns a known img into an image block and reports unknown ones", () => {
    const html = `<p>Voor</p><figure><img src="${ORIGIN}/wp-content/uploads/2024/01/pool-300x200.jpg" alt="Het zwembad"><figcaption>Ons bad</figcaption></figure><img src="/wp-content/uploads/x.png"><p>Na</p>`;
    const { blocks, report } = htmlToBlocks(html, ctx({ [`${ORIGIN}/wp-content/uploads/2024/01/pool.jpg`]: POOL }));
    expect(blocks.map((b) => b.type)).toEqual(["rich_text", "image", "rich_text"]);
    expect(blocks[1]).toMatchObject({ type: "image", mediaId: POOL, caption: "Ons bad" });
    expect(report.alts).toEqual({ [POOL]: "Het zwembad" });
    expect(report.unresolvedImages).toEqual([`${ORIGIN}/wp-content/uploads/x.png`]);
  });

  it("turns a YouTube iframe or bare URL into a video block and drops other iframes", () => {
    const html = `<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ?feature=oembed" title="BEAM"></iframe><div class="wp-block-embed__wrapper">https://youtu.be/abcdefghijk</div><iframe src="https://maps.example.com/embed"></iframe>`;
    const { blocks, report } = htmlToBlocks(html, ctx());
    expect(blocks).toEqual([
      expect.objectContaining({ type: "video", youtubeId: "dQw4w9WgXcQ", title: "BEAM", posterMediaId: NO_POSTER_ID }),
      expect.objectContaining({ type: "video", youtubeId: "abcdefghijk", title: "YouTube video" }),
    ]);
    expect(report).toMatchObject({ videosWithoutPoster: 2, droppedIframes: ["maps.example.com"] });
    expect(youtubeIdOf("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(youtubeIdOf("https://vimeo.com/123")).toBeNull();
  });

  it("strips shortcodes and Gutenberg comments and reports the shortcodes", () => {
    const html = `<!-- wp:paragraph --><p>[contact-form-7 id="5"] Hallo</p><!-- /wp:paragraph -->[caption id="a"]<p>Binnen</p>[/caption][gallery ids="1,2"]`;
    const { blocks, report } = htmlToBlocks(html, ctx());
    expect(JSON.stringify(blocks)).not.toMatch(/wp:|contact-form|gallery|caption/);
    expect(docs(blocks)).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "Hallo" }] },
      { type: "paragraph", content: [{ type: "text", text: "Binnen" }] },
    ]);
    expect(report.shortcodes).toEqual(["caption", "contact-form-7", "gallery"]);
  });

  it("drops inline styles, scripts and attributes", () => {
    const { blocks, report } = htmlToBlocks(`<p style="color:red" class="x">Rood</p><script>alert(1)</script><style>p{}</style>`, ctx());
    expect(JSON.stringify(blocks)).not.toMatch(/color|alert|class/);
    expect(report).toMatchObject({ stylesDropped: 1, unsupportedTags: ["script", "style"] });
  });

  it("removes empty paragraphs, including &nbsp;", () => {
    const { blocks, report } = htmlToBlocks("<p>&nbsp;</p><p></p><p> <br> </p><p>Tekst</p>", ctx());
    expect(docs(blocks)).toEqual([{ type: "paragraph", content: [{ type: "text", text: "Tekst" }] }]);
    expect(report.emptyParagraphsRemoved).toBe(3);
  });

  it("converts every fixture item into blocks that pass the block schema", () => {
    const { items } = parseWxr(readFileSync(new URL("./__fixtures__/beam-sample.wxr.xml", import.meta.url), "utf8"));
    const media = { [`${ORIGIN}/wp-content/uploads/2024/01/pool.jpg`]: POOL };
    const reports = [];
    for (const item of items.filter((i) => i.contentHtml)) {
      const { blocks, report } = htmlToBlocks(item.contentHtml!, ctx(media));
      reports.push(report);
      expect(BlockList.safeParse(blocks).success, `item ${item.wpId}`).toBe(true);
      expect(blocks.length, `item ${item.wpId}`).toBeGreaterThan(0);
    }
    const total = mergeReports(reports);
    expect(total.shortcodes).toEqual(expect.arrayContaining(["gallery", "contact-form-7", "caption", "pricing_table"]));
    expect(total.unsupportedTags).toContain("script");
  });
});
