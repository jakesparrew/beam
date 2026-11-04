/**
 * Applying a WordPress import (site rules 52-53, 64-66, edge cases 17-20 and 40; site-P7). Every
 * function takes the caller's transaction. The jobs of `jobs/wordpress.ts` and the actions of
 * `actions/wordpress.ts` are thin wrappers around these.
 *
 * - `storeWxrItems` upserts the parsed items on `(import_id, wp_type, wp_id)` (content only; the
 *   staff's mapping and the item status are never overwritten).
 * - `applyImportChunk` walks the import's items in a stable order (`wp_type`, translation group,
 *   `wp_id`) and converts the `pending` ones in `[offset, offset + limit)`: a translation group
 *   (WPML `trid`, Polylang group) becomes one page with one locale per member; each page and post
 *   is a draft v1 (`created_by = 'user'`, `created_by_user_id` = importer, rule 52); each old path
 *   gets a `source = 'wordpress'` redirect (rule 53). `skip` items become `skipped`, `redirect_only`
 *   items only get their redirect, an item whose `wp_link` an earlier import already imported is
 *   `skipped` "already imported" (rule 65). Attachments to import are left to the media job.
 * - `importMediaChunk` fetches up to 20 attachments through the WordPress client, stores them with
 *   `storeFile` and inserts `media_assets` (a fetched `wordpress_url` is reused, never fetched
 *   twice), and redirects the attachment URL and page to the file URL.
 * - `retryImportTx` and `publishImportedPagesTx` back `retryImportErrors` and `publishImportedPages`.
 * Re-running any of them creates nothing new: items move out of `pending` once, page slugs and
 * redirects are unique, media rows are unique on `wordpress_url`.
 */
import type { Tx } from "@beam/db";
import { mediaAssets, pages, redirects, wordpressImportItems, wordpressImports, type WordpressImportCounts } from "@beam/db/schema";
import type { Locale } from "@beam/core/i18n";
import { isReservedPath, localePath, normalisePath, pathIssue, slugifySegment, type Block, type PageKind, type PublishIssue, type VersionContent } from "@beam/core/site";
import { and, asc, ConflictError, eq, inArray, isNotNull, ne, NotFoundError, sql, type Ctx, type DbOrTx } from "@/lib/ctx";
import { blocksToPlainText } from "../legal";
import { findDraft, getVersionOrThrow, insertDraft, updateDraftContent, versionContent } from "../versions";
import { htmlToBlocks, mergeReports, type ConvertReport } from "./convert";
import type { WxrItem } from "./wxr";

export type ImportRow = typeof wordpressImports.$inferSelect;
export type ImportItemRow = typeof wordpressImportItems.$inferSelect;

export const APPLY_CHUNK = 50;
export const MEDIA_CHUNK = 20;
export const ALREADY_IMPORTED = "already imported";
/** Rule 64: the WordPress feed moves to the Dutch RSS feed. */
export const FEED_REDIRECT = { fromPath: "/feed", toUrl: "/nl/feed.xml" } as const;

/** The import's working state kept in `wordpress_imports.report` besides the conversion report. */
export type ImportReport = {
  round?: number;
  mediaNext?: number;
  cdnOrigins?: string[];
  parseErrors?: { line: number; message: string }[];
  parseError?: { line: number; message: string };
  lastError?: string | undefined;
  convert?: Omit<ConvertReport, "alts">;
};

export const reportOf = (row: Pick<ImportRow, "report">): ImportReport => (row.report ?? {}) as ImportReport;

export async function lockImport(tx: Tx, importId: string): Promise<ImportRow | null> {
  const [row] = await tx.select().from(wordpressImports).where(eq(wordpressImports.id, importId)).for("update");
  return row ?? null;
}

export async function getImportRow(db: DbOrTx, importId: string): Promise<ImportRow | null> {
  const [row] = await db.select().from(wordpressImports).where(eq(wordpressImports.id, importId));
  return row ?? null;
}

