/**
 * The public request resolver (site rules 2, 11, 12, 57 and 64; edge cases 16-18, site-P2).
 *
 * Order: legacy-gone WordPress paths (410), the stable event link `events/<uuid>` (307), the
 * WordPress `?p=` / `?page_id=` links on home, the live route of the locale, a redirect for
 * `/<prefix>/<path>` and then for the prefix-less `/<path>`, the same path live in another
 * locale (307 to `unavailable`), an archived page's former path (410), else 404. Redirects to a
 * page resolve to its current route at request time, so renames never chain. The "seen" counter
 * of a redirect is written with `after()`, never on the response path.
 */
import { after } from "next/server";
import { cache } from "react";
import type { DbOrTx } from "@beam/db";
import { pageRoutes, pages, pageVersions, redirects } from "@beam/db/schema";
import { LOCALES, type Locale } from "@beam/core/i18n";
import { isLegacyGone, localePath, normalisePath, parseStableEventPath, prefixFromLocale } from "@beam/core/site";
import { and, eq, getAppDb, inArray, isNotNull, ne, sql } from "@/lib/ctx";
import { reportError } from "@/lib/logger";
import { getPageByPath, type ResolvedPage } from "../queries/public";
import { bookSessionPath, eventPagePath, isEventSession } from "./urls";

export type ResolveResult =
  | { kind: "page"; page: ResolvedPage }
  | { kind: "redirect"; to: string; permanent: boolean }
  | { kind: "gone" }
  | { kind: "not_found" };

type SearchParams = URLSearchParams | Record<string, string | string[] | undefined> | undefined;

