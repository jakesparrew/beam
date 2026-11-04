/**
 * Publishing, scheduling, unpublishing, archiving and restoring pages (site rules 7, 8, 11-14,
 * 54-55; site-P3). Every function takes the caller's transaction and locks the page row first, so
 * two publishes of one page serialise and the second sees `conflict` "already published"
 * (edge case 2). Callers revalidate the cache tags of `pageTags(pageId)` after the commit.
 * `publishVersionTx` is shared by the publish action, the `site.publish_version` job and site-P7.
 */
import type { Tx } from "@beam/db";
import { pageEditRequests, pageRoutes, pages, pageVersions, redirects } from "@beam/db/schema";
import { LOCALES, type Locale } from "@beam/core/i18n";
import { localePath, portalPath, SINGLETON_KINDS, type Link, type PublishIssue } from "@beam/core/site";
import { and, ConflictError, eq, inArray, ne, sql, ValidationError, type Ctx } from "@/lib/ctx";
import { checkVersion, prefixedPaths } from "./refs";
import { getVersionOrThrow, lockPage, versionContent, type PageRow } from "./versions";

/** Publish refused by the checks of rules 5-6: `validation` with the issue list in `fields.issues` (JSON). */
export class PublishBlockedError extends ValidationError {
  override readonly name = "PublishBlockedError";
  constructor(readonly issues: PublishIssue[]) {
    super("publish_blocked", { issues: JSON.stringify(issues) });
  }
}

/** Parses `fields.issues` of a `publish_blocked` action result. */
export function issuesFromFields(fields: Record<string, string> | undefined): PublishIssue[] {
  try {
    const parsed = JSON.parse(fields?.issues ?? "[]") as unknown;
    return Array.isArray(parsed) ? (parsed as PublishIssue[]) : [];
  } catch {
    return [];
  }
}

const userIdOf = (ctx: Ctx): string | null => (ctx.actor.kind === "staff" || ctx.actor.kind === "customer" ? ctx.actor.userId : null);

export const MIN_SCHEDULE_MS = 5 * 60_000;
export const MAX_SCHEDULE_MS = 365 * 86_400_000;

/** `YYYY-MM-DDTHH:mm` (UTC) of a schedule instant, for the job key. */
export function scheduleKeyPart(at: Date): string {
  return at.toISOString().slice(0, 16);
}

export function publishJobKey(versionId: string, at: Date): string {
  return `page_version:${versionId}:publish:${scheduleKeyPart(at)}`;
}

/** Live paths of a page per locale. */
async function liveRoutes(tx: Tx, pageId: string): Promise<Partial<Record<Locale, string>>> {
  const rows = await tx.select({ locale: pageRoutes.locale, path: pageRoutes.path }).from(pageRoutes).where(eq(pageRoutes.pageId, pageId));
  const out: Partial<Record<Locale, string>> = {};
  for (const r of rows) out[r.locale] = r.path;
  return out;
}

/**
 * Publishes a draft or proposed version in the caller's transaction (rule 7): lock the page, check
 * (rules 5-6, `PublishBlockedError`), set the version `published`, point the page at it, rewrite
 * `page_routes`, add `rename` redirects from changed paths (rule 11), delete redirects whose source
 * is now a live path of the page, and audit `site.page.publish`. With `expectedScheduledAt` (the
 * scheduled job) the version's `scheduled_publish_at` must still equal it once the page is locked,
 * or `conflict` "schedule_changed".
 */
