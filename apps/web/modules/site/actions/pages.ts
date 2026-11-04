"use server";
/**
 * site server actions, pages and versions (site spec section 4, rules 3-16, 54-55; site-P3):
 * createPage, saveDraft, createDraftFromVersion, discardDraft, publishVersion,
 * cancelScheduledPublish, unpublishPage, archivePage, restoreArchivedPage. Editing needs
 * `site.edit`; publishing, scheduling, unpublishing, archiving and restoring need `site.publish`
 * (rule 8). Changes that reach the public site revalidate its cache tags after the commit.
 */
import { z } from "zod";
import { pageEditRequests, pages, pageVersions, sessions } from "@beam/db/schema";
import { LOCALES, LocalizedTextSchema, type Locale } from "@beam/core/i18n";
import { BlocksByLocale, LinkSchema, PAGE_KINDS, LEGAL_KEYS, PathsSchema, SeoByLocale, SINGLETON_KINDS, slugifySegment, type PageKind, type PublishIssue, type VersionContent } from "@beam/core/site";
import { action, type ActionResult } from "@/lib/action";
import { and, ConflictError, eq, ne, NotFoundError, ValidationError, type Ctx } from "@/lib/ctx";
import { pageTags, revalidateSite } from "../server/cache";
import { archivePageTx, cancelScheduleTx, publishVersionTx, restoreArchivedPageTx, scheduleVersionTx, unpublishPageTx } from "../server/publish";
import { checkContent } from "../server/refs";
import { contentDigest, findDraft, getVersionOrThrow, insertDraft, lockPage, updateDraftContent, versionContent } from "../server/versions";

const Locales = z.array(z.enum(LOCALES)).min(1).max(3);
const uuid = z.string().uuid();
/** Edge case 29: a body over 1 MB is refused. */
const MAX_BODY_BYTES = 1_048_576;

const userId = (ctx: Ctx): string | null => (ctx.actor.kind === "staff" ? ctx.actor.userId : null);

/** Runs `impl` and, when it succeeded, revalidates the tags `tagsOf(data)` returns (after the commit). */
function revalidating<I, O>(impl: (raw: unknown) => Promise<ActionResult<O>>, tagsOf: (data: O, raw: I) => string[]) {
  return async (raw: I): Promise<ActionResult<O>> => {
    const result = await impl(raw);
    if (result.ok) revalidateSite(tagsOf(result.data, raw));
    return result;
  };
}

// ---------------------------------------------------------------------------------------------
// createPage
// ---------------------------------------------------------------------------------------------

const CreatePageInput = z.object({
  kind: z.enum(PAGE_KINDS as [PageKind, ...PageKind[]]),
  slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(80),
  title: LocalizedTextSchema,
  locales: Locales,
  legalKey: z.enum(LEGAL_KEYS as [string, ...string[]]).optional(),
  sessionId: uuid.optional(),
});

/** Paths suggested for a new page: `''` for home, otherwise the slugified title (or slug) per locale. */
function suggestedPaths(kind: PageKind, slug: string, title: Partial<Record<Locale, string>>, locales: readonly Locale[]): Partial<Record<Locale, string>> {
  const out: Partial<Record<Locale, string>> = {};
  for (const l of locales) out[l] = kind === "home" ? "" : slugifySegment(title[l] ?? "") || slug;
  return out;
}

export const createPage = action(
  { name: "site.page.create", audience: "staff", permission: "site.edit", input: CreatePageInput },
  async (ctx, input): Promise<{ pageId: string; versionId: string }> => {
    const tx = ctx.tx;
    if ((input.kind === "legal") !== !!input.legalKey) throw new ValidationError("validation", { legalKey: input.kind === "legal" ? "required" : "not_allowed" });
    if (input.sessionId && input.kind !== "event") throw new ValidationError("validation", { sessionId: "not_allowed" });
    if (input.sessionId) {
      const [s] = await tx.select({ kind: sessions.kind }).from(sessions).where(eq(sessions.id, input.sessionId));
      if (s?.kind !== "event") throw new ValidationError("validation", { sessionId: "not_an_event" });
    }
    const [taken] = await tx.select({ id: pages.id }).from(pages).where(eq(pages.slug, input.slug));
    if (taken) throw new ValidationError("slug_taken", { slug: "taken" });
    const live = and(ne(pages.status, "archived"));
    if (SINGLETON_KINDS.includes(input.kind)) {
      const [other] = await tx.select({ slug: pages.slug }).from(pages).where(and(live, eq(pages.kind, input.kind)));
      if (other) throw new ConflictError(`kind_taken:${other.slug}`);
    }
    if (input.legalKey) {
      const [other] = await tx.select({ slug: pages.slug }).from(pages).where(and(live, eq(pages.legalKey, input.legalKey as never)));
      if (other) throw new ConflictError(`legal_key_taken:${other.slug}`);
    }
    if (input.sessionId) {
      const [other] = await tx.select({ slug: pages.slug }).from(pages).where(and(live, eq(pages.sessionId, input.sessionId)));
      if (other) throw new ConflictError(`session_taken:${other.slug}`);
    }
    const [page] = await tx
      .insert(pages)
      .values({ kind: input.kind, slug: input.slug, legalKey: (input.legalKey ?? null) as never, sessionId: input.sessionId ?? null, createdByUserId: userId(ctx) })
      .returning();
    const locales = LOCALES.filter((l) => input.locales.includes(l));
    const draft = await insertDraft(tx, {
      pageId: page!.id,
      content: { title: input.title, paths: suggestedPaths(input.kind, input.slug, input.title, locales), blocks: {}, seo: {}, locales },
      basedOnVersionId: null,
      userId: userId(ctx),
    });
    await ctx.audit({ action: "site.page.create", entityType: "page", entityId: page!.id, newValue: { kind: input.kind, slug: input.slug, locales, versionId: draft.id } });
    return { pageId: page!.id, versionId: draft.id };
  },
);

