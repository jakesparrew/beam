/**
 * site queries, WordPress import (site spec section 4 "Admin", section 5 `/admin/site/imports`;
 * site-P7): listWordpressImports, getWordpressImport, listWordpressImportItems,
 * getRedirectCoverage. Every function takes an optional db (the app db by default, OD-15) and
 * returns JSON-safe rows (ISO date strings) for the client components.
 */
import type { DbOrTx } from "@beam/db";
import { pageRoutes, pages, pageVersions, redirects, users, wordpressImportItems, wordpressImports, type WordpressImportCounts } from "@beam/db/schema";
import type { Locale } from "@beam/core/i18n";
import { localePath, normalisePath } from "@beam/core/site";
import { and, asc, desc, eq, getAppDb, inArray, sql } from "@/lib/ctx";
import { reportOf, type ImportReport } from "../server/wordpress/apply";

const db0 = async (db?: DbOrTx): Promise<DbOrTx> => db ?? (await getAppDb());
const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

export type WordpressImportStatus = (typeof wordpressImports.status.enumValues)[number];
export type ImportItemDecision = (typeof wordpressImportItems.decision.enumValues)[number];
export type ImportItemStatus = (typeof wordpressImportItems.status.enumValues)[number];
export type ImportItemType = (typeof wordpressImportItems.wpType.enumValues)[number];

export type WordpressImportSummary = {
  importId: string;
  siteOrigin: string;
  defaultLocale: Locale;
  status: WordpressImportStatus;
  counts: WordpressImportCounts;
  createdBy: string | null;
  createdAt: string;
  appliedAt: string | null;
};

export type WordpressImportDetail = WordpressImportSummary & {
  report: Pick<ImportReport, "convert" | "parseError" | "parseErrors" | "lastError" | "round">;
  /** True while a job is still working on it (the screen refreshes). */
  busy: boolean;
  /** Imported pages with a draft that a bulk publish would try. */
  draftPages: number;
};

const summaryCols = {
  importId: wordpressImports.id,
  siteOrigin: wordpressImports.siteOrigin,
  defaultLocale: wordpressImports.defaultLocale,
  status: wordpressImports.status,
  counts: wordpressImports.counts,
  report: wordpressImports.report,
  createdBy: users.name,
  createdAt: wordpressImports.createdAt,
  appliedAt: wordpressImports.appliedAt,
};

type SummaryRow = { importId: string; siteOrigin: string; defaultLocale: Locale; status: WordpressImportStatus; counts: WordpressImportCounts; createdBy: string | null; createdAt: Date; appliedAt: Date | null };
const toSummary = (r: SummaryRow): WordpressImportSummary => ({
  importId: r.importId,
  siteOrigin: r.siteOrigin,
  defaultLocale: r.defaultLocale,
  status: r.status,
  counts: r.counts ?? {},
  createdBy: r.createdBy,
  createdAt: r.createdAt.toISOString(),
  appliedAt: iso(r.appliedAt),
});

/** Every import, newest first (the `/admin/site/imports` table). */
export async function listWordpressImports(db?: DbOrTx): Promise<WordpressImportSummary[]> {
  const d = await db0(db);
  const rows = await d.select(summaryCols).from(wordpressImports).leftJoin(users, eq(users.id, wordpressImports.createdByUserId)).orderBy(desc(wordpressImports.createdAt)).limit(200);
  return rows.map(toSummary);
}

export async function getWordpressImport(id: string, db?: DbOrTx): Promise<WordpressImportDetail | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const d = await db0(db);
  const [row] = await d.select(summaryCols).from(wordpressImports).leftJoin(users, eq(users.id, wordpressImports.createdByUserId)).where(eq(wordpressImports.id, id));
  if (!row) return null;
  const r = reportOf(row);
  const [drafts] = await d
    .select({ n: sql<number>`count(distinct ${pageVersions.pageId})::int` })
    .from(wordpressImportItems)
    .innerJoin(pageVersions, and(eq(pageVersions.pageId, wordpressImportItems.targetPageId), eq(pageVersions.state, "draft")))
    .where(and(eq(wordpressImportItems.importId, id), eq(wordpressImportItems.status, "imported")));
  return {
    ...toSummary(row),
    report: { convert: r.convert, parseError: r.parseError, parseErrors: r.parseErrors, lastError: r.lastError, round: r.round },
    busy: row.status === "uploaded" || row.status === "parsing" || row.status === "applying",
    draftPages: Number(drafts?.n ?? 0),
  };
}