/** Writes `patch` over the import's report and counts (shallow merge). */
export async function patchImport(tx: Tx, imp: ImportRow, patch: { status?: ImportRow["status"]; report?: ImportReport; counts?: WordpressImportCounts; appliedAt?: Date }, now: Date): Promise<ImportRow> {
  const [row] = await tx
    .update(wordpressImports)
    .set({
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.report ? { report: { ...reportOf(imp), ...patch.report } } : {}),
      ...(patch.counts ? { counts: { ...imp.counts, ...patch.counts } } : {}),
      ...(patch.appliedAt ? { appliedAt: patch.appliedAt } : {}),
      updatedAt: now,
    })
    .where(eq(wordpressImports.id, imp.id))
    .returning();
  return row!;
}

// ---------------------------------------------------------------------------------------------
// parse
// ---------------------------------------------------------------------------------------------

/** Upserts parsed items; a re-parse updates their content but never the decision or status. */
export async function storeWxrItems(tx: Tx, importId: string, items: readonly WxrItem[]): Promise<void> {
  for (let i = 0; i < items.length; i += 200) {
    const rows = items.slice(i, i + 200).map((it) => ({
      importId,
      wpId: it.wpId,
      wpType: it.wpType,
      wpStatus: it.wpStatus,
      locale: it.locale,
      translationGroup: it.translationGroup,
      parentWpId: it.parentWpId,
      title: it.title,
      wpLink: it.wpLink,
      wpPath: it.wpPath,
      contentHtml: it.contentHtml,
      excerpt: it.excerpt,
      publishedAt: it.publishedAt,
      attachmentUrl: it.attachmentUrl,
      decision: it.decision,
    }));
    await tx
      .insert(wordpressImportItems)
      .values(rows)
      .onConflictDoUpdate({
        target: [wordpressImportItems.importId, wordpressImportItems.wpType, wordpressImportItems.wpId],
        set: {
          wpStatus: sql`excluded.wp_status`,
          locale: sql`excluded.locale`,
          translationGroup: sql`excluded.translation_group`,
          parentWpId: sql`excluded.parent_wp_id`,
          title: sql`excluded.title`,
          wpLink: sql`excluded.wp_link`,
          wpPath: sql`excluded.wp_path`,
          contentHtml: sql`excluded.content_html`,
          excerpt: sql`excluded.excerpt`,
          publishedAt: sql`excluded.published_at`,
          attachmentUrl: sql`excluded.attachment_url`,
          updatedAt: sql`now()`,
        },
      });
  }
}

/** `{ pages, posts, attachments, imported, skipped, errors }` of an import, from its items. */
export async function itemCounts(db: DbOrTx, importId: string): Promise<WordpressImportCounts> {
  const rows = await db
    .select({ type: wordpressImportItems.wpType, status: wordpressImportItems.status, n: sql<number>`count(*)::int` })
    .from(wordpressImportItems)
    .where(eq(wordpressImportItems.importId, importId))
    .groupBy(wordpressImportItems.wpType, wordpressImportItems.status);
  const sum = (pick: (r: (typeof rows)[number]) => boolean) => rows.filter(pick).reduce((n, r) => n + Number(r.n), 0);
  return {
    pages: sum((r) => r.type === "page"),
    posts: sum((r) => r.type === "post"),
    attachments: sum((r) => r.type === "attachment"),
    imported: sum((r) => r.status === "imported"),
    skipped: sum((r) => r.status === "skipped"),
    errors: sum((r) => r.status === "error"),
  };
}

// ---------------------------------------------------------------------------------------------
// redirects
// ---------------------------------------------------------------------------------------------

const BLOCKED_FROM = /^\/(admin|api|_next)(\/|$|\?)/;
const LOCALE_ROOT = /^\/(nl|fr|en)$/;