// ---------------------------------------------------------------------------------------------
// saveDraft (rules 3, 14, 15)
// ---------------------------------------------------------------------------------------------

const SaveDraftInput = z.object({
  pageId: uuid,
  versionId: uuid.optional(),
  expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
  title: LocalizedTextSchema,
  paths: PathsSchema,
  blocks: BlocksByLocale,
  seo: SeoByLocale,
  excerpt: LocalizedTextSchema.nullish(),
  coverMediaId: uuid.nullish(),
  locales: Locales,
  isMaterialChange: z.boolean(),
  changeSummary: z.string().max(500).nullish(),
});

export const saveDraft = action(
  { name: "site.page.save_draft", audience: "staff", permission: "site.edit", input: SaveDraftInput },
  async (ctx, input): Promise<{ versionId: string; updatedAt: string; issues: PublishIssue[] }> => {
    if (JSON.stringify(input).length > MAX_BODY_BYTES) throw new ValidationError("body_too_large", { blocks: "too_large" });
    const tx = ctx.tx;
    const page = await lockPage(tx, input.pageId);
    if (page.status === "archived") throw new ConflictError("page_archived");
    const content: VersionContent & { changeSummary: string | null } = {
      title: input.title,
      paths: input.paths,
      blocks: input.blocks,
      seo: input.seo,
      excerpt: input.excerpt ?? null,
      coverMediaId: input.coverMediaId ?? null,
      locales: LOCALES.filter((l) => input.locales.includes(l)),
      isMaterialChange: input.isMaterialChange,
      changeSummary: input.changeSummary ?? null,
    };
    const draft = await findDraft(tx, page.id);
    let saved;
    let oldValue: { versionId: string; sha256: string } | null = null;
    if (input.versionId) {
      if (!draft || draft.id !== input.versionId) throw new ConflictError("draft_changed");
      if (input.expectedUpdatedAt && new Date(input.expectedUpdatedAt).getTime() !== draft.updatedAt.getTime()) throw new ConflictError("draft_changed");
      oldValue = { versionId: draft.id, sha256: contentDigest({ ...versionContent(draft), changeSummary: draft.changeSummary }) };
      saved = await updateDraftContent(tx, draft, content);
    } else {
      if (draft) throw new ConflictError("draft_exists");
      saved = await insertDraft(tx, { pageId: page.id, content, basedOnVersionId: page.currentVersionId, userId: userId(ctx) });
    }
    await tx.update(pages).set({ updatedAt: ctx.now }).where(eq(pages.id, page.id));
    await ctx.audit({
      action: "site.page.save_draft",
      entityType: "page",
      entityId: page.id,
      oldValue,
      newValue: { versionId: saved.id, sha256: contentDigest(content) },
    });
    const issues = await checkContent(tx, page, content);
    return { versionId: saved.id, updatedAt: saved.updatedAt.toISOString(), issues };
  },
);

// ---------------------------------------------------------------------------------------------
// createDraftFromVersion (rule 4: restore version n), discardDraft (rules 14, 55)
// ---------------------------------------------------------------------------------------------

/** Deletes a draft row; refused while a Claude proposal is based on it. */
async function deleteDraft(ctx: Ctx, versionId: string): Promise<void> {
  const tx = ctx.tx;
  const [child] = await tx.select({ id: pageVersions.id }).from(pageVersions).where(eq(pageVersions.basedOnVersionId, versionId)).limit(1);
  if (child) throw new ConflictError("draft_is_proposal_base");
  await tx.update(pageEditRequests).set({ baseVersionId: null }).where(eq(pageEditRequests.baseVersionId, versionId));
  await tx.delete(pageVersions).where(and(eq(pageVersions.id, versionId), eq(pageVersions.state, "draft")));
}

