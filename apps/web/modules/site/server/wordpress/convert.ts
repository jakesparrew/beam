/**
 * WordPress HTML -> site blocks (site rules 17-20, 22, edge case 19; site-P7). Pure: no I/O.
 *
 * - Gutenberg comments are ignored; shortcodes (`[gallery ...]`, `[caption]...[/caption]`) are
 *   stripped (their inner content stays) and listed in the report.
 * - Text becomes `rich_text` blocks (`RichDoc`): paragraphs, headings (`h1` -> `h2`, `h5`/`h6` ->
 *   `h4`, rule 18), bullet and numbered lists, blockquotes, bold, italic and links. Inline styles,
 *   classes and every other attribute are dropped; empty paragraphs (also `&nbsp;`) are removed.
 * - `img` becomes an `image` block when its URL is in `ctx.mediaByUrl` (the media library rows
 *   fetched from the old site), otherwise it is reported as unresolved.
 * - A YouTube iframe (or a bare YouTube URL, as Gutenberg's embed block exports it) becomes a
 *   `video` block. Its poster must be a media-library image (rule 22) that WordPress does not
 *   have, so `posterMediaId` is the nil uuid and the report counts it: publish checks then ask staff
 *   to pick one. Other iframes, scripts, styles, forms and embeds are dropped and reported.
 * - Links to the old site become site paths (`https://www.beam.be/dagsessies/` -> `/dagsessies`),
 *   which the WordPress redirects resolve; unsafe links (`javascript:`, `http:` elsewhere) lose
 *   the link and keep their text.
 */
import { randomUUID } from "node:crypto";
import { HTMLElement, Node as HtmlNode, NodeType, parse } from "node-html-parser";
import { isSafeHref, normalisePath, type Block, type RichBlockNode, type RichInline, type RichListItem, type RichMark } from "@beam/core/site";

export type ConvertReport = {
  /** Shortcode names that were stripped, sorted, unique. */
  shortcodes: string[];
  /** Tags dropped because blocks cannot represent them (`script`, `table`, ...). */
  unsupportedTags: string[];
  /** Hosts of iframes that were dropped (everything but YouTube). */
  droppedIframes: string[];
  /** Image URLs without a media-library row. */
  unresolvedImages: string[];
  /** Link targets that were not safe and lost their link. */
  unresolvedLinks: string[];
  /** Video blocks created without a poster image (staff pick one before publishing). */
  videosWithoutPoster: number;
  /** Elements whose `style` attribute was dropped. */
  stylesDropped: number;
  emptyParagraphsRemoved: number;
  /** `alt` text found in the HTML per media id (used when the media row has none for the locale). */
  alts: Record<string, string>;
};

export type ConvertCtx = {
  mediaByUrl: Map<string, string>;
  /** The old site's origin; absolute links on it become site paths and relative image URLs resolve against it. */
  siteOrigin?: string;
  /** Block id generator (tests pass a deterministic one). */
  newId?: () => string;
};

/** The poster placeholder of an imported video (rule 22: staff choose a media-library poster). */
export const NO_POSTER_ID = "00000000-0000-0000-0000-000000000000";

const SHORTCODE = /\[\/?([a-z][a-z0-9_-]*)(?:\s[^[\]]*)?\/?\]/gi;
const DROP_TAGS = new Set(["script", "style", "noscript", "form", "input", "button", "select", "textarea", "object", "embed", "svg", "canvas", "video", "audio", "template", "link", "meta"]);
const WRAPPERS = new Set(["div", "figure", "section", "article", "main", "header", "footer", "aside", "center", "body", "html", "nav"]);
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

type Seg = { kind: "inline"; node: RichInline } | { kind: "img"; src: string; alt: string } | { kind: "iframe"; src: string; title: string };

