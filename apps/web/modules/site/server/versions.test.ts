/**
 * site-P3 version helpers (site spec section 2 `page_versions`, rules 3-4 and 55): numbers are
 * allocated as max + 1 under the page lock, only unpublished drafts accept content updates, and
 * the audit digest depends on the content only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle, Tx } from "@beam/db";
import { pages, pageVersions } from "@beam/db/schema";
import { createTestDb } from "@beam/db/testing";
import { eq } from "@/lib/ctx";
import { ConflictError } from "@/lib/ctx";
import { publishable, slug } from "../site-p3.fixtures";
import { allocateVersion, assertMutable, contentDigest, findDraft, insertDraft, updateDraftContent, versionContent } from "./versions";

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  await h.close();
});

async function newPage() {
  const [p] = await h.db.insert(pages).values({ kind: "standard", slug: slug("ver") }).returning();
  return p!.id;
}

describe("allocateVersion and insertDraft", () => {
  it("numbers versions max + 1 and keeps one draft per page", async () => {
    const pageId = await newPage();
    await h.db.transaction(async (tx) => {
      expect(await allocateVersion(tx as Tx, pageId)).toBe(1);
      const d = await insertDraft(tx as Tx, { pageId, content: publishable("a"), basedOnVersionId: null, userId: null });
      expect(d.version).toBe(1);
      await expect(insertDraft(tx as Tx, { pageId, content: publishable("b"), basedOnVersionId: null, userId: null })).rejects.toBeInstanceOf(ConflictError);
    });
    await h.db.update(pageVersions).set({ state: "published", publishedAt: new Date() }).where(eq(pageVersions.pageId, pageId));
    await h.db.transaction(async (tx) => {
      expect(await allocateVersion(tx as Tx, pageId)).toBe(2);
      const d2 = await insertDraft(tx as Tx, { pageId, content: publishable("c"), basedOnVersionId: null, userId: null });
      expect(d2.version).toBe(2);
      expect((await findDraft(tx, pageId))?.id).toBe(d2.id);
    });
  });
});

describe("assertMutable and updateDraftContent", () => {
  it("refuses published, proposed, rejected and superseded rows", () => {
    expect(() => assertMutable({ state: "draft", publishedAt: null })).not.toThrow();
    expect(() => assertMutable({ state: "published", publishedAt: new Date() })).toThrow("version_published");
    expect(() => assertMutable({ state: "draft", publishedAt: new Date() })).toThrow("version_published");
    for (const state of ["proposed", "rejected", "superseded"] as const) expect(() => assertMutable({ state, publishedAt: null })).toThrow(`version_${state}`);
  });

  it("updates a draft, moves updated_at forward and never touches a published row", async () => {
    const pageId = await newPage();
    const draft = await h.db.transaction((tx) => insertDraft(tx as Tx, { pageId, content: publishable("d"), basedOnVersionId: null, userId: null }));
    const next = await h.db.transaction((tx) => updateDraftContent(tx as Tx, draft, { ...publishable("d"), title: { en: "New" } }));
    expect(next.title).toEqual({ en: "New" });
    expect(next.updatedAt.getTime()).toBeGreaterThan(draft.updatedAt.getTime());
    await h.db.update(pageVersions).set({ state: "published", publishedAt: new Date() }).where(eq(pageVersions.id, draft.id));
    const [published] = await h.db.select().from(pageVersions).where(eq(pageVersions.id, draft.id));
    await expect(h.db.transaction((tx) => updateDraftContent(tx as Tx, published!, publishable("x")))).rejects.toThrow("version_published");
    // A stale in-memory draft row whose database row was published meanwhile is not updated either.
    await expect(h.db.transaction((tx) => updateDraftContent(tx as Tx, next, publishable("y")))).rejects.toThrow("version_published");
    const [after] = await h.db.select().from(pageVersions).where(eq(pageVersions.id, draft.id));
    expect(after!.title).toEqual({ en: "New" });
  });
});

describe("contentDigest", () => {
  it("is a sha256 of the content and changes with it", () => {
    const a = publishable("same");
    expect(contentDigest(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(contentDigest({ ...a })).toBe(contentDigest(a));
    expect(contentDigest({ ...a, title: { en: "other" } })).not.toBe(contentDigest(a));
  });

  it("versionContent keeps only known locales", () => {
    const row = { title: {}, paths: {}, blocks: {}, seo: {}, excerpt: null, coverMediaId: null, locales: ["nl-BE", "xx"], isMaterialChange: false } as unknown as Parameters<typeof versionContent>[0];
    expect(versionContent(row).locales).toEqual(["nl-BE"]);
  });
});
