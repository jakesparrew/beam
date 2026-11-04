/**
 * site-P7 apply (rules 52-53, 64-66, edge case 40): WPML groups, redirects, `redirect_only`,
 * reruns, earlier imports, retry rounds and dead chunks.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { jobs, mediaAssets, pages, pageVersions, redirects, wordpressImportItems, wordpressImports } from "@beam/db/schema";
import { createTestDb } from "@beam/db/testing";
import { IntegrationError, isPermanentFailure } from "@beam/integrations/_shared";
import { imageSize } from "@beam/core/site";

vi.mock("next/cache", () => ({ revalidateTag: () => undefined, unstable_cache: (fn: (...a: unknown[]) => unknown) => fn }));
vi.mock("next/server", () => ({ after: () => undefined }));

const { and, eq, inArray } = await import("@/lib/ctx");
const { makeCtx, makeJobCtx, resetRuntime, runJobTwice } = await import("@/lib/testing");
const { storeFile } = await import("@/lib/files");
const apply = await import("./apply");
const { parseWxr } = await import("./wxr");
const { onApplyWordpressDead } = await import("../../jobs/wordpress");
const { makeImport, sampleFake, SAMPLE_ORIGIN } = await import("../../jobs/site-p7.fixtures");

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

type Ctx = ReturnType<typeof makeCtx>;
const tx = () => h.db as unknown as Parameters<typeof apply.applyImportChunk>[0];

async function parsedImport(xml?: string) {
  const made = await makeImport(h.db, { xml, status: "parsed" });
  const { items } = parseWxr(xml ?? (await import("../../jobs/site-p7.fixtures")).SAMPLE_XML);
  await apply.storeWxrItems(tx(), made.importId, items);
  await h.db.update(wordpressImports).set({ status: "applying" }).where(eq(wordpressImports.id, made.importId));
  return made;
}

function mediaDeps(ctx: Ctx, fake = sampleFake()) {
  return {
    fetcher: fake.client({ allowedOrigin: SAMPLE_ORIGIN, cdnOrigins: ["https://cdn.beam.be"] }),
    store: (f: { name: string; mime: string; bytes: Uint8Array }) => storeFile(ctx, { kind: "image", name: f.name, mime: f.mime, bytes: f.bytes, isPublic: true }),
    size: imageSize,
    isRetryable: (e: unknown) => e instanceof IntegrationError && !isPermanentFailure(e),
    codeOf: (e: unknown) => (e instanceof IntegrationError ? (e.code ?? null) : null),
  };
}

async function runAll(importId: string, ctx: Ctx) {
  let offset: number | null = 0;
  while (offset !== null) offset = (await apply.applyImportChunk(tx(), ctx, importId, offset, 7)).next;
}

const itemsOf = (importId: string) => h.db.select().from(wordpressImportItems).where(eq(wordpressImportItems.importId, importId));
const item = async (importId: string, wpId: number) => (await itemsOf(importId)).find((i) => i.wpId === wpId)!;
const redirectFor = async (fromPath: string) => (await h.db.select().from(redirects).where(eq(redirects.fromPath, fromPath)))[0];

/** A tiny WXR export with unique paths per test. */
function wxr(origin: string, items: { id: number; type?: string; title: string; path: string; lang?: string; trid?: number; status?: string }[]) {
  const body = items
    .map(
      (i) => `<item><title>${i.title}</title><link>${origin}${i.path}</link><content:encoded><![CDATA[<p>${i.title} tekst die lang genoeg is voor een beschrijving van de pagina op de nieuwe site.</p>]]></content:encoded>
<wp:post_id>${i.id}</wp:post_id><wp:status>${i.status ?? "publish"}</wp:status><wp:post_type>${i.type ?? "page"}</wp:post_type>
${i.lang ? `<wp:postmeta><wp:meta_key>_wpml_language</wp:meta_key><wp:meta_value>${i.lang}</wp:meta_value></wp:postmeta>` : ""}
${i.trid ? `<wp:postmeta><wp:meta_key>_wpml_trid</wp:meta_key><wp:meta_value>${i.trid}</wp:meta_value></wp:postmeta>` : ""}</item>`,
    )
    .join("\n");
  return `<?xml version="1.0"?><rss xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:wp="http://wordpress.org/export/1.2/"><channel><title>t</title>${body}</channel></rss>`;
}