/** Inserts a `wordpress` redirect unless the source is unusable or taken; returns 1 when inserted. */
export async function insertWpRedirect(tx: Tx, rawFrom: string, target: { pageId: string; locale: Locale } | { url: string }): Promise<number> {
  const fromPath = normalisePath(rawFrom);
  if (fromPath === "/" || BLOCKED_FROM.test(fromPath) || LOCALE_ROOT.test(fromPath)) return 0;
  if ("url" in target && target.url === fromPath) return 0;
  const values =
    "url" in target
      ? { fromPath, toPageId: null, toLocale: null, toUrl: target.url, isPermanent: true, source: "wordpress" as const }
      : { fromPath, toPageId: target.pageId, toLocale: target.locale, toUrl: null, isPermanent: true, source: "wordpress" as const };
  const rows = await tx.insert(redirects).values(values).onConflictDoNothing({ target: redirects.fromPath }).returning({ id: redirects.id });
  return rows.length;
}

/** Rule 64, once per site: `/feed` -> `/nl/feed.xml`. */
export async function insertFeedRedirect(tx: Tx): Promise<number> {
  return insertWpRedirect(tx, FEED_REDIRECT.fromPath, { url: FEED_REDIRECT.toUrl });
}

/** The WordPress fallback permalink of an item (`/?page_id=45`, `/?p=123`). */
export function fallbackPermalink(item: Pick<ImportItemRow, "wpType" | "wpId">): string {
  return item.wpType === "page" ? `/?page_id=${item.wpId}` : `/?p=${item.wpId}`;
}

/** The public URL of a stored file (platform's `/api/public/files/[id]`). */
export const fileUrl = (fileId: string): string => `/api/public/files/${fileId}`;

// ---------------------------------------------------------------------------------------------
// pages
// ---------------------------------------------------------------------------------------------

const KIND_BY_TYPE: Record<"page" | "post", PageKind> = { page: "standard", post: "post" };

/** The new page path (no locale prefix) for an old WordPress path, falling back to the title. */
export function pagePathFor(item: Pick<ImportItemRow, "wpPath" | "title" | "wpId" | "wpType">): string {
  const bare = item.wpPath.replace(/\?.*$/, "");
  let segments = bare.split("/").filter(Boolean);
  if (segments[0] && /^(nl|fr|en)$/.test(segments[0])) segments = segments.slice(1);
  segments = segments.map(slugifySegment).filter(Boolean).slice(-3);
  const candidates = [segments.join("/"), slugifySegment(item.title), `${item.wpType}-${item.wpId}`];
  for (const c of candidates) if (c && pathIssue(c, "standard") === null && !isReservedPath(c)) return c;
  return `wp-${item.wpType}-${item.wpId}`;
}

/** 50-160 characters of description from the excerpt or the text, cut at a word. */
export function seoDescription(excerpt: string | null, blocks: readonly Block[]): string {
  const text = (excerpt || blocksToPlainText(blocks)).replace(/\s+/g, " ").trim();
  if (text.length <= 160) return text;
  const cut = text.slice(0, 159);
  const space = cut.lastIndexOf(" ");
  return `${(space > 80 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, "")}…`;
}

async function uniqueSlug(tx: Tx, base: string): Promise<string> {
  const stem = (slugifySegment(base) || "wp-page").slice(0, 72).replace(/-+$/, "");
  const taken = new Set(
    (await tx.select({ slug: pages.slug }).from(pages).where(sql`${pages.slug} = ${stem} or ${pages.slug} like ${`${stem}-%`}`)).map((r) => r.slug),
  );
  if (!taken.has(stem)) return stem;
  for (let i = 2; ; i++) if (!taken.has(`${stem}-${i}`)) return `${stem}-${i}`;
}

type Mapped = { item: ImportItemRow; locale: Locale };

/** Content of one locale of an imported item. */
function localeContent(m: Mapped, imp: ImportRow, mediaByUrl: Map<string, string>, kind: PageKind) {
  const { blocks, report } = htmlToBlocks(m.item.contentHtml ?? "", { mediaByUrl, siteOrigin: imp.siteOrigin });
  const title = m.item.title.replace(/\s+/g, " ").trim().slice(0, 120);
  const description = seoDescription(m.item.excerpt, blocks);
  return {
    title,
    path: pagePathFor(m.item),
    blocks,
    seo: { title: title.slice(0, 70), description },
    excerpt: kind === "post" ? (m.item.excerpt || description).slice(0, 300) : null,
    report,
  };
}

