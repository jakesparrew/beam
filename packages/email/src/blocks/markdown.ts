/**
 * The limited Markdown of `text` blocks (email spec rule 16): paragraphs, line breaks, bold
 * (`**x**`), italic (`*x*` or `_x_`), links (`[label](https://... or {{token}})`), bullet lists
 * (`- ` or `* `) and numbered lists (`1. `). Nothing else is interpreted; every other character
 * is HTML-escaped. Personalisation tokens (`{{first_name|friend}}`) pass through untouched, so
 * `personalise()` can fill them after compilation.
 */
import { escapeHtml } from "@beam/core/email";

export type MarkdownLink = { label: string; href: string };

type Inline = { kind: "para"; lines: string[] } | { kind: "ul"; items: string[] } | { kind: "ol"; items: string[] };

const TOKEN_RE = /\{\{[^{}]*\}\}/g;
const BULLET_RE = /^\s*[-*]\s+(.*)$/;
const NUMBER_RE = /^\s*\d+[.)]\s+(.*)$/;
const LINK_RE = /\[([^\]]+)\]\(((?:https:\/\/|mailto:|\{\{)[^\s)]*)\)/g;

/** Splits Markdown into paragraphs and lists. */
function parseBlocks(markdown: string): Inline[] {
  const out: Inline[] = [];
  let current: Inline | null = null;
  for (const raw of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      current = null;
      continue;
    }
    const bullet = BULLET_RE.exec(line);
    const number = bullet ? null : NUMBER_RE.exec(line);
    if (bullet) {
      if (current?.kind !== "ul") out.push((current = { kind: "ul", items: [] }));
      current.items.push(bullet[1] ?? "");
    } else if (number) {
      if (current?.kind !== "ol") out.push((current = { kind: "ol", items: [] }));
      current.items.push(number[1] ?? "");
    } else {
      if (current?.kind !== "para") out.push((current = { kind: "para", lines: [] }));
      current.lines.push(line.trim());
    }
  }
  return out;
}

/** Protects tokens from the emphasis rules (`_` in `first_name`). */
function shield(text: string): { text: string; restore: (s: string) => string } {
  const tokens: string[] = [];
  const shielded = text.replace(TOKEN_RE, (m) => {
    tokens.push(m);
    return `\u0000${tokens.length - 1}\u0000`;
  });
  return { text: shielded, restore: (s) => s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => tokens[Number(i)] ?? "") };
}

function inlineHtml(text: string, linkStyle: string): string {
  const { text: s, restore } = shield(text);
  const links: string[] = [];
  let out = s.replace(LINK_RE, (_m, label: string, href: string) => {
    links.push(`<a href="${escapeHtml(restore(href))}" style="${linkStyle}">${emphasis(escapeHtml(label))}</a>`);
    return `\u0001${links.length - 1}\u0001`;
  });
  out = emphasis(escapeHtml(out));
  out = out.replace(/\u0001(\d+)\u0001/g, (_m, i: string) => links[Number(i)] ?? "");
  return restore(out);
}

function emphasis(escaped: string): string {
  return escaped
    .replace(/\*\*(?=\S)([^*]*?\S)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*(?=\S)([^*]*?\S)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/(^|[^\w])_(?=\S)([^_]*?\S)_(?!\w)/g, "$1<em>$2</em>");
}

function inlineText(text: string): string {
  const { text: s, restore } = shield(text);
  const out = s
    .replace(LINK_RE, (_m, label: string, href: string) => `${label} (${href})`)
    .replace(/\*\*(?=\S)([^*]*?\S)\*\*/g, "$1")
    .replace(/(^|[^*\w])\*(?=\S)([^*]*?\S)\*(?!\*)/g, "$1$2")
    .replace(/(^|[^\w])_(?=\S)([^_]*?\S)_(?!\w)/g, "$1$2");
  return restore(out);
}

export type MarkdownHtmlOptions = { linkColor?: string; paragraphStyle?: string };

/** Markdown to an HTML fragment for `mj-text` (inline styles only). */
export function markdownToHtml(markdown: string, options: MarkdownHtmlOptions = {}): string {
  const linkStyle = `color:${options.linkColor ?? "#1f3a2e"};text-decoration:underline`;
  const p = options.paragraphStyle ?? "margin:0 0 16px";
  return parseBlocks(markdown)
    .map((b) => {
      if (b.kind === "para") return `<p style="${p}">${b.lines.map((l) => inlineHtml(l, linkStyle)).join("<br />")}</p>`;
      const tag = b.kind;
      return `<${tag} style="margin:0 0 16px;padding-left:24px">${b.items.map((i) => `<li>${inlineHtml(i, linkStyle)}</li>`).join("")}</${tag}>`;
    })
    .join("\n");
}

/** Markdown to plain text: links as `label (url)`, lists as `- item` and `1. item`. */
export function markdownToText(markdown: string): string {
  return parseBlocks(markdown)
    .map((b) => {
      if (b.kind === "para") return b.lines.map(inlineText).join("\n");
      if (b.kind === "ul") return b.items.map((i) => `- ${inlineText(i)}`).join("\n");
      return b.items.map((i, n) => `${n + 1}. ${inlineText(i)}`).join("\n");
    })
    .join("\n\n");
}

/** The links of a Markdown text, in order. */
export function markdownLinks(markdown: string): MarkdownLink[] {
  const { text, restore } = shield(markdown);
  return [...text.matchAll(LINK_RE)].map((m) => ({ label: restore(m[1] ?? ""), href: restore(m[2] ?? "") }));
}

/** Words of the visible text (tokens count as one word). */
export function countWords(text: string): number {
  return text
    .replace(TOKEN_RE, " x ")
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}