export async function publishVersionTx(
  tx: Tx,
  ctx: Ctx,
  versionId: string,
  opts: { scheduledBy?: string; expectedScheduledAt?: Date },
): Promise<{ publishedAt: Date }> {
  const first = await getVersionOrThrow(tx, versionId);
  const page = await lockPage(tx, first.pageId);
  const version = await getVersionOrThrow(tx, versionId);
  if (version.state === "published" || version.publishedAt) throw new ConflictError("already_published");
  if (version.state !== "draft" && version.state !== "proposed") throw new ConflictError(`version_${version.state}`);
  // The scheduled job publishes only the schedule it was enqueued for, checked under the page lock,
  // so a cancel or reschedule that committed first wins.
  if (opts.expectedScheduledAt && version.scheduledPublishAt?.getTime() !== opts.expectedScheduledAt.getTime()) throw new ConflictError("schedule_changed");
  if (page.status === "archived") throw new ConflictError("page_archived");

  const issues = await checkVersion(tx, page, version);
  if (issues.length) throw new PublishBlockedError(issues);

  const content = versionContent(version);
  const publishedAt = ctx.now;
  const before = await liveRoutes(tx, page.id);

  await tx
    .update(pageVersions)
    .set({ state: "published", publishedAt, publishedByUserId: opts.scheduledBy ? null : userIdOf(ctx), scheduledPublishAt: null, updatedAt: publishedAt })
    .where(eq(pageVersions.id, version.id));
  await tx
    .update(pages)
    .set({ status: "published", currentVersionId: version.id, firstPublishedAt: page.firstPublishedAt ?? publishedAt, updatedAt: publishedAt })
    .where(eq(pages.id, page.id));

  await tx.delete(pageRoutes).where(eq(pageRoutes.pageId, page.id));
  const live: [Locale, string][] = LOCALES.filter((l) => content.locales.includes(l)).map((l) => [l, content.paths[l] ?? ""]);
  if (live.length) await tx.insert(pageRoutes).values(live.map(([locale, path]) => ({ pageId: page.id, locale, path, versionId: version.id })));

  // A redirect whose source is now a live path of this page is deleted: the page wins (rule 11).
  const livePaths = live.map(([l, p]) => localePath(l, p));
  const deleted = livePaths.length
    ? await tx.delete(redirects).where(inArray(redirects.fromPath, livePaths)).returning({ id: redirects.id, fromPath: redirects.fromPath })
    : [];

  // Changed paths keep working through a rename redirect to the page and locale (rule 11).
  const created: string[] = [];
  for (const [locale, path] of live) {
    const old = before[locale];
    if (old === undefined || old === path) continue;
    const fromPath = localePath(locale, old);
    await tx
      .insert(redirects)
      .values({ fromPath, toPageId: page.id, toLocale: locale, toUrl: null, isPermanent: true, source: "rename", createdByUserId: userIdOf(ctx) })
      .onConflictDoUpdate({ target: redirects.fromPath, set: { toPageId: page.id, toLocale: locale, toUrl: null, isPermanent: true, source: "rename", updatedAt: publishedAt } });
    created.push(fromPath);
  }

  await ctx.audit({
    action: "site.page.publish",
    entityType: "page",
    entityId: page.id,
    oldValue: { versionId: page.currentVersionId, status: page.status, routes: before },
    newValue: {
      versionId: version.id,
      version: version.version,
      created_by: version.createdBy,
      edit_request_id: version.editRequestId,
      ...(opts.scheduledBy ? { scheduledBy: opts.scheduledBy } : {}),
      redirectsCreated: created,
      redirectsDeleted: deleted.map((d) => d.fromPath),
    },
  });
  return { publishedAt };
}

/** Rule 13: at least 5 minutes and at most 365 days ahead of `now`. */
export function assertScheduleBounds(at: Date, now: Date): void {
  const delta = at.getTime() - now.getTime();
  if (Number.isNaN(delta) || delta < MIN_SCHEDULE_MS) throw new ValidationError("schedule_too_soon", { scheduleAt: "too_soon" });
  if (delta > MAX_SCHEDULE_MS) throw new ValidationError("schedule_too_far", { scheduleAt: "too_far" });
}

/** Schedules a draft or proposal (rule 13): runs the checks now, stores the instant and enqueues the job. */
export async function scheduleVersionTx(tx: Tx, ctx: Ctx, versionId: string, at: Date): Promise<{ scheduledAt: Date; pageId: string }> {
  assertScheduleBounds(at, ctx.now);
  const first = await getVersionOrThrow(tx, versionId);
  const page = await lockPage(tx, first.pageId);
  const version = await getVersionOrThrow(tx, versionId);
  if (version.state !== "draft" && version.state !== "proposed") throw new ConflictError(version.state === "published" ? "already_published" : `version_${version.state}`);
  if (page.status === "archived") throw new ConflictError("page_archived");
  const issues = await checkVersion(tx, page, version);
  if (issues.length) throw new PublishBlockedError(issues);
  await tx.update(pageVersions).set({ scheduledPublishAt: at }).where(eq(pageVersions.id, version.id));
  await ctx.enqueue({
    kind: "site.publish_version",
    payload: { versionId: version.id, scheduledPublishAt: at.toISOString(), ...(userIdOf(ctx) ? { scheduledByUserId: userIdOf(ctx)! } : {}) },
    key: publishJobKey(version.id, at),
    runAt: at,
  });
  await ctx.audit({
    action: "site.page.schedule",
    entityType: "page_version",
    entityId: version.id,
    oldValue: { scheduledPublishAt: version.scheduledPublishAt },
    newValue: { pageId: page.id, scheduledPublishAt: at.toISOString(), created_by: version.createdBy },
  });
  return { scheduledAt: at, pageId: page.id };
}

