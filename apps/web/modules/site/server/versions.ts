/**
 * Page versions (site rules 3, 4, 15, 55; site-P3). A version with `published_at` set is never
 * updated or deleted; only `draft` rows accept content updates; `proposed` rows accept only the
 * state changes `rejected | published | superseded` (written by `server/publish.ts` and site-P4).
 * Version numbers are `max(version) + 1` under the page row lock (`allocateVersion`), so two
 * writers never take the same number. Used by the actions, the publish job, site-P4 (proposals)
 * and site-P7 (WordPress import).
 */
import { createHash } from "node:crypto";
import type { Tx } from "@beam/db";
import { pages, pageVersions } from "@beam/db/schema";
import { LOCALES, type Locale } from "@beam/core/i18n";
import type { VersionContent } from "@beam/core/site";
import { and, ConflictError, eq, isNull, NotFoundError, sql, type DbOrTx } from "@/lib/ctx";

export type PageRow = typeof pages.$inferSelect;
export type VersionRow = typeof pageVersions.$inferSelect;

/** Locks the page row (`select ... for update`) and returns it; `not_found` when it does not exist. */
export async function lockPage(tx: Tx, pageId: string): Promise<PageRow> {
  const [row] = await tx.select().from(pages).where(eq(pages.id, pageId)).for("update");
  if (!row) throw new NotFoundError("page_not_found");
  return row;
}

/** The next version number of a page, allocated under the page row lock (section 2). */
export async function allocateVersion(tx: Tx, pageId: string): Promise<number> {
  await lockPage(tx, pageId);
  const [row] = await tx
    .select({ max: sql<number | null>`max(${pageVersions.version})` })
    .from(pageVersions)
    .where(eq(pageVersions.pageId, pageId));
  return Number(row?.max ?? 0) + 1;
}

/** Refuses any content update of a version that is not an unpublished draft (rules 4 and 55). */
export function assertMutable(row: Pick<VersionRow, "state" | "publishedAt">): void {
  if (row.publishedAt) throw new ConflictError("version_published");
  if (row.state !== "draft") throw new ConflictError(`version_${row.state}`);
}

export async function getVersionRow(db: DbOrTx, versionId: string): Promise<VersionRow | null> {
  const [row] = await db.select().from(pageVersions).where(eq(pageVersions.id, versionId));
  return row ?? null;
}

export async function getVersionOrThrow(db: DbOrTx, versionId: string): Promise<VersionRow> {
  const row = await getVersionRow(db, versionId);
  if (!row) throw new NotFoundError("version_not_found");
  return row;
}

/** The page's one draft, or null (partial unique `page_versions_one_draft_uq`). */
export async function findDraft(db: DbOrTx, pageId: string): Promise<VersionRow | null> {
  const [row] = await db
    .select()
    .from(pageVersions)
    .where(and(eq(pageVersions.pageId, pageId), eq(pageVersions.state, "draft")));
  return row ?? null;
}

const isLocale = (l: string): l is Locale => (LOCALES as readonly string[]).includes(l);

/** The content of a version row (what is checked, diffed and copied). */
export function versionContent(row: VersionRow): VersionContent {
  return {
    title: row.title ?? {},
    paths: row.paths ?? {},
    blocks: row.blocks ?? {},
    seo: row.seo ?? {},
    excerpt: row.excerpt ?? null,
    coverMediaId: row.coverMediaId ?? null,
    locales: (row.locales ?? []).filter(isLocale),
    isMaterialChange: row.isMaterialChange,
  };
}

/** `sha256` of a version's content: the audit stores this digest, never the content (section 7). */
export function contentDigest(content: VersionContent & { changeSummary?: string | null }): string {
  const ordered = {
    title: content.title,
    paths: content.paths,
    blocks: content.blocks,
    seo: content.seo,
    excerpt: content.excerpt ?? null,
    coverMediaId: content.coverMediaId ?? null,
    locales: content.locales,
    isMaterialChange: content.isMaterialChange ?? false,
    changeSummary: content.changeSummary ?? null,
  };
  return createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
}

/** Columns written from a content object. */
export function contentColumns(content: VersionContent & { changeSummary?: string | null }) {
  return {
    title: content.title,
    paths: content.paths,
    blocks: content.blocks,
    seo: content.seo,
    excerpt: content.excerpt ?? null,
    coverMediaId: content.coverMediaId ?? null,
    locales: LOCALES.filter((l) => content.locales.includes(l)),
    isMaterialChange: content.isMaterialChange ?? false,
    changeSummary: content.changeSummary ?? null,
  };
}

/**
 * Inserts a new user draft of a page with `content`, numbered by `allocateVersion`; refuses with
 * `conflict` when the page already has a draft (rule 3).
 */
export async function insertDraft(
  tx: Tx,
  input: { pageId: string; content: VersionContent & { changeSummary?: string | null }; basedOnVersionId: string | null; userId: string | null },
): Promise<VersionRow> {
  const version = await allocateVersion(tx, input.pageId);
  if (await findDraft(tx, input.pageId)) throw new ConflictError("draft_exists");
  const [row] = await tx
    .insert(pageVersions)
    .values({
      pageId: input.pageId,
      version,
      state: "draft",
      ...contentColumns(input.content),
      basedOnVersionId: input.basedOnVersionId,
      createdBy: "user",
      createdByUserId: input.userId,
    })
    .returning();
  return row!;
}

/**
 * Updates a draft's content. The `where` repeats the mutability rule (`state = 'draft'` and
 * `published_at is null`), so a row that was published meanwhile is never touched. `updated_at`
 * moves forward by at least one millisecond, so an optimistic lock always sees the change.
 */
export async function updateDraftContent(
  tx: Tx,
  row: VersionRow,
  content: VersionContent & { changeSummary?: string | null },
): Promise<VersionRow> {
  assertMutable(row);
  const updatedAt = new Date(Math.max(Date.now(), row.updatedAt.getTime() + 1));
  const [next] = await tx
    .update(pageVersions)
    .set({ ...contentColumns(content), updatedAt })
    .where(and(eq(pageVersions.id, row.id), eq(pageVersions.state, "draft"), isNull(pageVersions.publishedAt)))
    .returning();
  if (!next) throw new ConflictError("version_published");
  return next;
}
