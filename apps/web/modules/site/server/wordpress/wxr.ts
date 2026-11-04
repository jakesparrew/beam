/**
 * WXR (WordPress eXtended RSS) parser (site spec section 2 `wordpress_import_items`, rules 52-53,
 * edge case 20; site-P7). Pure: no I/O. It keeps only pages, posts and attachments; authors
 * (`wp:author`, `dc:creator`), comments (`wp:comment`) and every other post type are dropped and
 * never returned, so they can never be stored.
 *
 * Locales and translation groups come from WPML (post meta `_wpml_language` / `wpml_language`,
 * `_wpml_trid` / `trid`) or Polylang (`<category domain="language">`, `<category
 * domain="post_translations">`), and otherwise from a `/nl/`, `/fr/` or `/en/` path prefix; an item
 * without any is `locale: null` (the import's default locale applies). Only `publish` items (and
 * `inherit` attachments, which carry no status of their own) default to `import`; drafts, private,
 * pending, future and trashed items default to `skip` (rule 52).
 */
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { parse as parseHtml } from "node-html-parser";
import type { Locale } from "@beam/core/i18n";
import { normalisePath } from "@beam/core/site";

export type WxrType = "page" | "post" | "attachment";

export type WxrItem = {
  wpId: number;
  wpType: WxrType;
  /** `publish`, `draft`, `private`, `inherit`, ... as in the file. */
  wpStatus: string;
  locale: Locale | null;
  translationGroup: string | null;
  parentWpId: number | null;
  title: string;
  /** The item's permalink as exported. */
  wpLink: string;
  /** `normalisePath(wpLink)`: the old path that gets a redirect. */
  wpPath: string;
  /** `wp:post_name`, empty when WordPress had none. */
  slug: string;
  contentHtml: string | null;
  excerpt: string | null;
  publishedAt: Date | null;
  attachmentUrl: string | null;
  decision: "import" | "skip";
};

export type WxrError = { line: number; message: string };

const TYPES: readonly WxrType[] = ["page", "post", "attachment"];
const ARRAY_TAGS = new Set(["item", "category", "wp:postmeta", "wp:comment", "wp:author", "wp:term", "wp:tag", "wp:category"]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  trimValues: true,
  processEntities: true,
  isArray: (name) => ARRAY_TAGS.has(name),
});

type Node = Record<string, unknown>;

/** The text of a parsed element (string, `#text`, or empty). */
function text(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object" && "#text" in (value as Node)) return text((value as Node)["#text"]);
  return "";
}

/** HTML entities decoded (`Caf&eacute; &amp; spa` -> `Café & spa`), whitespace collapsed. */
export function decodeText(value: string): string {
  if (!value) return "";
  return parseHtml(`<p>${value}</p>`).text.replace(/\s+/g, " ").trim();
}

const LOCALE_BY_CODE: Record<string, Locale> = { nl: "nl-BE", "nl-be": "nl-BE", nl_be: "nl-BE", fr: "fr-BE", "fr-be": "fr-BE", fr_be: "fr-BE", en: "en", "en-gb": "en", "en-us": "en", en_gb: "en", en_us: "en" };

/** `nl`, `nl_BE`, `fr-BE`, `en` ... -> a BEAM locale, else null. */
export function localeFromCode(code: string | null | undefined): Locale | null {
  if (!code) return null;
  return LOCALE_BY_CODE[code.trim().toLowerCase()] ?? null;
}

function localeFromPath(path: string): Locale | null {
  const m = /^\/(nl|fr|en)(\/|$|\?)/.exec(path);
  return m ? localeFromCode(m[1]) : null;
}

function int(value: unknown): number | null {
  const n = Number.parseInt(text(value), 10);
  return Number.isFinite(n) ? n : null;
}

/** `2024-01-02 10:00:00` (UTC, `wp:post_date_gmt`) -> Date; WordPress's zero date -> null. */
function gmtDate(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(value);
  if (!m || m[1] === "0000") return null;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 1-based line of the first `needle` in `xml` (0 when absent). */
function lineOf(xml: string, needle: string): number {
  const at = xml.indexOf(needle);
  if (at < 0) return 0;
  let line = 1;
  for (let i = 0; i < at; i++) if (xml.charCodeAt(i) === 10) line++;
  return line;
}

function metaOf(item: Node): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of (item["wp:postmeta"] as Node[] | undefined) ?? []) {
    const key = text(m["wp:meta_key"]);
    if (key) out.set(key, text(m["wp:meta_value"]));
  }
  return out;
}

function categories(item: Node): { domain: string; nicename: string }[] {
  return ((item.category as unknown[] | undefined) ?? []).map((c) => {
    const node = (typeof c === "object" && c ? c : {}) as Node;
    return { domain: text(node["@_domain"]), nicename: text(node["@_nicename"]) };
  });
}