/** The YouTube id of an embed, watch or short URL, else null. */
export function youtubeIdOf(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim(), "https://www.youtube.com");
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^www\.|^m\./, "");
  let id: string | null = null;
  if (host === "youtu.be") id = u.pathname.slice(1).split("/")[0] ?? null;
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    const m = /^\/(?:embed|shorts|v)\/([^/?#]+)/.exec(u.pathname);
    id = m ? m[1]! : u.pathname === "/watch" ? u.searchParams.get("v") : null;
  }
  return id && YOUTUBE_ID.test(id) ? id : null;
}

class Converter {
  readonly blocks: Block[] = [];
  private doc: RichBlockNode[] = [];
  private readonly shortcodes = new Set<string>();
  private readonly unsupported = new Set<string>();
  private readonly iframes = new Set<string>();
  private readonly images = new Set<string>();
  private readonly links = new Set<string>();
  private videos = 0;
  private styles = 0;
  private empties = 0;
  private readonly alts: Record<string, string> = {};
  private readonly newId: () => string;
  private readonly origin: string | null;

  constructor(private readonly ctx: ConvertCtx) {
    this.newId = ctx.newId ?? randomUUID;
    this.origin = ctx.siteOrigin ? ctx.siteOrigin.replace(/\/+$/, "").toLowerCase() : null;
  }

  stripShortcodes(html: string): string {
    return html.replace(SHORTCODE, (_m, name: string) => {
      this.shortcodes.add(name.toLowerCase());
      return "";
    });
  }

  report(): ConvertReport {
    const sorted = (s: Set<string>) => [...s].sort();
    return {
      shortcodes: sorted(this.shortcodes),
      unsupportedTags: sorted(this.unsupported),
      droppedIframes: sorted(this.iframes),
      unresolvedImages: sorted(this.images),
      unresolvedLinks: sorted(this.links),
      videosWithoutPoster: this.videos,
      stylesDropped: this.styles,
      emptyParagraphsRemoved: this.empties,
      alts: this.alts,
    };
  }

  flush(): void {
    if (this.doc.length) this.blocks.push({ id: this.newId(), type: "rich_text", doc: { type: "doc", content: this.doc } });
    this.doc = [];
  }

  // ------------------------------------------------------------------------------------------
  // media
  // ------------------------------------------------------------------------------------------

