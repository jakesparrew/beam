"use server";
/**
 * site server actions, WordPress import (site spec section 4, rules 52-53, 64-66; site-P7):
 * startWordpressImport, updateImportItem, applyWordpressImport, retryImportErrors,
 * publishImportedPages. All need `site.publish` (section 7). The work runs in the jobs of
 * `jobs/wordpress.ts`; these actions validate, record the staff's choices and enqueue.
 */
import { z } from "zod";
import { pages, wordpressImportItems, wordpressImports } from "@beam/db/schema";
import { LOCALES } from "@beam/core/i18n";
import type { PublishIssue } from "@beam/core/site";
import { action, type ActionResult } from "@/lib/action";
import { ConflictError, eq, NotFoundError, ValidationError } from "@/lib/ctx";
import { MAX_FILE_BYTES, storeFile } from "@/lib/files";
import { pageTags, revalidateSite } from "../server/cache";
import { PublishBlockedError, publishVersionTx } from "../server/publish";
import { applyJobKey, lockImport, parseJobKey, publishImportedPagesTx, retryImportTx } from "../server/wordpress/apply";

const uuid = z.string().uuid();
const isBlob = (v: unknown): v is Blob => typeof Blob !== "undefined" && v instanceof Blob;
const XML_MIMES = ["application/xml", "text/xml", "application/rss+xml", ""];

/** `https://www.beam.be/anything` -> `https://www.beam.be`; anything but an https URL is refused. */
const SiteOrigin = z
  .string()
  .trim()
  .max(200)
  .transform((value, ctx) => {
    try {
      const u = new URL(value);
      if (u.protocol === "https:" && !u.username && !u.password) return u.origin.toLowerCase();
    } catch {
      // fall through
    }
    ctx.addIssue({ code: "custom", message: "https_origin_required" });
    return z.NEVER;
  });

const StartImportInput = z.preprocess(
  (raw) =>
    typeof FormData !== "undefined" && raw instanceof FormData
      ? { file: raw.get("file"), siteOrigin: raw.get("siteOrigin"), defaultLocale: raw.get("defaultLocale") || undefined }
      : raw,
  z.object({
    file: z.custom<Blob>(isBlob, { message: "file required" }),
    siteOrigin: SiteOrigin,
    defaultLocale: z.enum(LOCALES).default("nl-BE"),
  }),
);

const startImpl = action(
  { name: "site.wp_import.start", audience: "staff", permission: "site.publish", input: StartImportInput },
  async (ctx, input): Promise<{ importId: string }> => {
    const file = input.file;
    const name = ((file as Blob & { name?: string }).name || "wordpress.xml").slice(0, 200);
    if (file.size > MAX_FILE_BYTES) throw new ValidationError("file_too_large", { file: "too_large" });
    if (!/\.xml$/i.test(name) || !XML_MIMES.includes(file.type)) throw new ValidationError("type_not_allowed", { file: "type_not_allowed" });
    const bytes = new Uint8Array(await file.arrayBuffer());
    const stored = await storeFile(ctx, { kind: "import", name, mime: "application/xml", bytes });
    if (ctx.actor.kind !== "staff") throw new ValidationError("validation");
    const [row] = await ctx.tx
      .insert(wordpressImports)
      .values({ fileId: stored.fileId, siteOrigin: input.siteOrigin, defaultLocale: input.defaultLocale, createdByUserId: ctx.actor.userId })
      .returning({ id: wordpressImports.id });
    const importId = row!.id;
    await ctx.enqueue({ kind: "site.parse_wordpress", payload: { importId }, key: parseJobKey(importId) });
    await ctx.audit({ action: "site.wp_import.start", entityType: "wordpress_import", entityId: importId, newValue: { fileId: stored.fileId, name, sizeBytes: bytes.byteLength, siteOrigin: input.siteOrigin, defaultLocale: input.defaultLocale } });
    return { importId };
  },
);

/** Uploads a WXR export (`.xml`, at most 10 MB) and starts parsing it (rule 65). */
export async function startWordpressImport(raw: unknown): Promise<ActionResult<{ importId: string }>> {
  return startImpl(raw);
}

const UpdateImportItemInput = z.object({
  itemId: uuid,
  decision: z.enum(["import", "skip", "redirect_only"]),
  locale: z.enum(LOCALES).nullish(),
  translationGroup: z.string().trim().max(200).nullish(),
  redirectToPageId: uuid.nullish(),
});