/**
 * Parses a WXR export. Invalid XML returns no items and one error with the parser's line; an item
 * that cannot be used (no post id, an unusable link) is left out with an error naming its line.
 */
export function parseWxr(xml: string): { items: WxrItem[]; errors: WxrError[] } {
  const valid = XMLValidator.validate(xml);
  if (valid !== true) return { items: [], errors: [{ line: valid.err.line, message: valid.err.msg }] };

  let doc: Node;
  try {
    doc = parser.parse(xml) as Node;
  } catch (e) {
    return { items: [], errors: [{ line: 1, message: e instanceof Error ? e.message : String(e) }] };
  }
  const channel = ((doc.rss as Node | undefined)?.channel ?? null) as Node | null;
  if (!channel) return { items: [], errors: [{ line: 1, message: "Not a WordPress export: <rss><channel> is missing" }] };

  const items: WxrItem[] = [];
  const errors: WxrError[] = [];
  const seen = new Set<string>();
  for (const raw of (channel.item as Node[] | undefined) ?? []) {
    const wpType = text(raw["wp:post_type"]) as WxrType;
    if (!TYPES.includes(wpType)) continue;
    const wpId = int(raw["wp:post_id"]);
    const title = decodeText(text(raw.title));
    if (wpId === null || wpId <= 0) {
      errors.push({ line: lineOf(xml, title ? title : "<item>"), message: "Item without a valid wp:post_id" });
      continue;
    }
    const key = `${wpType}:${wpId}`;
    if (seen.has(key)) {
      errors.push({ line: lineOf(xml, `<wp:post_id>${wpId}</wp:post_id>`), message: `Duplicate ${wpType} ${wpId}` });
      continue;
    }
    seen.add(key);

    const wpLink = text(raw.link) || text(raw.guid);
    if (!wpLink) {
      errors.push({ line: lineOf(xml, `<wp:post_id>${wpId}</wp:post_id>`), message: `${wpType} ${wpId} has no link` });
      continue;
    }
    const wpPath = normalisePath(wpLink);
    const meta = metaOf(raw);
    const cats = categories(raw);
    const locale =
      localeFromCode(meta.get("_wpml_language") ?? meta.get("wpml_language")) ??
      localeFromCode(cats.find((c) => c.domain === "language")?.nicename) ??
      localeFromPath(wpPath);
    const group = meta.get("_wpml_trid") ?? meta.get("trid") ?? cats.find((c) => c.domain === "post_translations")?.nicename ?? null;
    const wpStatus = text(raw["wp:status"]) || (wpType === "attachment" ? "inherit" : "draft");
    const parent = int(raw["wp:post_parent"]);
    const contentHtml = text(raw["content:encoded"]) || null;
    const excerpt = decodeText(text(raw["excerpt:encoded"])) || null;
    const attachmentUrl = wpType === "attachment" ? text(raw["wp:attachment_url"]) || null : null;

    items.push({
      wpId,
      wpType,
      wpStatus,
      locale,
      translationGroup: group ? String(group).slice(0, 200) : null,
      parentWpId: parent && parent > 0 ? parent : null,
      title: title || (wpType === "attachment" ? (attachmentUrl?.split("/").pop() ?? `attachment-${wpId}`) : `${wpType} ${wpId}`),
      wpLink,
      wpPath,
      slug: text(raw["wp:post_name"]),
      contentHtml: wpType === "attachment" ? null : contentHtml,
      excerpt,
      publishedAt: gmtDate(text(raw["wp:post_date_gmt"])),
      attachmentUrl,
      decision: wpStatus === "publish" || (wpType === "attachment" && wpStatus === "inherit") ? "import" : "skip",
    });
  }
  return { items, errors };
}

/**
 * The CDN origins the file lists for `/wp-content/uploads/` (attachment URLs on another https host
 * than the site), which `WordpressMediaClient` may fetch from (site spec section 6).
 */
export function wxrCdnOrigins(items: readonly Pick<WxrItem, "attachmentUrl">[], siteOrigin: string): string[] {
  const site = siteOrigin.replace(/\/+$/, "").toLowerCase();
  const out = new Set<string>();
  for (const i of items) {
    if (!i.attachmentUrl) continue;
    try {
      const u = new URL(i.attachmentUrl);
      if (u.protocol === "https:" && u.origin.toLowerCase() !== site && u.pathname.startsWith("/wp-content/uploads/")) out.add(u.origin.toLowerCase());
    } catch {
      // not a URL: the media job reports the item
    }
  }
  return [...out].sort();
}