  private absolute(src: string): string {
    const value = src.trim();
    if (/^https?:\/\//i.test(value)) return value;
    if (value.startsWith("//")) return `https:${value}`;
    if (this.origin && value.startsWith("/")) return `${this.origin}${value}`;
    return value;
  }

  private mediaIdFor(src: string): string | null {
    const abs = this.absolute(src);
    const noQuery = abs.split(/[?#]/)[0]!;
    const candidates = [abs, noQuery, noQuery.replace(/-\d+x\d+(\.[a-z0-9]+)$/i, "$1"), noQuery.replace(/^http:/i, "https:")];
    for (const c of candidates) {
      const id = this.ctx.mediaByUrl.get(c);
      if (id) return id;
    }
    return null;
  }

  image(src: string, alt: string, caption?: string): void {
    if (!src) return;
    const mediaId = this.mediaIdFor(src);
    if (!mediaId) {
      this.images.add(this.absolute(src));
      return;
    }
    this.flush();
    const block: Block = { id: this.newId(), type: "image", mediaId };
    const cap = caption?.replace(/\s+/g, " ").trim().slice(0, 300);
    if (cap) block.caption = cap;
    this.blocks.push(block);
    const cleanAlt = alt.replace(/\s+/g, " ").trim();
    if (cleanAlt && !this.alts[mediaId]) this.alts[mediaId] = cleanAlt.slice(0, 300);
  }

  iframe(src: string, title: string): void {
    const id = youtubeIdOf(src);
    if (id) return this.video(id, title);
    let host = src;
    try {
      host = new URL(this.absolute(src)).host;
    } catch {
      // keep the raw value
    }
    this.iframes.add(host || "iframe");
  }

  video(youtubeId: string, title: string): void {
    this.flush();
    this.blocks.push({ id: this.newId(), type: "video", youtubeId, title: (title.trim() || "YouTube video").slice(0, 200), posterMediaId: NO_POSTER_ID });
    this.videos++;
  }

  // ------------------------------------------------------------------------------------------
  // links and inline content
  // ------------------------------------------------------------------------------------------

  /** A safe href for a link, or null (the text stays, the link goes). */
  href(raw: string): string | null {
    const value = raw.trim();
    if (!value || value.startsWith("#")) return null;
    let candidate = value;
    const lower = value.toLowerCase();
    if (this.origin && (lower.startsWith(this.origin) || lower.startsWith(this.origin.replace(/^https:/, "http:")))) {
      const rest = value.slice(lower.startsWith("https:") ? this.origin.length : this.origin.length - 1);
      candidate = normalisePath(rest || "/");
    } else if (lower.startsWith("http://")) {
      this.links.add(value.slice(0, 200));
      return null;
    }
    if (isSafeHref(candidate)) return candidate;
    this.links.add(value.slice(0, 200));
    return null;
  }

  private noteStyle(el: HTMLElement): void {
    if (el.getAttribute("style") !== undefined) this.styles++;
  }

  inline(node: HtmlNode, marks: RichMark[], out: Seg[]): void {
    if (node.nodeType === NodeType.TEXT_NODE) {
      const text = node.text.replace(/[\s ]+/g, " ");
      if (text) out.push({ kind: "inline", node: marks.length ? { type: "text", text, marks: [...marks] } : { type: "text", text } });
      return;
    }
    if (node.nodeType !== NodeType.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    const tag = el.rawTagName?.toLowerCase() ?? "";
    this.noteStyle(el);
    if (DROP_TAGS.has(tag)) {
      this.unsupported.add(tag);
      return;
    }
    if (tag === "br") return void out.push({ kind: "inline", node: { type: "hardBreak" } });
    if (tag === "img") return void out.push({ kind: "img", src: el.getAttribute("src") ?? "", alt: el.getAttribute("alt") ?? "" });
    if (tag === "iframe") return void out.push({ kind: "iframe", src: el.getAttribute("src") ?? "", title: el.getAttribute("title") ?? "" });
    let next = marks;
    const add = (m: RichMark) => {
      if (!next.some((x) => x.type === m.type)) next = [...next, m];
    };
    if (tag === "strong" || tag === "b") add({ type: "bold" });
    else if (tag === "em" || tag === "i") add({ type: "italic" });
    else if (tag === "a") {
      const href = this.href(el.getAttribute("href") ?? "");
      if (href) add({ type: "link", attrs: { href } });
    }
    for (const child of el.childNodes) this.inline(child, next, out);
  }

  /** Inline segments -> trimmed, merged rich inlines (empty -> []). */
  private tidy(segs: readonly RichInline[]): RichInline[] {
    const out: RichInline[] = [];
    for (const s of segs) {
      const last = out[out.length - 1];
      if (s.type === "text" && last?.type === "text" && JSON.stringify(last.marks ?? []) === JSON.stringify(s.marks ?? [])) {
        out[out.length - 1] = { ...last, text: last.text + s.text };
      } else out.push(s);
    }
    while (out[0]?.type === "hardBreak") out.shift();
    while (out[out.length - 1]?.type === "hardBreak") out.pop();
    const first = out[0];
    if (first?.type === "text") out[0] = { ...first, text: first.text.replace(/^\s+/, "") };
    const lastIdx = out.length - 1;
    const last = out[lastIdx];
    if (last?.type === "text") out[lastIdx] = { ...last, text: last.text.replace(/\s+$/, "") };
    return out
      .filter((n) => n.type !== "text" || n.text.length > 0)
      .map((n) => (n.type === "text" && n.text.length > 10000 ? { ...n, text: n.text.slice(0, 10000) } : n));
  }

  private hasText(inlines: readonly RichInline[]): boolean {
    return inlines.some((n) => n.type === "text" && n.text.trim().length > 0);
  }

  /** A paragraph or heading from an element whose images and iframes split it into blocks. */
  textBlock(el: HTMLElement, make: (content: RichInline[]) => RichBlockNode): void {
    const segs: Seg[] = [];
    for (const child of el.childNodes) this.inline(child, [], segs);
    let run: RichInline[] = [];
    let emitted = false;
    const emit = () => {
      const content = this.tidy(run);
      run = [];
      if (!this.hasText(content)) return;
      emitted = true;
      this.doc.push(make(content.slice(0, 500)));
    };
    for (const s of segs) {
      if (s.kind === "inline") {
        run.push(s.node);
        continue;
      }
      emit();
      emitted = true;
      if (s.kind === "img") this.image(s.src, s.alt);
      else this.iframe(s.src, s.title);
    }
    emit();
    if (!emitted) this.empties++;
  }

  /** A list element -> a bullet or numbered list (nested lists kept), or null when empty. */
  list(el: HTMLElement): RichBlockNode | null {
    const ordered = el.rawTagName.toLowerCase() === "ol";
    const items: RichListItem[] = [];
    for (const li of el.childNodes) {
      if (li.nodeType !== NodeType.ELEMENT_NODE || (li as HTMLElement).rawTagName.toLowerCase() !== "li") continue;
      const content: RichListItem["content"] = [];
      const segs: Seg[] = [];
      for (const child of li.childNodes) {
        const tag = child.nodeType === NodeType.ELEMENT_NODE ? (child as HTMLElement).rawTagName.toLowerCase() : "";
        if (tag === "ul" || tag === "ol") {
          const nested = this.list(child as HTMLElement);
          if (nested && (nested.type === "bulletList" || nested.type === "orderedList")) content.push(nested);
          continue;
        }
        this.inline(child, [], segs);
      }
      const inlines = this.tidy(segs.flatMap((s) => (s.kind === "inline" ? [s.node] : [])));
      for (const s of segs) if (s.kind !== "inline") this.unsupported.add(s.kind === "img" ? "img_in_list" : "iframe_in_list");
      if (this.hasText(inlines)) content.unshift({ type: "paragraph", content: inlines.slice(0, 500) });
      if (content.length) items.push({ type: "listItem", content: content.slice(0, 20) });
    }
    if (!items.length) return null;
    return ordered ? { type: "orderedList", content: items.slice(0, 100) } : { type: "bulletList", content: items.slice(0, 100) };
  }

  block(node: HtmlNode): void {
    if (node.nodeType === NodeType.TEXT_NODE) {
      const raw = node.text.replace(/[\s ]+/g, " ").trim();
      if (!raw) return;
      const yt = /^https?:\/\/\S+$/.test(raw) ? youtubeIdOf(raw) : null;
      if (yt) return this.video(yt, "");
      this.doc.push({ type: "paragraph", content: [{ type: "text", text: raw.slice(0, 10000) }] });
      return;
    }
    if (node.nodeType !== NodeType.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    const tag = el.rawTagName?.toLowerCase() ?? "";
    this.noteStyle(el);
    if (DROP_TAGS.has(tag)) return void this.unsupported.add(tag);
    const heading = /^h([1-6])$/.exec(tag);
    if (heading) {
      const level = Math.min(4, Math.max(2, Number(heading[1]))) as 2 | 3 | 4;
      return this.textBlock(el, (content) => ({ type: "heading", attrs: { level }, content: content.slice(0, 100) }));
    }
    switch (tag) {
      case "p":
        return this.textBlock(el, (content) => ({ type: "paragraph", content }));
      case "ul":
      case "ol": {
        const list = this.list(el);
        if (list) this.doc.push(list);
        return;
      }
      case "blockquote": {
        const inner = new Converter({ ...this.ctx, newId: this.newId });
        for (const child of el.childNodes) inner.block(child);
        const parts = inner.doc.filter((n): n is Extract<RichBlockNode, { type: "paragraph" | "bulletList" | "orderedList" }> => n.type === "paragraph" || n.type === "bulletList" || n.type === "orderedList");
        this.merge(inner);
        if (parts.length) this.doc.push({ type: "blockquote", content: parts.slice(0, 50) });
        return;
      }
      case "img":
        return this.image(el.getAttribute("src") ?? "", el.getAttribute("alt") ?? "");
      case "iframe":
        return this.iframe(el.getAttribute("src") ?? "", el.getAttribute("title") ?? "");
      case "br":
      case "hr":
        return;
      case "table":
        this.unsupported.add("table");
        for (const row of el.querySelectorAll("tr")) {
          const text = row.querySelectorAll("th,td").map((c) => c.text.replace(/\s+/g, " ").trim()).filter(Boolean).join(" | ");
          if (text) this.doc.push({ type: "paragraph", content: [{ type: "text", text: text.slice(0, 10000) }] });
        }
        return;
      case "figcaption":
        return this.caption(el.text);
      default:
        if (WRAPPERS.has(tag) || el.querySelector("p,h1,h2,h3,h4,h5,h6,ul,ol,img,iframe,figure,div,blockquote,table")) {
          for (const child of el.childNodes) this.block(child);
          return;
        }
        return this.textBlock(el, (content) => ({ type: "paragraph", content }));
    }
  }

  /** A `figcaption` right after an image becomes its caption; otherwise a paragraph. */
  private caption(raw: string): void {
    const text = raw.replace(/\s+/g, " ").trim();
    if (!text) return;
    const last = this.blocks[this.blocks.length - 1];
    if (!this.doc.length && last?.type === "image" && !last.caption) {
      last.caption = text.slice(0, 300);
      return;
    }
    this.doc.push({ type: "paragraph", content: [{ type: "text", text: text.slice(0, 10000) }] });
  }

  /** Takes over the report and blocks of a nested converter (blockquote media go before the quote). */
  private merge(inner: Converter): void {
    const r = inner.report();
    r.shortcodes.forEach((s) => this.shortcodes.add(s));
    r.unsupportedTags.forEach((s) => this.unsupported.add(s));
    r.droppedIframes.forEach((s) => this.iframes.add(s));
    r.unresolvedImages.forEach((s) => this.images.add(s));
    r.unresolvedLinks.forEach((s) => this.links.add(s));
    this.videos += r.videosWithoutPoster;
    this.styles += r.stylesDropped;
    this.empties += r.emptyParagraphsRemoved;
    for (const [k, v] of Object.entries(r.alts)) this.alts[k] ??= v;
    if (inner.blocks.length) {
      this.flush();
      this.blocks.push(...inner.blocks);
    }
  }
}

/** Converts one WordPress post's HTML into blocks plus a report of what was dropped. */
export function htmlToBlocks(html: string, ctx: ConvertCtx): { blocks: Block[]; report: ConvertReport } {
  const c = new Converter(ctx);
  const root = parse(c.stripShortcodes(html ?? ""), { comment: false, blockTextElements: { script: false, style: false, noscript: false, pre: true } });
  for (const node of root.childNodes) c.block(node);
  c.flush();
  return { blocks: c.blocks, report: c.report() };
}

/** Sums reports (the import's `report` jsonb keeps the totals). */
export function mergeReports(reports: readonly ConvertReport[]): Omit<ConvertReport, "alts"> {
  const u = (pick: (r: ConvertReport) => string[]) => [...new Set(reports.flatMap(pick))].sort();
  return {
    shortcodes: u((r) => r.shortcodes),
    unsupportedTags: u((r) => r.unsupportedTags),
    droppedIframes: u((r) => r.droppedIframes),
    unresolvedImages: u((r) => r.unresolvedImages),
    unresolvedLinks: u((r) => r.unresolvedLinks),
    videosWithoutPoster: reports.reduce((n, r) => n + r.videosWithoutPoster, 0),
    stylesDropped: reports.reduce((n, r) => n + r.stylesDropped, 0),
    emptyParagraphsRemoved: reports.reduce((n, r) => n + r.emptyParagraphsRemoved, 0),
  };
}
