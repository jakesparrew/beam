/**
 * site queries, Claude proposals (site spec section 4 "Admin", section 5 review screen, rules 45-46,
 * edge case 11; site-P4): `getVersionDiff(versionId)` (the version against its `based_on_version_id`,
 * else the live version, with review warnings and, for Claude versions, the request) and
 * `getEditRequest(id)` (polled every 2 s by the Claude panel). Every function takes an optional db
 * (the app db by default, OD-15) and returns JSON-safe rows.
 */
import type { DbOrTx } from "@beam/db";
import { pageEditRequests, pages, pageVersions, users } from "@beam/db/schema";
import type { Locale } from "@beam/core/i18n";
import { diffVersions, reviewWarnings, type LegalKey, type PageKind, type PageStatus, type VersionDiff, type Warning } from "@beam/core/site";
import { and, eq, getAppDb } from "@/lib/ctx";
import { getVersion, type AdminVersion } from "./admin";

const db0 = async (db?: DbOrTx): Promise<DbOrTx> => db ?? (await getAppDb());
const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

export type EditRequestStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";
export type EditRequestErrorCode = "budget_exceeded" | "invalid_output" | "ai_unavailable" | "page_archived";

export type EditRequestView = {
  editRequestId: string;
  pageId: string;
  kind: "edit" | "new_page" | "translate";
  status: EditRequestStatus;
  locales: Locale[];
  errorCode: EditRequestErrorCode | null;
  resultVersionId: string | null;
  baseVersionId: string | null;
  createdAt: string;
  finishedAt: string | null;
};

export async function getEditRequest(id: string, db?: DbOrTx): Promise<EditRequestView | null> {
  const d = await db0(db);
  const [r] = await d.select().from(pageEditRequests).where(eq(pageEditRequests.id, id));
  if (!r) return null;
  return {
    editRequestId: r.id,
    pageId: r.pageId,
    kind: r.kind,
    status: r.status,
    locales: r.locales as Locale[],
    errorCode: (r.errorCode as EditRequestErrorCode | null) ?? null,
    resultVersionId: r.resultVersionId ?? null,
    baseVersionId: r.baseVersionId ?? null,
    createdAt: r.createdAt.toISOString(),
    finishedAt: iso(r.finishedAt),
  };
}

export type VersionDiffData = {
  page: { pageId: string; kind: PageKind; slug: string; status: PageStatus; legalKey: LegalKey | null; currentVersionId: string | null };
  version: AdminVersion & { createdAt: string; rejectReason: string | null };
  /** The version diffed against (`based_on_version_id`, else the live version), or null. */
  base: AdminVersion | null;
  /** Which base was used: the recorded base, the live version, or none (a first version). */
  baseSource: "based_on" | "live" | "none";
  diff: VersionDiff;
  warnings: Warning[];
  /** Claude versions: the request that produced it (instruction and requester; no other personal data). */
  request: { editRequestId: string; instruction: string; requestedByName: string | null; kind: string; locales: Locale[]; createdAt: string } | null;
  /** Edge case 11: the base is a draft that was edited after this proposal was made. */
  draftChangedAfter: boolean;
  /** The page's current draft (for "Edit as draft", which then replaces it). */
  draftVersionId: string | null;
};

export async function getVersionDiff(versionId: string, db?: DbOrTx): Promise<VersionDiffData | null> {
  const d = await db0(db);
  const [row] = await d.select().from(pageVersions).where(eq(pageVersions.id, versionId));
  if (!row) return null;
  const [page] = await d.select().from(pages).where(eq(pages.id, row.pageId));
  if (!page) return null;
  const version = (await getVersion(row.id, d))!;

  let base: AdminVersion | null = null;
  let baseSource: VersionDiffData["baseSource"] = "none";
  if (row.basedOnVersionId) {
    base = await getVersion(row.basedOnVersionId, d);
    if (base) baseSource = "based_on";
  }
  if (!base && page.currentVersionId && page.currentVersionId !== row.id) {
    base = await getVersion(page.currentVersionId, d);
    if (base) baseSource = "live";
  }

  const diff = diffVersions(base, version);
  const warnings = reviewWarnings(base, version, { isLegal: page.kind === "legal" });

  let request: VersionDiffData["request"] = null;
  if (row.editRequestId) {
    const [r] = await d
      .select({ r: pageEditRequests, name: users.name })
      .from(pageEditRequests)
      .leftJoin(users, eq(users.id, pageEditRequests.requestedByUserId))
      .where(eq(pageEditRequests.id, row.editRequestId));
    if (r) request = { editRequestId: r.r.id, instruction: r.r.instruction, requestedByName: r.name ?? null, kind: r.r.kind, locales: r.r.locales as Locale[], createdAt: r.r.createdAt.toISOString() };
  }

  const [draftRow] = await d.select({ id: pageVersions.id }).from(pageVersions).where(and(eq(pageVersions.pageId, page.id), eq(pageVersions.state, "draft")));

  return {
    page: { pageId: page.id, kind: page.kind, slug: page.slug, status: page.status, legalKey: page.legalKey ?? null, currentVersionId: page.currentVersionId ?? null },
    version: { ...version, createdAt: row.createdAt.toISOString(), rejectReason: row.rejectReason ?? null },
    base,
    baseSource,
    diff,
    warnings,
    request,
    draftChangedAfter: row.createdBy === "claude" && base?.state === "draft" && new Date(base.updatedAt).getTime() > row.createdAt.getTime(),
    draftVersionId: draftRow?.id ?? null,
  };
}
