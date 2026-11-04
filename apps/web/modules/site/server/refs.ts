/**
 * Reference facts for the publish checks (site rules 5, 6, 33; site-P3). `loadRefFacts` reads, with
 * the caller's db or transaction (OD-15), everything `checkPublishable` needs about the media,
 * forms, products, sessions, linked pages and webinars a version references, the live paths other
 * pages hold, and `settings.company.legal_name`. Forms and webinars are read through their
 * modules' `api.ts`; a function that is still a stub counts as "not published".
 */
import type { DbOrTx } from "@beam/db";
import { mediaAssets, pageRoutes, pages, pageVersions, products, redirects, sessions } from "@beam/db/schema";
import { NotImplementedError } from "@beam/core/errors";
import { LOCALES, type Locale } from "@beam/core/i18n";
import { checkPublishable, collectRefs, localePath, type CollectedRefs, type NavItem, type PageKind, type PublishIssue, type RefFacts, type VersionContent } from "@beam/core/site";
import { and, eq, inArray, ne, or, sql } from "@/lib/ctx";
import { reportError } from "@/lib/logger";
import { getPublishedFormMeta } from "@/modules/forms/api";
import { listPublicWebinars } from "@/modules/webinar/api";
import { getCompanySetting } from "./settings";
import type { PageRow, VersionRow } from "./versions";
import { versionContent } from "./versions";

export type RefInput = CollectedRefs & {
  page: RefFacts["page"];
  /** The version's paths per locale, for the `path_taken` check. */
  paths: Partial<Record<Locale, string>>;
};

function stubAware(error: unknown, step: string): void {
  if (!(error instanceof NotImplementedError)) reportError(error, { tags: { module: "site", step } });
}

/** `/<prefix>/<path>` of each locale's path. */
export function prefixedPaths(paths: Partial<Record<Locale, string>>): string[] {
  return Object.entries(paths)
    .filter((e): e is [Locale, string] => typeof e[1] === "string")
    .map(([l, p]) => localePath(l, p));
}

/** For archived pages: whether an `archive` redirect from one of their former paths exists (rule 6). */
async function archivedWithRedirect(db: DbOrTx, pageIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!pageIds.length) return out;
  const rows = await db
    .select({ pageId: pages.id, paths: pageVersions.paths })
    .from(pages)
    .innerJoin(pageVersions, eq(pageVersions.id, pages.currentVersionId))
    .where(inArray(pages.id, pageIds));
  for (const r of rows) {
    const from = prefixedPaths(r.paths ?? {});
    if (!from.length) continue;
    const [hit] = await db.select({ id: redirects.id }).from(redirects).where(inArray(redirects.fromPath, from)).limit(1);
    if (hit) out.add(r.pageId);
  }
  return out;
}

export async function loadRefFacts(db: DbOrTx, refs: RefInput): Promise<RefFacts> {
  const facts: RefFacts = { page: refs.page, media: {}, forms: {}, products: {}, sessions: {}, pages: {}, webinars: {}, takenPaths: {}, legalName: null };

  if (refs.mediaIds.length) {
    const rows = await db
      .select({ id: mediaAssets.id, alt: mediaAssets.alt, isDecorative: mediaAssets.isDecorative })
      .from(mediaAssets)
      .where(inArray(mediaAssets.id, refs.mediaIds));
    for (const r of rows) facts.media[r.id] = { alt: r.alt ?? {}, isDecorative: r.isDecorative };
  }

  for (const slug of refs.formSlugs) {
    try {
      const meta = await getPublishedFormMeta(db, slug);
      facts.forms[slug] = meta ? { locales: meta.locales } : null;
    } catch (error) {
      stubAware(error, "publish_check_form");
      facts.forms[slug] = null;
    }
  }

  if (refs.productIds.length) {
    const rows = await db.select({ id: products.id, isActive: products.isActive }).from(products).where(inArray(products.id, refs.productIds));
    for (const r of rows) facts.products[r.id] = { isActive: r.isActive };
  }

  const sessionIds = [...new Set([...refs.sessionIds, ...(refs.page.sessionId ? [refs.page.sessionId] : [])])];
  if (sessionIds.length) {
    const rows = await db.select({ id: sessions.id, kind: sessions.kind }).from(sessions).where(inArray(sessions.id, sessionIds));
    for (const r of rows) facts.sessions[r.id] = { kind: r.kind };
  }

  if (refs.pageIds.length) {
    const rows = await db.select({ id: pages.id, status: pages.status }).from(pages).where(inArray(pages.id, refs.pageIds));
    const archived = await archivedWithRedirect(
      db,
      rows.filter((r) => r.status === "archived").map((r) => r.id),
    );
    for (const r of rows) facts.pages[r.id] = { status: r.status, hasRedirect: archived.has(r.id) };
  }

  if (refs.webinarIds.length) {
    try {
      const list = await listPublicWebinars(db, { locale: "en", from: new Date(0), limit: 500 });
      for (const w of list) facts.webinars[w.id] = true;
    } catch (error) {
      stubAware(error, "publish_check_webinar");
    }
  }

  const wanted = Object.entries(refs.paths).filter((e): e is [Locale, string] => typeof e[1] === "string");
  if (wanted.length) {
    const rows = await db
      .select({ locale: pageRoutes.locale, path: pageRoutes.path, pageId: pageRoutes.pageId })
      .from(pageRoutes)
      .where(and(ne(pageRoutes.pageId, refs.page.id), or(...wanted.map(([l, p]) => and(eq(pageRoutes.locale, l), eq(pageRoutes.path, p))))));
    for (const r of rows) facts.takenPaths[`${r.locale}:${r.path}`] = r.pageId;
  }

  if (refs.page.legalKey === "privacy_notice") {
    const company = await getCompanySetting(db);
    facts.legalName = company.legal_name?.trim() || null;
  }
  return facts;
}