/** Writes alt texts found in the HTML onto media rows that lack one for the locale. */
async function fillAlts(tx: Tx, locale: Locale, alts: Record<string, string>): Promise<void> {
  for (const [mediaId, alt] of Object.entries(alts)) {
    await tx
      .update(mediaAssets)
      .set({ alt: sql`${mediaAssets.alt} || jsonb_build_object(${locale}::text, ${alt}::text)` })
      .where(and(eq(mediaAssets.id, mediaId), sql`not (${mediaAssets.alt} ? ${locale})`));
  }
}

/** Ids of items with this `wp_link` that an earlier (other) import already imported. */
async function importedElsewhere(tx: Tx, imp: ImportRow, links: string[]): Promise<Set<string>> {
  if (!links.length) return new Set();
  const rows = await tx
    .select({ link: wordpressImportItems.wpLink })
    .from(wordpressImportItems)
    .where(and(ne(wordpressImportItems.importId, imp.id), inArray(wordpressImportItems.wpLink, links), eq(wordpressImportItems.status, "imported")));
  return new Set(rows.map((r) => r.link));
}

async function setItem(tx: Tx, id: string, patch: Partial<Pick<ImportItemRow, "status" | "message" | "targetPageId" | "targetMediaId">>, now: Date): Promise<void> {
  await tx.update(wordpressImportItems).set({ ...patch, updatedAt: now }).where(eq(wordpressImportItems.id, id));
}

/**
 * Imports a translation group (or a single item) as one page: a new draft v1, or, when an earlier
 * chunk or round already created the page for this group, the missing locales merged into its
 * draft. Returns the redirects created and the conversion reports.
 */
async function importGroup(tx: Tx, ctx: Ctx, imp: ImportRow, first: ImportItemRow, mediaByUrl: Map<string, string>): Promise<{ redirects: number; reports: ConvertReport[] }> {
  const type = first.wpType as "page" | "post";
  const kind = KIND_BY_TYPE[type];
  const groupWhere = first.translationGroup
    ? and(eq(wordpressImportItems.importId, imp.id), eq(wordpressImportItems.wpType, first.wpType), eq(wordpressImportItems.translationGroup, first.translationGroup))
    : eq(wordpressImportItems.id, first.id);
  const group = await tx.select().from(wordpressImportItems).where(groupWhere).orderBy(asc(wordpressImportItems.wpId));
  const existingPageId = group.find((g) => g.targetPageId)?.targetPageId ?? null;
  const pending = group.filter((g) => g.status === "pending" && g.decision === "import");
  const elsewhere = await importedElsewhere(tx, imp, pending.map((p) => p.wpLink));

  const chosen: Mapped[] = [];
  const taken = new Set<Locale>(group.filter((g) => g.status === "imported" && g.targetPageId).map((g) => g.locale ?? imp.defaultLocale));
  for (const item of pending) {
    if (elsewhere.has(item.wpLink)) {
      await setItem(tx, item.id, { status: "skipped", message: ALREADY_IMPORTED }, ctx.now);
      continue;
    }
    const locale = item.locale ?? imp.defaultLocale;
    if (taken.has(locale)) {
      await setItem(tx, item.id, { status: "error", message: `duplicate locale ${locale} in translation group` }, ctx.now);
      continue;
    }
    taken.add(locale);
    chosen.push({ item, locale });
  }
  if (!chosen.length) return { redirects: 0, reports: [] };

  const parts = chosen.map((m) => ({ m, c: localeContent(m, imp, mediaByUrl, kind) }));
  let pageId = existingPageId;
  const base: VersionContent = { title: {}, paths: {}, blocks: {}, seo: {}, excerpt: null, coverMediaId: null, locales: [], isMaterialChange: false };
  const draft = pageId ? await findDraft(tx, pageId) : null;
  const content: VersionContent = draft ? versionContent(draft) : base;
  if (pageId && !draft) {
    const [page] = await tx.select({ currentVersionId: pages.currentVersionId }).from(pages).where(eq(pages.id, pageId));
    if (page?.currentVersionId) Object.assign(content, versionContent(await getVersionOrThrow(tx, page.currentVersionId)));
  }
  const next: VersionContent = {
    ...content,
    title: { ...content.title },
    paths: { ...content.paths },
    blocks: { ...content.blocks },
    seo: { ...content.seo },
    excerpt: content.excerpt ? { ...content.excerpt } : kind === "post" ? {} : null,
    locales: [...content.locales],
  };
  for (const { m, c } of parts) {
    next.title[m.locale] = c.title;
    next.paths[m.locale] = c.path;
    next.blocks[m.locale] = c.blocks;
    next.seo[m.locale] = c.seo;
    if (c.excerpt !== null && next.excerpt) next.excerpt[m.locale] = c.excerpt;
    if (!next.locales.includes(m.locale)) next.locales.push(m.locale);
    await fillAlts(tx, m.locale, c.report.alts);
  }

  if (!pageId) {
    const nl = parts.find((p) => p.m.locale === "nl-BE") ?? parts[0]!;
    const slugBase = nl.c.path.split("/").pop() || nl.c.title || `${type}-${nl.m.item.wpId}`;
    const [page] = await tx.insert(pages).values({ kind, slug: await uniqueSlug(tx, slugBase), status: "draft" }).returning({ id: pages.id });
    pageId = page!.id;
  }
  if (draft) await updateDraftContent(tx, draft, next);
  else await insertDraft(tx, { pageId, content: { ...next, changeSummary: "WordPress import" }, basedOnVersionId: null, userId: imp.createdByUserId });

  let created = 0;
  for (const { m, c } of parts) {
    await setItem(tx, m.item.id, { status: "imported", message: null, targetPageId: pageId }, ctx.now);
    const target = { pageId, locale: m.locale };
    const live = localePath(m.locale, c.path);
    for (const from of [m.item.wpPath, fallbackPermalink(m.item)]) if (normalisePath(from) !== live) created += await insertWpRedirect(tx, from, target);
  }
  return { redirects: created, reports: parts.map((p) => p.c.report) };
}