/** Clears a schedule; the queued job then finds a different `scheduled_publish_at` and does nothing. */
export async function cancelScheduleTx(tx: Tx, ctx: Ctx, versionId: string): Promise<{ pageId: string }> {
  const first = await getVersionOrThrow(tx, versionId);
  await lockPage(tx, first.pageId);
  const version = await getVersionOrThrow(tx, versionId);
  if (!version.scheduledPublishAt) throw new ConflictError("not_scheduled");
  await tx.update(pageVersions).set({ scheduledPublishAt: null }).where(eq(pageVersions.id, version.id));
  await ctx.audit({
    action: "site.page.unschedule",
    entityType: "page_version",
    entityId: version.id,
    oldValue: { scheduledPublishAt: version.scheduledPublishAt },
    newValue: { pageId: version.pageId },
  });
  return { pageId: version.pageId };
}

/** Resolves a redirect target link to the columns of `redirects` for a source locale. */
async function redirectTarget(tx: Tx, link: Link, locale: Locale, selfId: string): Promise<{ toPageId: string; toLocale: Locale; toUrl: null } | { toPageId: null; toLocale: null; toUrl: string }> {
  if (link.kind === "url") return { toPageId: null, toLocale: null, toUrl: link.href };
  if (link.kind === "portal") return { toPageId: null, toLocale: null, toUrl: portalPath(locale, link.route) };
  if (link.pageId === selfId) throw new ValidationError("redirect_to_self", { redirectTo: "self" });
  const [target] = await tx.select({ status: pages.status }).from(pages).where(eq(pages.id, link.pageId));
  if (!target || target.status !== "published") throw new ValidationError("redirect_target_unpublished", { redirectTo: "unpublished" });
  const routes = await liveRoutes(tx, link.pageId);
  const toLocale = routes[locale] !== undefined ? locale : LOCALES.find((l) => routes[l] !== undefined);
  if (!toLocale) throw new ValidationError("redirect_target_unpublished", { redirectTo: "unpublished" });
  return { toPageId: link.pageId, toLocale, toUrl: null };
}

/** Deletes the page's routes and, with a target, adds one `archive` redirect per former live path (rule 12). */
async function retire(tx: Tx, ctx: Ctx, page: PageRow, redirectTo: Link | undefined): Promise<{ routes: Partial<Record<Locale, string>>; redirects: string[] }> {
  const routes = await liveRoutes(tx, page.id);
  await tx.delete(pageRoutes).where(eq(pageRoutes.pageId, page.id));
  const created: string[] = [];
  if (redirectTo) {
    for (const l of LOCALES) {
      const path = routes[l];
      if (path === undefined) continue;
      const target = await redirectTarget(tx, redirectTo, l, page.id);
      const fromPath = localePath(l, path);
      if (target.toUrl === fromPath) continue;
      await tx
        .insert(redirects)
        .values({ fromPath, ...target, isPermanent: true, source: "archive", createdByUserId: userIdOf(ctx) })
        .onConflictDoUpdate({ target: redirects.fromPath, set: { ...target, isPermanent: true, source: "archive", updatedAt: ctx.now } });
      created.push(fromPath);
    }
  }
  return { routes, redirects: created };
}

/** `published -> draft` (rule 12, 54): the paths answer 404 unless a redirect is chosen. */
export async function unpublishPageTx(tx: Tx, ctx: Ctx, pageId: string, redirectTo?: Link): Promise<void> {
  const page = await lockPage(tx, pageId);
  if (page.status !== "published") throw new ConflictError(`page_${page.status}`);
  const out = await retire(tx, ctx, page, redirectTo);
  await tx.update(pages).set({ status: "draft", updatedAt: ctx.now }).where(eq(pages.id, page.id));
  await ctx.audit({ action: "site.page.unpublish", entityType: "page", entityId: page.id, oldValue: { status: page.status, routes: out.routes }, newValue: { status: "draft", redirects: out.redirects } });
}

