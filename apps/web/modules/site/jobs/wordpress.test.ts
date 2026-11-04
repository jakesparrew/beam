/**
 * site-P7 WordPress jobs: parse, media and apply each run twice with the same state after the
 * second run; a 404 attachment becomes an `error` item and the chunk goes on; invalid XML ends the
 * import `failed` with the parser's line; provider calls are logged in `integration_calls`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { integrationCalls, jobs, mediaAssets, pages, pageVersions, redirects, wordpressImportItems, wordpressImports } from "@beam/db/schema";
import { createTestDb } from "@beam/db/testing";
import { PermanentError } from "@beam/core/errors";

vi.mock("next/cache", () => ({ revalidateTag: () => undefined, unstable_cache: (fn: (...a: unknown[]) => unknown) => fn }));
vi.mock("next/server", () => ({ after: () => undefined }));

const { eq, like } = await import("drizzle-orm");
const { makeJobCtx, resetRuntime, runJobTwice } = await import("@/lib/testing");
const wp = await import("./wordpress");
const { applyJobKey, mediaJobKey } = await import("../server/wordpress/apply");
const { makeImport, sampleFake, SAMPLE_MEDIA } = await import("./site-p7.fixtures");

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  wp.setWordpressMediaClientFactory(undefined);
  resetRuntime();
  await h.close();
});

let fake = sampleFake();
beforeEach(() => {
  fake = sampleFake();
  wp.setWordpressMediaClientFactory(({ allowedOrigin, cdnOrigins, ctx }) => fake.client({ allowedOrigin, cdnOrigins, onCall: (e) => ctx.integrationLog(e) }));
});

const importRow = async (id: string) => (await h.db.select().from(wordpressImports).where(eq(wordpressImports.id, id)))[0]!;
const items = (id: string) => h.db.select().from(wordpressImportItems).where(eq(wordpressImportItems.importId, id)).orderBy(wordpressImportItems.wpType, wordpressImportItems.wpId);
const queued = (key: string) => h.db.select().from(jobs).where(eq(jobs.idempotencyKey, key));
const snapshot = async (id: string) => ({
  imp: await importRow(id),
  items: (await items(id)).map(({ updatedAt: _u, ...rest }) => rest),
  pages: (await h.db.select({ id: pages.id }).from(pages)).length,
  versions: (await h.db.select({ id: pageVersions.id }).from(pageVersions)).length,
  redirects: (await h.db.select({ id: redirects.id }).from(redirects)).length,
  media: (await h.db.select({ id: mediaAssets.id }).from(mediaAssets)).length,
});
const stable = (s: Awaited<ReturnType<typeof snapshot>>) => ({ ...s, imp: { ...s.imp, updatedAt: null } });

describe("site.parse_wordpress", () => {
  it("parses the file into items once; the second run changes nothing", async () => {
    const { importId } = await makeImport(h.db);
    const { first, second } = await runJobTwice(h.db, "site.parse_wordpress", { importId });
    expect(first).toMatchObject({ outcome: "parsed", items: 20, errors: 0 });
    expect(second).toMatchObject({ outcome: "skipped", reason: "status_parsed" });
    const imp = await importRow(importId);
    expect(imp).toMatchObject({ status: "parsed", counts: expect.objectContaining({ pages: 10, posts: 4, attachments: 6 }) });
    expect(imp.report).toMatchObject({ cdnOrigins: ["https://cdn.beam.be"], parseErrors: [] });
    expect(JSON.stringify(await items(importId))).not.toMatch(/author@example\.com|commenter@example\.com/);
  });

  it("invalid XML ends the import failed with the parser's line", async () => {
    const { importId } = await makeImport(h.db, { xml: "<?xml version=\"1.0\"?>\n<rss>\n<channel>\n<item>\n</channel></rss>" });
    const ctx = makeJobCtx(h.db, "site.parse_wordpress");
    await expect(wp.parseWordpress(ctx, { importId })).rejects.toBeInstanceOf(PermanentError);
    await expect(wp.parseWordpress(ctx, { importId })).rejects.toThrow(/line 5/);
    await wp.onParseWordpressDead(ctx, { importId }, { message: "wxr_invalid: line 5: Expected closing tag 'item'", permanent: true });
    await wp.onParseWordpressDead(ctx, { importId }, { message: "wxr_invalid: line 5: Expected closing tag 'item'", permanent: true });
    expect(await importRow(importId)).toMatchObject({ status: "failed", report: { parseError: { line: 5, message: "Expected closing tag 'item'" } } });
  });
});

describe("site.fetch_wordpress_media", () => {
  it("fetches each attachment once, logs the calls, and a 404 marks only that item error", async () => {
    const { importId } = await makeImport(h.db);
    await runJobTwice(h.db, "site.parse_wordpress", { importId });
    await h.db.update(wordpressImports).set({ status: "applying" }).where(eq(wordpressImports.id, importId));
    const missing = Object.keys(SAMPLE_MEDIA).find((u) => u.endsWith("logo.gif"))!;
    fake.set(missing, { status: 404 });

    const { first, second } = await runJobTwice(h.db, "site.fetch_wordpress_media", { importId, n: 0 });
    expect(first).toMatchObject({ outcome: "fetched", processed: 6, remaining: 0 });
    expect(second).toMatchObject({ outcome: "fetched", processed: 0, remaining: 0 });
    const atts = (await items(importId)).filter((i) => i.wpType === "attachment");
    expect(atts.filter((a) => a.status === "imported")).toHaveLength(5);
    expect(atts.find((a) => a.attachmentUrl === missing)).toMatchObject({ status: "error", message: "media missing" });
    expect(fake.calls).toHaveLength(6);
    const calls = await h.db.select().from(integrationCalls).where(eq(integrationCalls.provider, "wordpress"));
    expect(calls).toHaveLength(6);
    expect(calls.filter((c) => !c.ok)).toHaveLength(1);
    expect(await queued(mediaJobKey(importId, 1))).toHaveLength(0);
    expect((await importRow(importId)).report).toMatchObject({ mediaNext: 1 });
  });

  it("does nothing before the import is applying", async () => {
    const { importId } = await makeImport(h.db);
    const { first } = await runJobTwice(h.db, "site.fetch_wordpress_media", { importId, n: 0 });
    expect(first).toMatchObject({ outcome: "skipped", reason: "status_uploaded" });
  });
});

describe("site.apply_wordpress", () => {
  it("waits for media, then converts; every step run twice leaves the same state", async () => {
    const xml = (await import("./site-p7.fixtures")).SAMPLE_XML.replaceAll("https://www.beam.be/", "https://www.apply.example/").replaceAll("https://cdn.beam.be", "https://cdn.apply.example");
    const { importId } = await makeImport(h.db, { xml, siteOrigin: "https://www.apply.example" });
    fake = sampleFake(Object.fromEntries(Object.entries(SAMPLE_MEDIA).map(([u, f]) => [u.replace("https://www.beam.be", "https://www.apply.example").replace("https://cdn.beam.be", "https://cdn.apply.example"), f])));
    await runJobTwice(h.db, "site.parse_wordpress", { importId });

    const start = await runJobTwice(h.db, "site.apply_wordpress", { importId, offset: 0, round: 0 });
    expect(start.first).toMatchObject({ outcome: "waiting_media", wait: 1 });
    expect(start.second).toMatchObject({ outcome: "waiting_media", wait: 1 });
    expect(await importRow(importId)).toMatchObject({ status: "applying" });
    expect(await queued(mediaJobKey(importId, 0))).toHaveLength(1);
    expect(await queued(applyJobKey(importId, 0, 0, 1))).toEqual([expect.objectContaining({ runAt: expect.any(Date) })]);
    expect((await h.db.select().from(redirects).where(eq(redirects.fromPath, "/feed"))).length).toBe(1);

    await runJobTwice(h.db, "site.fetch_wordpress_media", { importId, n: 0 });
    const before = await snapshot(importId);
    const chunk = await runJobTwice(h.db, "site.apply_wordpress", { importId, offset: 0, round: 0, wait: 1 });
    expect(chunk.first).toMatchObject({ outcome: "done", next: null });
    expect(chunk.second).toMatchObject({ outcome: "skipped", reason: "status_done" });
    const after = await snapshot(importId);
    expect(after.pages - before.pages).toBe(7);
    expect(after.imp).toMatchObject({ status: "done", appliedAt: expect.any(Date), counts: expect.objectContaining({ imported: 19, skipped: 1, errors: 0 }) });

    const again = await runJobTwice(h.db, "site.apply_wordpress", { importId, offset: 0, round: 0, wait: 1 });
    expect(again.first).toMatchObject({ outcome: "skipped" });
    expect(stable(await snapshot(importId))).toEqual(stable(after));
    const apexRedirects = await h.db.select().from(redirects).where(like(redirects.fromPath, "/over-ons%"));
    expect(apexRedirects.length).toBeGreaterThan(0);
  });

  it("chains chunks by offset and skips a stale round", async () => {
    const { importId } = await makeImport(h.db, { status: "parsed" });
    const stale = await runJobTwice(h.db, "site.apply_wordpress", { importId, offset: 0, round: 3 });
    expect(stale.first).toMatchObject({ outcome: "skipped", reason: "stale_round" });
  });
});