/** A `redirect_only` item: its old path (and attachment URL) redirect to the chosen page. */
async function redirectOnly(tx: Tx, ctx: Ctx, imp: ImportRow, item: ImportItemRow): Promise<number> {
  if (!item.redirectToPageId) {
    await setItem(tx, item.id, { status: "error", message: "redirect target missing" }, ctx.now);
    return 0;
  }
  const target = { pageId: item.redirectToPageId, locale: item.locale ?? imp.defaultLocale };
  let n = await insertWpRedirect(tx, item.wpPath, target);
  if (item.wpType !== "attachment") n += await insertWpRedirect(tx, fallbackPermalink(item), target);
  if (item.attachmentUrl) n += await insertWpRedirect(tx, item.attachmentUrl, target);
  await setItem(tx, item.id, { status: "imported", message: null }, ctx.now);
  return n;
}

/** Every `media_assets.wordpress_url` -> media id (what `htmlToBlocks` resolves images with). */
export async function wordpressMediaMap(db: DbOrTx): Promise<Map<string, string>> {
  const rows = await db.select({ id: mediaAssets.id, url: mediaAssets.wordpressUrl }).from(mediaAssets).where(isNotNull(mediaAssets.wordpressUrl));
  return new Map(rows.map((r) => [r.url!, r.id]));
}

const ITEM_ORDER = [asc(wordpressImportItems.wpType), sql`${wordpressImportItems.translationGroup} asc nulls last`, asc(wordpressImportItems.wpId)] as const;

/**
 * Converts the `pending` items of `[offset, offset + limit)` (stable order) into pages and
 * redirects. A failing group marks its items `error` (savepoint) and the chunk goes on. Returns the
 * next offset, or null after the last chunk.
 */