export type ImportItemRow = {
  itemId: string;
  wpId: number;
  wpType: ImportItemType;
  wpStatus: string;
  title: string;
  wpPath: string;
  locale: Locale | null;
  translationGroup: string | null;
  decision: ImportItemDecision;
  status: ImportItemStatus;
  message: string | null;
  targetPageId: string | null;
  targetPageSlug: string | null;
  redirectToPageId: string | null;
};

export type ImportItemFilter = { type?: ImportItemType; status?: ImportItemStatus; decision?: ImportItemDecision };

/** The items of an import (mapping table), ordered by type, translation group and WordPress id. */
export async function listWordpressImportItems(importId: string, filter: ImportItemFilter = {}, db?: DbOrTx): Promise<ImportItemRow[]> {
  const d = await db0(db);
  const conds = [
    eq(wordpressImportItems.importId, importId),
    filter.type ? eq(wordpressImportItems.wpType, filter.type) : undefined,
    filter.status ? eq(wordpressImportItems.status, filter.status) : undefined,
    filter.decision ? eq(wordpressImportItems.decision, filter.decision) : undefined,
  ].filter((c) => c !== undefined);
  const rows = await d
    .select({ item: wordpressImportItems, slug: pages.slug })
    .from(wordpressImportItems)
    .leftJoin(pages, eq(pages.id, wordpressImportItems.targetPageId))
    .where(and(...conds))
    .orderBy(asc(wordpressImportItems.wpType), sql`${wordpressImportItems.translationGroup} asc nulls last`, asc(wordpressImportItems.wpId))
    .limit(2000);
  return rows.map(({ item: i, slug }) => ({
    itemId: i.id,
    wpId: i.wpId,
    wpType: i.wpType,
    wpStatus: i.wpStatus,
    title: i.title,
    wpPath: i.wpPath,
    locale: i.locale,
    translationGroup: i.translationGroup,
    decision: i.decision,
    status: i.status,
    message: i.message,
    targetPageId: i.targetPageId,
    targetPageSlug: slug ?? null,
    redirectToPageId: i.redirectToPageId,
  }));
}

export type RedirectCoverage = {
  total: number;
  covered: number;
  /** 0-100, one decimal. */
  percent: number;
  /** Old paths that resolve to neither a live page nor a redirect (rule 53). */
  uncovered: { itemId: string; wpType: ImportItemType; title: string; oldPath: string; decision: ImportItemDecision; status: ImportItemStatus }[];
};

/** Rule 53: every old path (and attachment URL) of the import, and which have no page or redirect. */
export async function getRedirectCoverage(importId: string, db?: DbOrTx): Promise<RedirectCoverage> {
  const d = await db0(db);
  const items = await d.select().from(wordpressImportItems).where(eq(wordpressImportItems.importId, importId)).orderBy(asc(wordpressImportItems.wpType), asc(wordpressImportItems.wpId));
  const olds: { item: (typeof items)[number]; oldPath: string }[] = [];
  for (const item of items) {
    olds.push({ item, oldPath: item.wpPath });
    if (item.attachmentUrl) olds.push({ item, oldPath: normalisePath(item.attachmentUrl) });
  }
  const paths = [...new Set(olds.map((o) => o.oldPath))];
  const known = new Set<string>();
  for (let i = 0; i < paths.length; i += 500) {
    const part = paths.slice(i, i + 500);
    if (!part.length) continue;
    for (const r of await d.select({ p: redirects.fromPath }).from(redirects).where(inArray(redirects.fromPath, part))) known.add(r.p);
  }
  const routes = await d.select({ locale: pageRoutes.locale, path: pageRoutes.path }).from(pageRoutes);
  for (const r of routes) known.add(localePath(r.locale, r.path));
  const uncovered = olds
    .filter((o) => !known.has(o.oldPath))
    .map(({ item, oldPath }) => ({ itemId: item.id, wpType: item.wpType, title: item.title, oldPath, decision: item.decision, status: item.status }));
  const total = olds.length;
  const covered = total - uncovered.length;
  return { total, covered, percent: total ? Math.round((covered / total) * 1000) / 10 : 100, uncovered };
}
