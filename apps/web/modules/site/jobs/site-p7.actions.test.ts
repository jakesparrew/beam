/**
 * site-P7 WordPress import actions through `action()`: permission, upload limits, mapping, apply,
 * retry and the bulk publish of complete imported pages.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { auditLog, jobs, pages, pageVersions, wordpressImportItems, wordpressImports } from "@beam/db/schema";
import { createTestDb } from "@beam/db/testing";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.77" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));
vi.mock("next/cache", () => ({ revalidateTag: () => undefined, unstable_cache: (fn: (...a: unknown[]) => unknown) => fn }));

const actions = await import("../actions/wordpress");
const { and, eq, setAppDb } = await import("@/lib/ctx");
const { resetRuntime, runJobTwice } = await import("@/lib/testing");
const { staffSession, publishable, slug } = await import("../site-p3.fixtures");
const { SAMPLE_XML } = await import("./site-p7.fixtures");

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

const form = (xml: string, name = "beam.xml", extra: Record<string, string> = {}) => {
  const fd = new FormData();
  fd.set("file", new File([xml], name, { type: "text/xml" }));
  fd.set("siteOrigin", extra.siteOrigin ?? "https://www.beam.be/over-ons");
  if (extra.defaultLocale) fd.set("defaultLocale", extra.defaultLocale);
  return fd;
};

describe("WordPress import actions", () => {
  it("need site.publish", async () => {
    await staffSession(h.db, jar, ["site.edit"]);
    expect(await actions.startWordpressImport(form(SAMPLE_XML))).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });

  it("refuse other file types and files over 10 MB", async () => {
    await staffSession(h.db, jar, ["site.edit", "site.publish"]);
    expect(await actions.startWordpressImport(form(SAMPLE_XML, "export.json"))).toMatchObject({ ok: false, error: { code: "validation" } });
    const big = new FormData();
    big.set("file", new File([new Uint8Array(10_485_761)], "big.xml", { type: "text/xml" }));
    big.set("siteOrigin", "https://www.beam.be");
    expect(await actions.startWordpressImport(big)).toMatchObject({ ok: false, error: { code: "validation", fields: { file: "too_large" } } });
    expect(await actions.startWordpressImport(form(SAMPLE_XML, "beam.xml", { siteOrigin: "http://www.beam.be" }))).toMatchObject({ ok: false, error: { code: "validation" } });
  });

  it("upload, map, apply, retry and publish complete pages", async () => {
    const user = await staffSession(h.db, jar, ["site.edit", "site.publish"]);
    const started = await actions.startWordpressImport(form(SAMPLE_XML, "beam.xml", { defaultLocale: "nl-BE" }));
    expect(started.ok).toBe(true);
    const importId = started.ok ? started.data.importId : "";
    const [imp] = await h.db.select().from(wordpressImports).where(eq(wordpressImports.id, importId));
    expect(imp).toMatchObject({ status: "uploaded", siteOrigin: "https://www.beam.be", createdByUserId: user.id });
    expect(await h.db.select().from(jobs).where(eq(jobs.idempotencyKey, `wp_import:${importId}:parse`))).toHaveLength(1);
    expect(await actions.applyWordpressImport({ importId })).toMatchObject({ ok: false, error: { code: "conflict" } });

    await runJobTwice(h.db, "site.parse_wordpress", { importId });
    const items = await h.db.select().from(wordpressImportItems).where(eq(wordpressImportItems.importId, importId));
    const draftPost = items.find((i) => i.wpId === 23)!;
    const [target] = await h.db.insert(pages).values({ kind: "standard", slug: slug("zomer") }).returning();
    expect(await actions.updateImportItem({ itemId: draftPost.id, decision: "redirect_only" })).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(await actions.updateImportItem({ itemId: draftPost.id, decision: "redirect_only", redirectToPageId: target!.id })).toEqual({ ok: true, data: { ok: true } });
    const audits = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "site.wp_import.update_item"), eq(auditLog.entityId, draftPost.id)));
    expect(audits).toHaveLength(1);

    expect(await actions.applyWordpressImport({ importId })).toEqual({ ok: true, data: { ok: true } });
    expect(await h.db.select().from(jobs).where(eq(jobs.idempotencyKey, `wp_import:${importId}:apply:0:0`))).toHaveLength(1);
    expect(await actions.retryImportErrors({ importId })).toMatchObject({ ok: false, error: { code: "conflict" } });

    // Simulate a finished import with one imported page that passes every check and one that does not.
    const [page] = await h.db.insert(pages).values({ kind: "standard", slug: slug("klaar") }).returning();
    await h.db.insert(pageVersions).values({ pageId: page!.id, version: 1, state: "draft", ...publishable(slug("klaar")) });
    const [bad] = await h.db.insert(pages).values({ kind: "standard", slug: slug("onaf") }).returning();
    await h.db.insert(pageVersions).values({ pageId: bad!.id, version: 1, state: "draft", ...publishable(slug("onaf")), seo: {} });
    const pageItem = items.find((i) => i.wpId === 10)!;
    const otherItem = items.find((i) => i.wpId === 12)!;
    await h.db.update(wordpressImportItems).set({ status: "imported", targetPageId: page!.id }).where(eq(wordpressImportItems.id, pageItem.id));
    await h.db.update(wordpressImportItems).set({ status: "imported", targetPageId: bad!.id }).where(eq(wordpressImportItems.id, otherItem.id));
    await h.db.update(wordpressImportItems).set({ status: "error", message: "boom" }).where(eq(wordpressImportItems.wpId, 14));
    await h.db.update(wordpressImports).set({ status: "done" }).where(eq(wordpressImports.id, importId));

    const published = await actions.publishImportedPages({ importId });
    expect(published.ok).toBe(true);
    if (!published.ok) return;
    expect(published.data.published).toBe(1);
    expect(published.data.blocked).toEqual([expect.objectContaining({ pageId: bad!.id, issues: expect.arrayContaining([expect.objectContaining({ code: expect.stringMatching(/seo/) })]) })]);
    expect((await h.db.select().from(pages).where(eq(pages.id, page!.id)))[0]).toMatchObject({ status: "published" });
    expect((await h.db.select().from(pages).where(eq(pages.id, bad!.id)))[0]).toMatchObject({ status: "draft" });

    expect(await actions.retryImportErrors({ importId })).toEqual({ ok: true, data: { retried: 1 } });
    expect((await h.db.select().from(wordpressImports).where(eq(wordpressImports.id, importId)))[0]).toMatchObject({ status: "applying" });
    expect(await h.db.select().from(jobs).where(eq(jobs.idempotencyKey, `wp_import:${importId}:apply:0:1`))).toHaveLength(1);
  });
});