export async function applyImportChunk(tx: Tx, ctx: Ctx, importId: string, offset: number, limit = APPLY_CHUNK): Promise<{ next: number | null }> {
  const imp = await getImportRow(tx, importId);
  if (!imp) return { next: null };
  const rows = await tx.select().from(wordpressImportItems).where(eq(wordpressImportItems.importId, importId)).orderBy(...ITEM_ORDER).limit(limit + 1).offset(offset);
  const chunk = rows.slice(0, limit);
  const mediaByUrl = await wordpressMediaMap(tx);
  const reports: ConvertReport[] = [];
  let created = 0;

  for (const listed of chunk) {
    const [item] = await tx.select().from(wordpressImportItems).where(eq(wordpressImportItems.id, listed.id));
    if (!item || item.status !== "pending") continue;
    if (item.decision === "skip") {
      await setItem(tx, item.id, { status: "skipped", message: null }, ctx.now);
      continue;
    }
    if (item.wpType === "attachment" && item.decision === "import") continue;
    if ((await importedElsewhere(tx, imp, [item.wpLink])).size) {
      await setItem(tx, item.id, { status: "skipped", message: ALREADY_IMPORTED }, ctx.now);
      continue;
    }
    try {
      await tx.transaction(async (sp) => {
        if (item.decision === "redirect_only") created += await redirectOnly(sp, ctx, imp, item);
        else {
          const out = await importGroup(sp, ctx, imp, item, mediaByUrl);
          created += out.redirects;
          reports.push(...out.reports);
        }
      });
    } catch (e) {
      const message = (e instanceof Error ? e.message : String(e)).slice(0, 500);
      const ids = item.translationGroup
        ? (await tx.select({ id: wordpressImportItems.id }).from(wordpressImportItems).where(and(eq(wordpressImportItems.importId, imp.id), eq(wordpressImportItems.translationGroup, item.translationGroup), eq(wordpressImportItems.wpType, item.wpType), eq(wordpressImportItems.status, "pending")))).map((r) => r.id)
        : [item.id];
      await tx.update(wordpressImportItems).set({ status: "error", message, updatedAt: ctx.now }).where(inArray(wordpressImportItems.id, ids));
    }
  }

  const fresh = (await getImportRow(tx, importId))!;
  const previous = reportOf(fresh).convert;
  const convert = reports.length ? mergeReports(previous ? [{ ...previous, alts: {} }, ...reports] : reports) : previous;
  await patchImport(tx, fresh, { ...(convert ? { report: { convert } } : {}), counts: { ...(await itemCounts(tx, importId)), redirects: (fresh.counts.redirects ?? 0) + created } }, ctx.now);
  return { next: rows.length > limit ? offset + limit : null };
}

// ---------------------------------------------------------------------------------------------
// media
// ---------------------------------------------------------------------------------------------

/** What the media job needs from a client (`WordpressMediaClient` or a test double). */
export type MediaFetcher = { fetchMedia(url: string): Promise<{ bytes: Uint8Array; mime: string; sizeBytes: number }> };

/** Item messages per permanent client failure (site spec section 6). */
const MEDIA_MESSAGES: Record<string, string> = {
  media_missing: "media missing",
  mime_not_allowed: "media type not allowed",
  too_large: "media larger than 10 MB",
  origin_refused: "media host not allowed",
};

/** Attachments to import that still wait for the media job. */
export async function pendingMediaCount(db: DbOrTx, importId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(wordpressImportItems)
    .where(and(eq(wordpressImportItems.importId, importId), eq(wordpressImportItems.wpType, "attachment"), eq(wordpressImportItems.decision, "import"), eq(wordpressImportItems.status, "pending")));
  return Number(row?.n ?? 0);
}

export type MediaDeps = {
  fetcher: MediaFetcher;
  /** Stores bytes (platform's `storeFile`), injected so this file stays free of request code. */
  store: (input: { name: string; mime: string; bytes: Uint8Array }) => Promise<{ fileId: string }>;
  /** Image header reader (`imageSize` of `@beam/core/site`). */
  size: (bytes: Uint8Array) => { width: number; height: number; mime: string } | null;
  /** True for a retryable client failure (rethrown, so the chunk retries). */
  isRetryable: (e: unknown) => boolean;
  /** The permanent failure's code (`media_missing`, ...), or null. */
  codeOf: (e: unknown) => string | null;
};