/** `RefFacts.page` of a page row. */
export function refPage(page: Pick<PageRow, "id" | "kind" | "legalKey" | "sessionId">): RefFacts["page"] {
  return { id: page.id, kind: page.kind as PageKind, legalKey: page.legalKey ?? null, sessionId: page.sessionId ?? null };
}

/** Every publish issue of `content` on `page` (rules 5, 6, 33). */
export async function checkContent(db: DbOrTx, page: Pick<PageRow, "id" | "kind" | "legalKey" | "sessionId">, content: VersionContent): Promise<PublishIssue[]> {
  const facts = await loadRefFacts(db, { ...collectRefs(content), page: refPage(page), paths: content.paths });
  return checkPublishable(content, facts);
}

/** Every publish issue of a stored version. */
export function checkVersion(db: DbOrTx, page: Pick<PageRow, "id" | "kind" | "legalKey" | "sessionId">, version: VersionRow): Promise<PublishIssue[]> {
  return checkContent(db, page, versionContent(version));
}

/**
 * The kind of the live page at `path` in `locale` (forms rule A2 branch 7: a form on a BEAM
 * landing page). `path` is the site path with or without the locale prefix (`/nl/actie`,
 * `actie`, `''` for home); null when no published page holds it.
 */
export async function getPageKindByPath(db: DbOrTx, locale: Locale, path: string): Promise<PageKind | null> {
  const prefix = localePath(locale, "");
  let clean = path.split("?")[0]!.split("#")[0]!.toLowerCase();
  if (clean === prefix || clean.startsWith(`${prefix}/`)) clean = clean.slice(prefix.length);
  clean = clean.replace(/^\/+|\/+$/g, "");
  const [row] = await db
    .select({ kind: pages.kind })
    .from(pageRoutes)
    .innerJoin(pages, eq(pages.id, pageRoutes.pageId))
    .where(and(eq(pageRoutes.locale, locale), eq(pageRoutes.path, clean), eq(pages.status, "published")))
    .limit(1);
  return (row?.kind as PageKind | undefined) ?? null;
}

export type HiddenNavTarget = { menu: "header" | "footer" | "legal"; itemId: string; pageId: string; locale: Locale };

/**
 * Menu items whose target page is unpublished, archived or has no live route in a locale: the
 * public menu hides them there (rule 24) and `/admin/site` lists them (`nav_target_hidden`).
 */
export async function hiddenNavTargets(db: DbOrTx, menu: HiddenNavTarget["menu"], items: readonly NavItem[]): Promise<HiddenNavTarget[]> {
  const flat = items.flatMap((i) => [i, ...(i.children ?? [])]);
  const pageTargets = flat.flatMap((i) => (i.target.kind === "page" ? [{ itemId: i.id, pageId: i.target.pageId }] : []));
  if (!pageTargets.length) return [];
  const pageIds = [...new Set(pageTargets.map((t) => t.pageId))];
  const routes = await db
    .select({ pageId: pageRoutes.pageId, locale: pageRoutes.locale })
    .from(pageRoutes)
    .innerJoin(pages, eq(pages.id, pageRoutes.pageId))
    .where(and(inArray(pageRoutes.pageId, pageIds), eq(pages.status, "published")));
  const live = new Set(routes.map((r) => `${r.pageId}:${r.locale}`));
  const out: HiddenNavTarget[] = [];
  for (const t of pageTargets) for (const locale of LOCALES) if (!live.has(`${t.pageId}:${locale}`)) out.push({ menu, itemId: t.itemId, pageId: t.pageId, locale });
  return out;
}

/** Ids of versions (drafts, proposals and live versions) whose content references a media asset. */
export async function versionsUsingMedia(db: DbOrTx, mediaId: string): Promise<string[]> {
  const needle = `%${mediaId}%`;
  const rows = await db
    .select({ id: pageVersions.id })
    .from(pageVersions)
    .leftJoin(pages, eq(pages.currentVersionId, pageVersions.id))
    .where(
      and(
        or(inArray(pageVersions.state, ["draft", "proposed"]), and(eq(pages.status, "published"), eq(pages.currentVersionId, pageVersions.id))),
        or(eq(pageVersions.coverMediaId, mediaId), sql`${pageVersions.blocks}::text like ${needle}`, sql`${pageVersions.seo}::text like ${needle}`),
      ),
    );
  return rows.map((r) => r.id);
}
