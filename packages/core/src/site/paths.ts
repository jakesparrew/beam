/**
 * Page paths, redirect keys and reserved segments (rules 9, 57 and 64).
 *
 * A page path is stored without locale prefix and without leading slash (`''` is home): lower
 * case `a-z0-9` words joined by hyphens, at most 3 segments of at most 60 characters.
 */
import { SITE_PREFIXES } from "./locales";

export const MAX_PATH_SEGMENTS = 3;
export const MAX_SEGMENT_LENGTH = 60;
export const MAX_PATH_LENGTH = 200;

/** First segments that belong to other modules' folders or this module's own routes (rule 9). */
export const RESERVED_SEGMENTS = [
  "account",
  "f",
  "claim",
  "checkout",
  "pay",
  "gift",
  "preferences",
  "webinars",
  "w",
  "api",
  "admin",
  "preview",
  "unavailable",
  "offline",
  "feed.xml",
  "sitemap.xml",
  "robots.txt",
  "manifest.webmanifest",
  "pwa-icon",
  "_next",
] as const;

/** Prefix-less WordPress paths that answer 410 Gone (rule 64). */
export const LEGACY_GONE_PREFIXES = ["/wp-admin", "/wp-login.php", "/xmlrpc.php", "/wp-json", "/wp-includes"] as const;

/** WordPress query parameters kept in redirect keys (`?p=123`, `?page_id=45`). */
export const KEPT_QUERY_PARAMS = ["p", "page_id"] as const;

const SEGMENT_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Normalises a redirect source or an incoming path: leading `/`, lower case, no trailing slash
 * except `/`, repeated slashes collapsed, fragment dropped, origin dropped, and the query dropped
 * except `p` and `page_id` (sorted, so equal links give equal keys).
 */
export function normalisePath(raw: string): string {
  let value = raw.trim();
  const hash = value.indexOf("#");
  if (hash >= 0) value = value.slice(0, hash);
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?]*/i, "");
  const q = value.indexOf("?");
  const pathPart = q >= 0 ? value.slice(0, q) : value;
  const queryPart = q >= 0 ? value.slice(q + 1) : "";
  let path = `/${pathPart}`.replace(/\/{2,}/g, "/").toLowerCase();
  if (path.length > 1) path = path.replace(/\/+$/, "") || "/";
  const params = new URLSearchParams(queryPart);
  const kept = KEPT_QUERY_PARAMS.filter((k) => params.get(k)).map((k) => `${k}=${encodeURIComponent(params.get(k)!.trim().toLowerCase())}`);
  return kept.length ? `${path}?${kept.join("&")}` : path;
}

/** Splits a stored page path (`'a/b'`) or URL path into segments, dropping empty ones. */
export function pathSegments(path: string): string[] {
  return path.split("/").filter(Boolean);
}

/** True when the path (without locale prefix) starts with a reserved segment or is `events/<uuid>`. */
export function isReservedPath(path: string): boolean {
  const segments = pathSegments(path.toLowerCase());
  const first = segments[0];
  if (!first) return false;
  if ((RESERVED_SEGMENTS as readonly string[]).includes(first)) return true;
  return first === "events" && segments.length === 2 && UUID_RE.test(segments[1]!);
}

/** The session id of a stable event link `events/<uuid>` (rule 57), segments after the locale. */
export function parseStableEventPath(segments: readonly string[]): string | null {
  if (segments.length !== 2 || segments[0] !== "events") return null;
  const id = segments[1]!;
  return UUID_RE.test(id) ? id.toLowerCase() : null;
}

/** True for a path that answers 410 Gone; accepts it with or without the locale prefix. */
export function isLegacyGone(path: string): boolean {
  let p = normalisePath(path).replace(/\?.*$/, "");
  for (const prefix of SITE_PREFIXES) {
    if (p === `/${prefix}`) return false;
    if (p.startsWith(`/${prefix}/`)) {
      p = p.slice(prefix.length + 1);
      break;
    }
  }
  return LEGACY_GONE_PREFIXES.some((g) => p === g || p.startsWith(`${g}/`));
}

export type PathIssueCode = "path_invalid" | "path_reserved" | "path_home_only" | "path_missing";

/**
 * Checks a page path for a page of `kind` (rule 9): `''` only for `home` (and `home` only `''`),
 * at most 3 segments of 60 characters, the segment grammar, no reserved first segment.
 */
export function pathIssue(path: string | undefined | null, kind: string): PathIssueCode | null {
  if (path === undefined || path === null) return "path_missing";
  if (kind === "home") return path === "" ? null : "path_home_only";
  if (path === "") return "path_home_only";
  if (path.length > MAX_PATH_LENGTH) return "path_invalid";
  const segments = path.split("/");
  if (segments.length > MAX_PATH_SEGMENTS) return "path_invalid";
  if (segments.some((s) => s.length > MAX_SEGMENT_LENGTH || !SEGMENT_RE.test(s))) return "path_invalid";
  if (isReservedPath(path)) return "path_reserved";
  return null;
}

/** True for a valid page path of any non-home page. */
export function isValidPagePath(path: string): boolean {
  return pathIssue(path, "standard") === null;
}

/** A slug-like path from free text (`Over ons!` -> `over-ons`), for imports and the editor. */
export function slugifySegment(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SEGMENT_LENGTH)
    .replace(/-+$/g, "");
}