/**
 * Fetches up to `limit` pending attachments. A URL already in `media_assets` is reused without a
 * request. Permanent failures mark the item `error` and the chunk continues; a retryable failure
 * is rethrown. Returns how many attachments still wait afterwards.
 */
export async function importMediaChunk(tx: Tx, ctx: Ctx, importId: string, deps: MediaDeps, limit = MEDIA_CHUNK): Promise<{ processed: number; remaining: number }> {
  const items = await tx
    .select()
    .from(wordpressImportItems)
    .where(and(eq(wordpressImportItems.importId, importId), eq(wordpressImportItems.wpType, "attachment"), eq(wordpressImportItems.decision, "import"), eq(wordpressImportItems.status, "pending")))
    .orderBy(asc(wordpressImportItems.wpId))
    .limit(limit);
  let redirectsCreated = 0;
  for (const item of items) {
    const url = item.attachmentUrl;
    if (!url) {
      await setItem(tx, item.id, { status: "error", message: "media missing" }, ctx.now);
      continue;
    }
    const [known] = await tx.select({ id: mediaAssets.id, fileId: mediaAssets.fileId }).from(mediaAssets).where(eq(mediaAssets.wordpressUrl, url));
    let media = known ?? null;
    if (!media) {
      let fetched: Awaited<ReturnType<MediaFetcher["fetchMedia"]>>;
      try {
        fetched = await deps.fetcher.fetchMedia(url);
      } catch (e) {
        if (deps.isRetryable(e)) throw e;
        await setItem(tx, item.id, { status: "error", message: MEDIA_MESSAGES[deps.codeOf(e) ?? ""] ?? "media could not be fetched" }, ctx.now);
        continue;
      }
      const size = deps.size(fetched.bytes);
      if (!size) {
        await setItem(tx, item.id, { status: "error", message: "media is not an image" }, ctx.now);
        continue;
      }
      const name = decodeURIComponent(new URL(url).pathname.split("/").pop() || `wp-${item.wpId}`);
      const stored = await deps.store({ name, mime: size.mime, bytes: fetched.bytes });
      const [row] = await tx
        .insert(mediaAssets)
        .values({ fileId: stored.fileId, width: size.width, height: size.height, source: "wordpress", wordpressUrl: url, alt: {} })
        .onConflictDoNothing()
        .returning({ id: mediaAssets.id, fileId: mediaAssets.fileId });
      media = row ?? (await tx.select({ id: mediaAssets.id, fileId: mediaAssets.fileId }).from(mediaAssets).where(eq(mediaAssets.wordpressUrl, url)))[0] ?? null;
      if (!media) throw new Error("media_assets row missing after insert");
    }
    const target = { url: fileUrl(media.fileId) };
    redirectsCreated += await insertWpRedirect(tx, url, target);
    redirectsCreated += await insertWpRedirect(tx, item.wpPath, target);
    redirectsCreated += await insertWpRedirect(tx, `/?attachment_id=${item.wpId}`, target);
    await setItem(tx, item.id, { status: "imported", message: null, targetMediaId: media.id }, ctx.now);
  }
  const imp = await getImportRow(tx, importId);
  if (imp) await patchImport(tx, imp, { counts: { ...(await itemCounts(tx, importId)), redirects: (imp.counts.redirects ?? 0) + redirectsCreated } }, ctx.now);
  return { processed: items.length, remaining: await pendingMediaCount(tx, importId) };
}

/** Marks attachments that never arrived as `error` "media missing" (the apply job stops waiting). */
export async function giveUpPendingMedia(tx: Tx, ctx: Ctx, importId: string): Promise<number> {
  const rows = await tx
    .update(wordpressImportItems)
    .set({ status: "error", message: "media missing", updatedAt: ctx.now })
    .where(and(eq(wordpressImportItems.importId, importId), eq(wordpressImportItems.wpType, "attachment"), eq(wordpressImportItems.decision, "import"), eq(wordpressImportItems.status, "pending")))
    .returning({ id: wordpressImportItems.id });
  return rows.length;
}

