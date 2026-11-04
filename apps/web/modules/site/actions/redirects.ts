"use server";
/**
 * site server actions, redirects (site spec section 4, section 2 `redirects`, edge case 6;
 * site-P3): upsertRedirect, deleteRedirect (`site.publish`). `from_path` is normalised by
 * `normalisePath()`; a path a live page uses is refused with `conflict`; a redirect that points
 * at itself or closes a loop of site-relative redirects is refused with `validation`.
 */
import { z } from "zod";
import { pageRoutes, pages, redirects } from "@beam/db/schema";
import { LOCALES } from "@beam/core/i18n";
import { isSafeHref, localePath, normalisePath } from "@beam/core/site";
import { action, type ActionResult } from "@/lib/action";
import { and, ConflictError, eq, ne, NotFoundError, ValidationError, type Tx } from "@/lib/ctx";
import { REDIRECT_TAGS, revalidateSite } from "../server/cache";

const MAX_HOPS = 20;

const UpsertRedirectInput = z.object({
  id: z.string().uuid().optional(),
  fromPath: z.string().min(1).max(500),
  to: z.union([z.object({ pageId: z.string().uuid(), locale: z.enum(LOCALES) }).strict(), z.object({ url: z.string().min(1).max(500) }).strict()]),
  isPermanent: z.boolean(),
});

/** True when `fromPath` is a live route `/<prefix>/<path>` of a published page. */
async function isLivePath(tx: Tx, fromPath: string): Promise<boolean> {
  const rows = await tx.select({ locale: pageRoutes.locale, path: pageRoutes.path }).from(pageRoutes);
  return rows.some((r) => localePath(r.locale, r.path) === fromPath);
}

/** Follows site-relative `to_url` redirects from `start`; true when the chain comes back to `fromPath`. */
async function closesLoop(tx: Tx, fromPath: string, start: string, selfId: string | undefined): Promise<boolean> {
  let at = start;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    if (at === fromPath) return true;
    const [next] = await tx
      .select({ id: redirects.id, toUrl: redirects.toUrl })
      .from(redirects)
      .where(selfId ? and(eq(redirects.fromPath, at), ne(redirects.id, selfId)) : eq(redirects.fromPath, at));
    if (!next?.toUrl || !next.toUrl.startsWith("/")) return false;
    at = normalisePath(next.toUrl);
  }
  return true;
}

const upsertImpl = action(
  { name: "site.redirect.upsert", audience: "staff", permission: "site.publish", input: UpsertRedirectInput },
  async (ctx, input): Promise<{ id: string }> => {
    const tx = ctx.tx;
    const fromPath = normalisePath(input.fromPath);
    if (/^\/(admin|api|_next)(\/|$)/.test(fromPath)) throw new ValidationError("from_path_reserved", { fromPath: "reserved" });
    if (await isLivePath(tx, fromPath)) throw new ConflictError("live_path");

    let target: { toPageId: string; toLocale: (typeof LOCALES)[number]; toUrl: null } | { toPageId: null; toLocale: null; toUrl: string };
    if ("url" in input.to) {
      const url = input.to.url.trim();
      const relative = url.startsWith("/") && !url.startsWith("//");
      if (!relative && !(url.startsWith("https://") && isSafeHref(url))) throw new ValidationError("to_url_invalid", { to: "invalid" });
      const toUrl = relative ? normalisePath(url) : url;
      if (relative && (toUrl === fromPath || (await closesLoop(tx, fromPath, toUrl, input.id)))) throw new ValidationError("redirect_loop", { to: "loop" });
      target = { toPageId: null, toLocale: null, toUrl };
    } else {
      const [page] = await tx.select({ status: pages.status }).from(pages).where(eq(pages.id, input.to.pageId));
      if (!page) throw new ValidationError("to_page_missing", { to: "missing" });
      if (page.status === "archived") throw new ValidationError("to_page_archived", { to: "archived" });
      target = { toPageId: input.to.pageId, toLocale: input.to.locale, toUrl: null };
    }

    const userId = ctx.actor.kind === "staff" ? ctx.actor.userId : null;
    let id: string;
    let oldValue: unknown = null;
    if (input.id) {
      const [row] = await tx.select().from(redirects).where(eq(redirects.id, input.id)).for("update");
      if (!row) throw new NotFoundError("redirect_not_found");
      oldValue = { fromPath: row.fromPath, toPageId: row.toPageId, toLocale: row.toLocale, toUrl: row.toUrl, isPermanent: row.isPermanent };
      const [clash] = await tx.select({ id: redirects.id }).from(redirects).where(and(eq(redirects.fromPath, fromPath), ne(redirects.id, row.id)));
      if (clash) throw new ConflictError("from_path_taken");
      await tx.update(redirects).set({ fromPath, ...target, isPermanent: input.isPermanent, updatedAt: ctx.now }).where(eq(redirects.id, row.id));
      id = row.id;
    } else {
      const [clash] = await tx.select({ id: redirects.id }).from(redirects).where(eq(redirects.fromPath, fromPath));
      if (clash) throw new ConflictError("from_path_taken");
      const [row] = await tx.insert(redirects).values({ fromPath, ...target, isPermanent: input.isPermanent, source: "manual", createdByUserId: userId }).returning({ id: redirects.id });
      id = row!.id;
    }
    await ctx.audit({ action: "site.redirect.upsert", entityType: "redirect", entityId: id, oldValue, newValue: { fromPath, ...target, isPermanent: input.isPermanent } });
    return { id };
  },
);

const deleteImpl = action(
  { name: "site.redirect.delete", audience: "staff", permission: "site.publish", input: z.object({ id: z.string().uuid() }) },
  async (ctx, input): Promise<{ ok: true }> => {
    const [row] = await ctx.tx.delete(redirects).where(eq(redirects.id, input.id)).returning();
    if (!row) throw new NotFoundError("redirect_not_found");
    await ctx.audit({ action: "site.redirect.delete", entityType: "redirect", entityId: row.id, oldValue: { fromPath: row.fromPath, toPageId: row.toPageId, toLocale: row.toLocale, toUrl: row.toUrl, source: row.source } });
    return { ok: true };
  },
);

/** Creates (`source = 'manual'`) or edits a redirect. */
export async function upsertRedirect(raw: unknown): Promise<ActionResult<{ id: string }>> {
  const result = await upsertImpl(raw);
  if (result.ok) revalidateSite(REDIRECT_TAGS);
  return result;
}

export async function deleteRedirect(raw: unknown): Promise<ActionResult<{ ok: true }>> {
  const result = await deleteImpl(raw);
  if (result.ok) revalidateSite(REDIRECT_TAGS);
  return result;
}