describe("the sample import", () => {
  let importId: string;
  let userId: string;
  let ctx: Ctx;
  beforeAll(async () => {
    ({ importId, userId } = await parsedImport());
    ctx = makeCtx(h.db);
    let left = 1;
    while (left > 0) left = (await apply.importMediaChunk(tx(), ctx, importId, mediaDeps(ctx), 4)).remaining;
    await runAll(importId, ctx);
  });

  it("turns a WPML group into one draft page with two locales", async () => {
    const nl = await item(importId, 10);
    const fr = await item(importId, 11);
    expect(nl).toMatchObject({ status: "imported" });
    expect(fr.targetPageId).toBe(nl.targetPageId);
    const [page] = await h.db.select().from(pages).where(eq(pages.id, nl.targetPageId!));
    expect(page).toMatchObject({ kind: "standard", status: "draft", slug: "over-ons", createdByUserId: null, currentVersionId: null });
    const versions = await h.db.select().from(pageVersions).where(eq(pageVersions.pageId, page!.id));
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ version: 1, state: "draft", createdBy: "user", createdByUserId: userId, locales: ["nl-BE", "fr-BE"] });
    expect(versions[0]!.title).toEqual({ "nl-BE": "Over ons", "fr-BE": "À propos" });
    expect(versions[0]!.paths).toEqual({ "nl-BE": "over-ons", "fr-BE": "a-propos" });
    const nlBlocks = versions[0]!.blocks["nl-BE"]!;
    expect(nlBlocks.map((b) => b.type)).toEqual(expect.arrayContaining(["rich_text", "image", "video"]));
    const posts = await h.db.select().from(pages).where(and(eq(pages.kind, "post"), inArray(pages.id, (await itemsOf(importId)).map((i) => i.targetPageId!).filter(Boolean))));
    expect(posts).toHaveLength(2);
  });

  it("creates a redirect for each old path, fallback permalink and attachment URL", async () => {
    const nl = await item(importId, 10);
    expect(await redirectFor("/over-ons")).toMatchObject({ toPageId: nl.targetPageId, toLocale: "nl-BE", source: "wordpress", isPermanent: true });
    expect(await redirectFor("/?page_id=10")).toMatchObject({ toPageId: nl.targetPageId, toLocale: "nl-BE" });
    expect(await redirectFor("/fr/a-propos")).toBeUndefined();
    const pool = await item(importId, 30);
    expect(pool).toMatchObject({ status: "imported" });
    const [media] = await h.db.select().from(mediaAssets).where(eq(mediaAssets.id, pool.targetMediaId!));
    expect(media).toMatchObject({ source: "wordpress", width: 1200, height: 800, wordpressUrl: `${SAMPLE_ORIGIN}/wp-content/uploads/2024/01/pool.jpg` });
    expect(media!.alt).toEqual({ "nl-BE": "Het zwembad" });
    expect(await redirectFor("/wp-content/uploads/2024/01/pool.jpg")).toMatchObject({ toUrl: `/api/public/files/${media!.fileId}`, toPageId: null });
    expect(await redirectFor("/over-ons/pool")).toMatchObject({ toUrl: `/api/public/files/${media!.fileId}` });
    expect(await redirectFor("/wp-content/uploads/2024/03/opening.jpg")).toBeDefined();
  });

  it("skips drafts and counts the import", async () => {
    expect(await item(importId, 23)).toMatchObject({ status: "skipped", decision: "skip" });
    const [imp] = await h.db.select().from(wordpressImports).where(eq(wordpressImports.id, importId));
    expect(imp!.counts).toMatchObject({ pages: 10, posts: 4, attachments: 6, imported: 19, skipped: 1, errors: 0 });
    expect(imp!.counts.redirects).toBeGreaterThan(20);
    expect((imp!.report as { convert?: { shortcodes: string[] } }).convert?.shortcodes).toEqual(expect.arrayContaining(["gallery", "caption"]));
    expect(await apply.finishImportIfComplete(tx(), ctx, importId)).toBe(true);
    expect((await h.db.select().from(wordpressImports).where(eq(wordpressImports.id, importId)))[0]).toMatchObject({ status: "done", appliedAt: expect.any(Date) });
  });

  it("a rerun creates nothing new", async () => {
    const count = async () => ({
      pages: (await h.db.select({ id: pages.id }).from(pages)).length,
      versions: (await h.db.select({ id: pageVersions.id }).from(pageVersions)).length,
      redirects: (await h.db.select({ id: redirects.id }).from(redirects)).length,
      media: (await h.db.select({ id: mediaAssets.id }).from(mediaAssets)).length,
    });
    const before = await count();
    await runAll(importId, ctx);
    await apply.importMediaChunk(tx(), ctx, importId, mediaDeps(ctx));
    expect(await count()).toEqual(before);
  });

  it("an item already imported by an earlier import is skipped", async () => {
    const second = await parsedImport();
    const c = makeCtx(h.db);
    const fake = sampleFake();
    await apply.importMediaChunk(tx(), c, second.importId, mediaDeps(c, fake), 20);
    expect(fake.calls).toHaveLength(0);
    await runAll(second.importId, c);
    const rows = await itemsOf(second.importId);
    expect(rows.filter((r) => r.wpType !== "attachment" && r.decision === "import").every((r) => r.status === "skipped" && r.message === apply.ALREADY_IMPORTED)).toBe(true);
    expect(rows.filter((r) => r.wpType === "attachment").every((r) => r.status === "imported")).toBe(true);
  });
});