export const createDraftFromVersion = action(
  {
    name: "site.page.restore",
    audience: "staff",
    permission: "site.edit",
    input: z.object({ pageId: uuid, fromVersionId: uuid, replaceExisting: z.boolean() }),
  },
  async (ctx, input): Promise<{ versionId: string }> => {
    const tx = ctx.tx;
    const page = await lockPage(tx, input.pageId);
    if (page.status === "archived") throw new ConflictError("page_archived");
    const from = await getVersionOrThrow(tx, input.fromVersionId);
    if (from.pageId !== page.id) throw new NotFoundError("version_not_found");
    const existing = await findDraft(tx, page.id);
    if (existing) {
      if (!input.replaceExisting) throw new ConflictError("draft_exists");
      await deleteDraft(ctx, existing.id);
    }
    const draft = await insertDraft(tx, {
      pageId: page.id,
      content: { ...versionContent(from), changeSummary: null },
      basedOnVersionId: from.id,
      userId: userId(ctx),
    });
    await ctx.audit({ action: "site.page.restore", entityType: "page", entityId: page.id, oldValue: existing ? { draftVersionId: existing.id } : null, newValue: { versionId: draft.id, fromVersionId: from.id, fromVersion: from.version } });
    return { versionId: draft.id };
  },
);

export const discardDraft = action(
  { name: "site.page.discard_draft", audience: "staff", permission: "site.edit", input: z.object({ versionId: uuid }) },
  async (ctx, input): Promise<{ ok: true }> => {
    const first = await getVersionOrThrow(ctx.tx, input.versionId);
    await lockPage(ctx.tx, first.pageId);
    const version = await getVersionOrThrow(ctx.tx, input.versionId);
    if (version.state !== "draft" || version.publishedAt) throw new ConflictError(`version_${version.state}`);
    await deleteDraft(ctx, version.id);
    await ctx.audit({
      action: "site.page.discard_draft",
      entityType: "page",
      entityId: version.pageId,
      oldValue: { versionId: version.id, version: version.version, scheduledPublishAt: version.scheduledPublishAt },
    });
    return { ok: true };
  },
);

// ---------------------------------------------------------------------------------------------
// publishVersion, cancelScheduledPublish (rules 5-8, 11, 13)
// ---------------------------------------------------------------------------------------------

export type PublishOutput = { publishedAt: string; pageId: string } | { scheduledAt: string; pageId: string };

const publishImpl = action(
  {
    name: "site.page.publish",
    audience: "staff",
    permission: "site.publish",
    input: z.object({ versionId: uuid, scheduleAt: z.string().datetime({ offset: true }).optional() }),
  },
  async (ctx, input): Promise<PublishOutput> => {
    if (input.scheduleAt) {
      const { scheduledAt, pageId } = await scheduleVersionTx(ctx.tx, ctx, input.versionId, new Date(input.scheduleAt));
      return { scheduledAt: scheduledAt.toISOString(), pageId };
    }
    const { publishedAt } = await publishVersionTx(ctx.tx, ctx, input.versionId, {});
    const version = await getVersionOrThrow(ctx.tx, input.versionId);
    return { publishedAt: publishedAt.toISOString(), pageId: version.pageId };
  },
);

/** Publishes now or schedules (`scheduleAt`); refused with `validation` and `fields.issues` (JSON) when a check fails. */
export const publishVersion = revalidating<{ versionId: string; scheduleAt?: string }, PublishOutput>(
  publishImpl,
  (data) => ("publishedAt" in data ? pageTags(data.pageId) : [`site:page:${data.pageId}`]),
);

export const cancelScheduledPublish = action(
  { name: "site.page.unschedule", audience: "staff", permission: "site.publish", input: z.object({ versionId: uuid }) },
  async (ctx, input): Promise<{ ok: true }> => {
    await cancelScheduleTx(ctx.tx, ctx, input.versionId);
    return { ok: true };
  },
);

// ---------------------------------------------------------------------------------------------
// unpublishPage, archivePage, restoreArchivedPage (rules 12, 54, 55)
// ---------------------------------------------------------------------------------------------

const RetireInput = z.object({ pageId: uuid, redirectTo: LinkSchema.optional() });

export const unpublishPage = revalidating<z.input<typeof RetireInput>, { ok: true }>(
  action({ name: "site.page.unpublish", audience: "staff", permission: "site.publish", input: RetireInput }, async (ctx, input): Promise<{ ok: true }> => {
    await unpublishPageTx(ctx.tx, ctx, input.pageId, input.redirectTo);
    return { ok: true };
  }),
  (_d, raw) => pageTags(raw.pageId),
);

export const archivePage = revalidating<z.input<typeof RetireInput>, { ok: true }>(
  action({ name: "site.page.archive", audience: "staff", permission: "site.publish", input: RetireInput }, async (ctx, input): Promise<{ ok: true }> => {
    await archivePageTx(ctx.tx, ctx, input.pageId, input.redirectTo);
    return { ok: true };
  }),
  (_d, raw) => pageTags(raw.pageId),
);

export const restoreArchivedPage = revalidating<{ pageId: string }, { ok: true }>(
  action({ name: "site.page.restore_archived", audience: "staff", permission: "site.publish", input: z.object({ pageId: uuid }) }, async (ctx, input): Promise<{ ok: true }> => {
    await restoreArchivedPageTx(ctx.tx, ctx, input.pageId);
    return { ok: true };
  }),
  (_d, raw) => pageTags(raw.pageId),
);