/**
 * `draft|published -> archived` (rules 12, 54, 55): routes deleted, optional redirect, open
 * proposals `rejected` ("Page archived"), pending Claude requests `cancelled`, schedules cleared.
 * Without a redirect the former paths answer 410 Gone.
 */
export async function archivePageTx(tx: Tx, ctx: Ctx, pageId: string, redirectTo?: Link): Promise<{ rejected: number; cancelled: number }> {
  const page = await lockPage(tx, pageId);
  if (page.status === "archived") throw new ConflictError("page_archived");
  const out = await retire(tx, ctx, page, redirectTo);
  await tx.update(pageVersions).set({ scheduledPublishAt: null }).where(and(eq(pageVersions.pageId, page.id), sql`${pageVersions.scheduledPublishAt} is not null`));
  const rejected = await tx
    .update(pageVersions)
    .set({ state: "rejected", rejectedAt: ctx.now, rejectedByUserId: userIdOf(ctx), rejectReason: "Page archived" })
    .where(and(eq(pageVersions.pageId, page.id), eq(pageVersions.state, "proposed")))
    .returning({ id: pageVersions.id });
  const cancelled = await tx
    .update(pageEditRequests)
    .set({ status: "cancelled", finishedAt: ctx.now })
    .where(and(eq(pageEditRequests.pageId, page.id), eq(pageEditRequests.status, "pending")))
    .returning({ id: pageEditRequests.id });
  await tx.update(pages).set({ status: "archived", archivedAt: ctx.now, archivedByUserId: userIdOf(ctx), updatedAt: ctx.now }).where(eq(pages.id, page.id));
  await ctx.audit({
    action: "site.page.archive",
    entityType: "page",
    entityId: page.id,
    oldValue: { status: page.status, routes: out.routes },
    newValue: { status: "archived", redirects: out.redirects, rejectedProposals: rejected.map((r) => r.id), cancelledRequests: cancelled.map((r) => r.id) },
  });
  return { rejected: rejected.length, cancelled: cancelled.length };
}

/**
 * `archived -> draft` (rule 54): refused with `conflict` naming the page that now holds the slug,
 * the singleton kind, the legal key or the session; deletes the `archive` redirects from the
 * page's former paths.
 */
export async function restoreArchivedPageTx(tx: Tx, ctx: Ctx, pageId: string): Promise<void> {
  const page = await lockPage(tx, pageId);
  if (page.status !== "archived") throw new ConflictError(`page_${page.status}`);
  const others = and(ne(pages.id, page.id), ne(pages.status, "archived"));
  const holder = async (what: string, cond: ReturnType<typeof eq>) => {
    const [row] = await tx.select({ id: pages.id, slug: pages.slug }).from(pages).where(and(others, cond)).limit(1);
    if (row) throw new ConflictError(`${what}_taken:${row.slug}`);
  };
  await holder("slug", eq(pages.slug, page.slug));
  if (SINGLETON_KINDS.includes(page.kind)) await holder("kind", eq(pages.kind, page.kind));
  if (page.legalKey) await holder("legal_key", eq(pages.legalKey, page.legalKey));
  if (page.sessionId) await holder("session", eq(pages.sessionId, page.sessionId));
  let removed: string[] = [];
  if (page.currentVersionId) {
    const current = await getVersionOrThrow(tx, page.currentVersionId);
    const from = prefixedPaths(current.paths ?? {});
    if (from.length) {
      const rows = await tx.delete(redirects).where(and(eq(redirects.source, "archive"), inArray(redirects.fromPath, from))).returning({ fromPath: redirects.fromPath });
      removed = rows.map((r) => r.fromPath);
    }
  }
  await tx.update(pages).set({ status: "draft", archivedAt: null, archivedByUserId: null, updatedAt: ctx.now }).where(eq(pages.id, page.id));
  await ctx.audit({ action: "site.page.restore_archived", entityType: "page", entityId: page.id, oldValue: { status: "archived" }, newValue: { status: "draft", redirectsDeleted: removed } });
}