const updateItemImpl = action(
  { name: "site.wp_import.update_item", audience: "staff", permission: "site.publish", input: UpdateImportItemInput },
  async (ctx, input): Promise<{ ok: true }> => {
    const [item] = await ctx.tx.select().from(wordpressImportItems).where(eq(wordpressImportItems.id, input.itemId)).for("update");
    if (!item) throw new NotFoundError("import_item_not_found");
    const imp = await lockImport(ctx.tx, item.importId);
    if (!imp) throw new NotFoundError("import_not_found");
    const mappable = imp.status === "parsed" || ((imp.status === "done" || imp.status === "failed") && item.status === "error");
    if (!mappable || (item.status !== "pending" && item.status !== "error")) throw new ConflictError(`import_${imp.status}`);
    const redirectToPageId = input.decision === "redirect_only" ? (input.redirectToPageId ?? null) : null;
    if (input.decision === "redirect_only") {
      if (!redirectToPageId) throw new ValidationError("validation", { redirectToPageId: "required" });
      const [target] = await ctx.tx.select({ status: pages.status }).from(pages).where(eq(pages.id, redirectToPageId));
      if (!target || target.status === "archived") throw new ValidationError("validation", { redirectToPageId: "not_found" });
    }
    const next = {
      decision: input.decision,
      locale: input.locale === undefined ? item.locale : input.locale,
      translationGroup: input.translationGroup === undefined ? item.translationGroup : input.translationGroup || null,
      redirectToPageId,
    };
    await ctx.tx.update(wordpressImportItems).set({ ...next, updatedAt: ctx.now }).where(eq(wordpressImportItems.id, item.id));
    await ctx.audit({
      action: "site.wp_import.update_item",
      entityType: "wordpress_import_item",
      entityId: item.id,
      oldValue: { decision: item.decision, locale: item.locale, translationGroup: item.translationGroup, redirectToPageId: item.redirectToPageId },
      newValue: next,
    });
    return { ok: true };
  },
);

/** Maps one item: decision, locale, translation group, `redirect_only` target. */
export async function updateImportItem(raw: unknown): Promise<ActionResult<{ ok: true }>> {
  return updateItemImpl(raw);
}

const ImportIdInput = z.object({ importId: uuid });

const applyImpl = action(
  { name: "site.wp_import.apply", audience: "staff", permission: "site.publish", input: ImportIdInput },
  async (ctx, input): Promise<{ ok: true }> => {
    const imp = await lockImport(ctx.tx, input.importId);
    if (!imp) throw new NotFoundError("import_not_found");
    if (imp.status !== "parsed") throw new ConflictError(`import_${imp.status}`);
    await ctx.enqueue({ kind: "site.apply_wordpress", payload: { importId: imp.id, offset: 0, round: 0 }, key: applyJobKey(imp.id, 0, 0) });
    await ctx.audit({ action: "site.wp_import.apply", entityType: "wordpress_import", entityId: imp.id, newValue: { counts: imp.counts } });
    return { ok: true };
  },
);

/** Starts applying a parsed import (status `parsed`): media, draft pages and redirects. */
export async function applyWordpressImport(raw: unknown): Promise<ActionResult<{ ok: true }>> {
  return applyImpl(raw);
}

const retryImpl = action(
  { name: "site.wp_import.retry", audience: "staff", permission: "site.publish", input: ImportIdInput },
  async (ctx, input): Promise<{ retried: number }> => {
    const { retried, round } = await retryImportTx(ctx.tx, ctx, input.importId);
    await ctx.audit({ action: "site.wp_import.retry", entityType: "wordpress_import", entityId: input.importId, newValue: { retried, round } });
    return { retried };
  },
);

/** Rule 66: a `done` or `failed` import runs its `error` items again in a new round. */
export async function retryImportErrors(raw: unknown): Promise<ActionResult<{ retried: number }>> {
  return retryImpl(raw);
}

type PublishImportedOutput = { published: number; blocked: { pageId: string; issues: PublishIssue[] }[] };

const publishImpl = action(
  // Each page publish writes its own `site.page.publish` audit row (publishVersionTx).
  { name: "site.wp_import.publish", audience: "staff", permission: "site.publish", input: ImportIdInput, audit: false },
  async (ctx, input): Promise<PublishImportedOutput & { pageIds: string[] }> => {
    const imp = await lockImport(ctx.tx, input.importId);
    if (!imp) throw new NotFoundError("import_not_found");
    return publishImportedPagesTx(
      ctx.tx,
      ctx,
      imp.id,
      (sp, versionId) => publishVersionTx(sp, ctx, versionId, {}),
      (e) => (e instanceof PublishBlockedError ? e.issues : e instanceof ConflictError ? [{ code: e.message, message: e.message }] : null),
    );
  },
);

/** Publishes every imported page whose checks pass; the others are returned with their issues. */
export async function publishImportedPages(raw: unknown): Promise<ActionResult<PublishImportedOutput>> {
  const result = await publishImpl(raw);
  if (!result.ok) return result;
  const { pageIds, ...data } = result.data;
  if (pageIds.length) revalidateSite([...new Set(pageIds.flatMap(pageTags))]);
  return { ok: true, data };
}