describe("single steps", () => {
  it("inserts the /feed redirect once", async () => {
    expect(await apply.insertFeedRedirect(tx())).toBe(1);
    expect(await apply.insertFeedRedirect(tx())).toBe(0);
    expect(await redirectFor("/feed")).toMatchObject({ toUrl: "/nl/feed.xml", source: "wordpress" });
  });

  it("a redirect_only item only gets its redirect", async () => {
    const origin = "https://ro.example";
    const { importId } = await parsedImport(wxr(origin, [{ id: 1, title: "Oud aanbod", path: "/oud-aanbod-ro/" }]));
    const [target] = await h.db.insert(pages).values({ kind: "standard", slug: `target-${randomUUID().slice(0, 6)}` }).returning();
    await h.db.update(wordpressImportItems).set({ decision: "redirect_only", redirectToPageId: target!.id }).where(eq(wordpressImportItems.importId, importId));
    const pagesBefore = (await h.db.select({ id: pages.id }).from(pages)).length;
    await runAll(importId, makeCtx(h.db));
    expect((await h.db.select({ id: pages.id }).from(pages)).length).toBe(pagesBefore);
    expect(await item(importId, 1)).toMatchObject({ status: "imported", targetPageId: null });
    expect(await redirectFor("/oud-aanbod-ro")).toMatchObject({ toPageId: target!.id, toLocale: "nl-BE" });
  });

  it("retryImportErrors re-runs only error items and moves the import through applying to done", async () => {
    const origin = "https://retry.example";
    const { importId } = await parsedImport(wxr(origin, [
      { id: 1, title: "Eerste", path: "/eerste-rt/" },
      { id: 2, title: "Tweede", path: "/tweede-rt/" },
    ]));
    const ctx = makeCtx(h.db);
    await runAll(importId, ctx);
    const first = await item(importId, 1);
    await h.db.update(wordpressImportItems).set({ status: "error", message: "boom", targetPageId: null }).where(and(eq(wordpressImportItems.importId, importId), eq(wordpressImportItems.wpId, 2)));
    await h.db.update(wordpressImports).set({ status: "done" }).where(eq(wordpressImports.id, importId));

    const jctx = makeJobCtx(h.db, "site.apply_wordpress");
    const out = await apply.retryImportTx(tx(), jctx, importId);
    expect(out).toEqual({ retried: 1, round: 1 });
    expect((await h.db.select().from(wordpressImports).where(eq(wordpressImports.id, importId)))[0]).toMatchObject({ status: "applying", report: expect.objectContaining({ round: 1 }) });
    expect(await item(importId, 2)).toMatchObject({ status: "pending", message: null });
    const queued = await h.db.select().from(jobs).where(eq(jobs.idempotencyKey, apply.applyJobKey(importId, 0, 1)));
    expect(queued).toHaveLength(1);

    await runJobTwice(h.db, "site.apply_wordpress", { importId, offset: 0, round: 1 });
    expect((await h.db.select().from(wordpressImports).where(eq(wordpressImports.id, importId)))[0]!.status).toBe("done");
    expect(await item(importId, 2)).toMatchObject({ status: "imported", targetPageId: expect.any(String) });
    const again = await item(importId, 1);
    expect(again.updatedAt).toEqual(first.updatedAt);
    await expect(apply.retryImportTx(tx(), jctx, importId)).resolves.toEqual({ retried: 0, round: 2 });
    await h.db.update(wordpressImports).set({ status: "parsed" }).where(eq(wordpressImports.id, importId));
    await expect(apply.retryImportTx(tx(), jctx, importId)).rejects.toMatchObject({ code: "conflict" });
  });

  it("a dead chunk sets the import failed", async () => {
    const { importId } = await parsedImport(wxr("https://dead.example", [{ id: 1, title: "Dood", path: "/dood-dc/" }]));
    await onApplyWordpressDead(makeJobCtx(h.db, "site.apply_wordpress"), { importId, offset: 0, round: 0, wait: 0 }, { message: "timeout", permanent: false });
    const [imp] = await h.db.select().from(wordpressImports).where(eq(wordpressImports.id, importId));
    expect(imp).toMatchObject({ status: "failed", report: expect.objectContaining({ lastError: "timeout" }) });
  });

  it("a translation group with two items of one locale imports the first and reports the second", async () => {
    const { importId } = await parsedImport(wxr("https://dup.example", [
      { id: 1, title: "Een", path: "/een-dup/", lang: "nl", trid: 9 },
      { id: 2, title: "Twee", path: "/twee-dup/", lang: "nl", trid: 9 },
    ]));
    await runAll(importId, makeCtx(h.db));
    expect(await item(importId, 1)).toMatchObject({ status: "imported" });
    expect(await item(importId, 2)).toMatchObject({ status: "error", message: "duplicate locale nl-BE in translation group" });
  });

  it("derives paths and descriptions", () => {
    expect(apply.pagePathFor({ wpPath: "/fr/a-propos", title: "x", wpId: 1, wpType: "page" })).toBe("a-propos");
    expect(apply.pagePathFor({ wpPath: "/?p=23", title: "Concept: zomer", wpId: 23, wpType: "post" })).toBe("concept-zomer");
    expect(apply.pagePathFor({ wpPath: "/account/x", title: "", wpId: 5, wpType: "page" })).toBe("page-5");
    expect(apply.pagePathFor({ wpPath: "/a/b/c/d", title: "", wpId: 5, wpType: "page" })).toBe("b/c/d");
    expect(apply.seoDescription("kort", [])).toBe("kort");
    expect(apply.seoDescription("woord ".repeat(60), []).length).toBeLessThanOrEqual(160);
  });
});