function param(searchParams: SearchParams, key: string): string | null {
  if (!searchParams) return null;
  if (searchParams instanceof URLSearchParams) return searchParams.get(key);
  const v = searchParams[key];
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

function decodeSegments(segments: readonly string[] | undefined): string[] | null {
  try {
    return (segments ?? []).map((s) => decodeURIComponent(s)).filter(Boolean);
  } catch {
    return null;
  }
}

/** Counts a redirect as seen (approximate: once per resolver run, rule "seen at least n times"). */
function markSeen(redirectId: string): void {
  const write = async () => {
    try {
      const db = await getAppDb();
      await db
        .update(redirects)
        .set({ hits: sql`${redirects.hits} + 1`, lastHitAt: new Date() })
        .where(eq(redirects.id, redirectId));
    } catch (error) {
      reportError(error, { tags: { module: "site", step: "redirect_seen" } });
    }
  };
  try {
    after(write);
  } catch {
    // Outside a request scope (scripts): write directly.
    void write();
  }
}

type RedirectRow = { id: string; toPageId: string | null; toLocale: Locale | null; toUrl: string | null; isPermanent: boolean };

async function findRedirect(db: DbOrTx, keys: readonly string[]): Promise<RedirectRow | null> {
  const unique = [...new Set(keys)];
  if (!unique.length) return null;
  const rows = await db
    .select({ id: redirects.id, fromPath: redirects.fromPath, toPageId: redirects.toPageId, toLocale: redirects.toLocale, toUrl: redirects.toUrl, isPermanent: redirects.isPermanent })
    .from(redirects)
    .where(inArray(redirects.fromPath, unique));
  for (const key of unique) {
    const hit = rows.find((r) => r.fromPath === key);
    if (hit) return hit;
  }
  return null;
}

/** Where a redirect row points now: the target page's current route, its URL, or gone / not found. */
async function followRedirect(db: DbOrTx, row: RedirectRow): Promise<ResolveResult> {
  if (row.toUrl) {
    markSeen(row.id);
    return { kind: "redirect", to: row.toUrl, permanent: row.isPermanent };
  }
  if (!row.toPageId || !row.toLocale) return { kind: "not_found" };
  const [target] = await db
    .select({ status: pages.status, path: pageRoutes.path })
    .from(pages)
    .leftJoin(pageRoutes, and(eq(pageRoutes.pageId, pages.id), eq(pageRoutes.locale, row.toLocale)))
    .where(eq(pages.id, row.toPageId));
  if (!target) return { kind: "not_found" };
  if (target.status === "published" && target.path !== null) {
    markSeen(row.id);
    return { kind: "redirect", to: localePath(row.toLocale, target.path), permanent: row.isPermanent };
  }
  // Edge case 5: a redirect to a page archived without its own redirect answers 410.
  return target.status === "archived" ? { kind: "gone" } : { kind: "not_found" };
}

/** A former path of an archived page (any of its published versions) in `locale`. */
async function isArchivedPath(db: DbOrTx, locale: Locale, path: string): Promise<boolean> {
  const [row] = await db
    .select({ id: pages.id })
    .from(pages)
    .innerJoin(pageVersions, and(eq(pageVersions.pageId, pages.id), isNotNull(pageVersions.publishedAt)))
    .where(and(eq(pages.status, "archived"), sql`${pageVersions.paths} ->> ${locale} = ${path}`))
    .limit(1);
  return !!row;
}

/** A live page at the same path in another locale (edge case 16). */
async function otherLocalePage(db: DbOrTx, locale: Locale, path: string): Promise<string | null> {
  const [row] = await db
    .select({ pageId: pageRoutes.pageId })
    .from(pageRoutes)
    .innerJoin(pages, and(eq(pages.id, pageRoutes.pageId), eq(pages.status, "published")))
    .where(and(eq(pageRoutes.path, path), ne(pageRoutes.locale, locale)))
    .limit(1);
  return row?.pageId ?? null;
}

/**
 * Resolves `/<prefix>/<segments>` for the public site: the page to render, a redirect, gone or
 * not found. `searchParams` are only read for WordPress's `?p=` and `?page_id=` links on home.
 */
export async function resolveRequest(locale: Locale, segments: readonly string[] | undefined, searchParams?: SearchParams): Promise<ResolveResult> {
  const decoded = decodeSegments(segments);
  if (!decoded) return { kind: "not_found" };
  const prefix = prefixFromLocale(locale);
  const rawPath = decoded.join("/");
  const fullPath = `/${prefix}${rawPath ? `/${rawPath}` : ""}`;

  if (isLegacyGone(fullPath)) return { kind: "gone" };

  const db = await getAppDb();

  const sessionId = parseStableEventPath(decoded.map((s) => s.toLowerCase()));
  if (sessionId) {
    if (!(await isEventSession(db, sessionId))) return { kind: "not_found" };
    const page = await eventPagePath(db, sessionId, locale);
    return { kind: "redirect", to: page ?? bookSessionPath(locale, sessionId), permanent: false };
  }

  if (!rawPath) {
    const p = param(searchParams, "p");
    const pageId = param(searchParams, "page_id");
    if (p || pageId) {
      const query = new URLSearchParams();
      if (p) query.set("p", p);
      if (pageId) query.set("page_id", pageId);
      const row = await findRedirect(db, [normalisePath(`/${prefix}?${query}`), normalisePath(`/?${query}`)]);
      if (row) return followRedirect(db, row);
    }
  }

  const path = rawPath.toLowerCase();
  const page = await getPageByPath(locale, path);
  if (page) {
    // A mixed-case URL of a live page gets its canonical spelling.
    if (path !== rawPath) return { kind: "redirect", to: localePath(locale, path), permanent: true };
    return { kind: "page", page };
  }

  const prefixed = normalisePath(fullPath);
  const bare = normalisePath(`/${rawPath}`);
  const row = await findRedirect(db, rawPath ? [prefixed, bare] : [prefixed]);
  if (row) return followRedirect(db, row);

  if (path) {
    const other = await otherLocalePage(db, locale, path);
    if (other) return { kind: "redirect", to: `/${prefix}/unavailable?page=${other}`, permanent: false };
    if (await isArchivedPath(db, locale, path)) return { kind: "gone" };
  }
  return { kind: "not_found" };
}

/** Every locale's prefix, for callers that build alternate links. */
export const SITE_LOCALE_PREFIXES = LOCALES.map((l) => prefixFromLocale(l));

/**
 * Next.js pages can only answer 404 (and 401/403) through `notFound()`; a gone page marks the
 * request before calling it, so the site's not-found boundary renders the "no longer available"
 * text (React `cache` is request-scoped on the server).
 */
const goneState = cache(() => ({ gone: false }));
export function markGone(): void {
  goneState().gone = true;
}
export function isMarkedGone(): boolean {
  return goneState().gone;
}