// ---------------------------------------------------------------------------------------------
// finishing, retry, bulk publish
// ---------------------------------------------------------------------------------------------

/** Sets `done` (with `applied_at` and the final counts) when no item is pending; returns whether it did. */
export async function finishImportIfComplete(tx: Tx, ctx: Ctx, importId: string): Promise<boolean> {
  const imp = await lockImport(tx, importId);
  if (!imp || imp.status !== "applying") return false;
  const [left] = await tx.select({ n: sql<number>`count(*)::int` }).from(wordpressImportItems).where(and(eq(wordpressImportItems.importId, importId), eq(wordpressImportItems.status, "pending")));
  if (Number(left?.n ?? 0) > 0) return false;
  await patchImport(tx, imp, { status: "done", appliedAt: imp.appliedAt ?? ctx.now, counts: await itemCounts(tx, importId) }, ctx.now);
  return true;
}

/** Rule 66: `done | failed -> applying`, `error` items back to `pending`, a new round. */
export async function retryImportTx(tx: Tx, ctx: Ctx, importId: string): Promise<{ retried: number; round: number }> {
  const imp = await lockImport(tx, importId);
  if (!imp) throw new NotFoundError("import_not_found");
  if (imp.status !== "done" && imp.status !== "failed") throw new ConflictError(`import_${imp.status}`);
  const round = (reportOf(imp).round ?? 0) + 1;
  const reset = await tx
    .update(wordpressImportItems)
    .set({ status: "pending", message: null, updatedAt: ctx.now })
    .where(and(eq(wordpressImportItems.importId, importId), eq(wordpressImportItems.status, "error")))
    .returning({ id: wordpressImportItems.id });
  await patchImport(tx, imp, { status: "applying", report: { round, lastError: undefined }, counts: await itemCounts(tx, importId) }, ctx.now);
  await ctx.enqueue({ kind: "site.apply_wordpress", payload: { importId, offset: 0, round }, key: applyJobKey(importId, 0, round) });
  return { retried: reset.length, round };
}

export const applyJobKey = (importId: string, offset: number, round: number, wait = 0): string =>
  `wp_import:${importId}:apply:${offset}:${round}${wait ? `:w${wait}` : ""}`;
export const mediaJobKey = (importId: string, n: number): string => `wp_import:${importId}:media:${n}`;
export const parseJobKey = (importId: string): string => `wp_import:${importId}:parse`;

/** The pages an import created (items `imported` with a target page). */
export async function importedPageIds(db: DbOrTx, importId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ id: wordpressImportItems.targetPageId })
    .from(wordpressImportItems)
    .where(and(eq(wordpressImportItems.importId, importId), eq(wordpressImportItems.status, "imported"), isNotNull(wordpressImportItems.targetPageId)));
  return rows.map((r) => r.id!).sort();
}

/**
 * Publishes the draft of every page the import created whose checks pass (each in a savepoint, so
 * a blocked page never undoes another); pages without a draft are left alone.
 */
export async function publishImportedPagesTx(
  tx: Tx,
  ctx: Ctx,
  importId: string,
  publish: (sp: Tx, versionId: string) => Promise<unknown>,
  issuesOf: (e: unknown) => PublishIssue[] | null,
): Promise<{ published: number; blocked: { pageId: string; issues: PublishIssue[] }[]; pageIds: string[] }> {
  const ids = await importedPageIds(tx, importId);
  const blocked: { pageId: string; issues: PublishIssue[] }[] = [];
  const done: string[] = [];
  for (const pageId of ids) {
    const draft = await findDraft(tx, pageId);
    if (!draft) continue;
    try {
      await tx.transaction(async (sp) => {
        await publish(sp, draft.id);
      });
      done.push(pageId);
    } catch (e) {
      const issues = issuesOf(e);
      if (!issues) throw e;
      blocked.push({ pageId, issues });
    }
  }
  return { published: done.length, blocked, pageIds: done };
}
