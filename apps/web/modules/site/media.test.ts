/**
 * site-P3 media library (site spec section 4 `uploadMedia`/`updateMedia`/`deleteMedia`, section 2
 * `media_assets`): mime and size refusal, SVG refused, dimensions from the file header stored,
 * delete refused while a draft, proposal or live version references the image.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { auditLog, files, mediaAssets, pages, pageVersions } from "@beam/db/schema";
import { createTestDb } from "@beam/db/testing";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.44" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));
vi.mock("next/cache", () => ({ revalidateTag: () => undefined, unstable_cache: (fn: (...a: unknown[]) => unknown) => fn }));

const { deleteMedia, updateMedia, uploadMedia } = await import("./actions/media");
const { eq, setAppDb } = await import("@/lib/ctx");
const { resetRuntime } = await import("@/lib/testing");
const { listMedia } = await import("./queries/admin");
const { makeMedia, PNG_1X1, slug, staffSession } = await import("./site-p3.fixtures");

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  jar.clear();
  await staffSession(h.db, jar, ["site.edit"]);
});

/** A 3x2 GIF header (dimensions are read from bytes 6-9). */
const GIF_3X2 = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x03, 0x00, 0x02, 0x00, 0x80, 0x00, 0x00, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x03, 0x00, 0x02, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b]);

function form(bytes: Uint8Array, type: string, name: string, extra: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set("file", new File([bytes as Uint8Array<ArrayBuffer>], name, { type }));
  fd.set("alt", JSON.stringify({ "nl-BE": "Saunatuin", "fr-BE": "Jardin du sauna", en: "Sauna garden" }));
  for (const [k, v] of Object.entries(extra)) fd.set(k, v);
  return fd;
}

describe("uploadMedia", () => {
  it("stores the image with its dimensions, alt text and a public file", async () => {
    const res = await uploadMedia(form(GIF_3X2, "image/gif", "tuin.gif"));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const [row] = await h.db.select().from(mediaAssets).where(eq(mediaAssets.id, res.data.mediaId));
    expect(row).toMatchObject({ width: 3, height: 2, isDecorative: false, source: "upload", alt: { en: "Sauna garden" } });
    const [file] = await h.db.select().from(files).where(eq(files.id, res.data.fileId));
    expect(file).toMatchObject({ kind: "image", mime: "image/gif", isPublic: true });
    const png = await uploadMedia(form(PNG_1X1, "image/png", "dot.png", { isDecorative: "true" }));
    expect(png.ok).toBe(true);
    const [audit] = await h.db.select().from(auditLog).where(eq(auditLog.action, "site.media.upload"));
    expect(audit).toBeTruthy();
  });

  it("refuses SVG, a type outside the allowed list, a renamed file and a file over 10 MB", async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
    expect(await uploadMedia(form(svg, "image/svg+xml", "logo.svg"))).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(await uploadMedia(form(PNG_1X1, "image/avif", "x.avif"))).toMatchObject({ ok: false, error: { code: "validation", fields: { file: "type_not_allowed" } } });
    expect(await uploadMedia(form(new TextEncoder().encode("not an image"), "image/png", "fake.png"))).toMatchObject({ ok: false, error: { code: "validation", fields: { file: "not_an_image" } } });
    expect(await uploadMedia(form(GIF_3X2, "image/png", "gif-as-png.png"))).toMatchObject({ ok: false, error: { code: "validation", fields: { file: "not_an_image" } } });
    const big = new Uint8Array(10_485_761);
    big.set(PNG_1X1);
    expect(await uploadMedia(form(big, "image/png", "big.png"))).toMatchObject({ ok: false, error: { code: "validation", fields: { file: "too_large" } } });
  });
});

describe("updateMedia and deleteMedia", () => {
  it("updates alt, decorative, caption and credit", async () => {
    const m = await makeMedia(h.db, {});
    expect(await updateMedia({ mediaId: m.id, alt: { en: "Pool" }, isDecorative: true, caption: { en: "The pool" }, credit: "Photo: BEAM" })).toMatchObject({ ok: true });
    const [row] = await h.db.select().from(mediaAssets).where(eq(mediaAssets.id, m.id));
    expect(row).toMatchObject({ alt: { en: "Pool" }, isDecorative: true, caption: { en: "The pool" }, credit: "Photo: BEAM" });
  });

  it("refuses to delete an image a draft uses, deletes it once unused", async () => {
    const m = await makeMedia(h.db);
    const [p] = await h.db.insert(pages).values({ kind: "standard", slug: slug("media") }).returning();
    const [draft] = await h.db
      .insert(pageVersions)
      .values({ pageId: p!.id, version: 1, state: "draft", locales: ["nl-BE"], blocks: { "nl-BE": [{ id: randomUUID(), type: "image", mediaId: m.id }] } })
      .returning();
    expect(await deleteMedia({ mediaId: m.id })).toMatchObject({ ok: false, error: { code: "conflict", message: "media_in_use" } });
    const usage = (await listMedia({}, h.db)).rows.find((r) => r.mediaId === m.id);
    expect(usage?.usage).toBe(1);
    await h.db.delete(pageVersions).where(eq(pageVersions.id, draft!.id));
    expect(await deleteMedia({ mediaId: m.id })).toMatchObject({ ok: true });
    expect(await h.db.select().from(mediaAssets).where(eq(mediaAssets.id, m.id))).toEqual([]);
    const [file] = await h.db.select().from(files).where(eq(files.id, m.fileId));
    expect(file?.expiresAt).toBeTruthy();
  });

  it("refuses to delete an image a published live version uses as cover", async () => {
    const m = await makeMedia(h.db);
    const [p] = await h.db.insert(pages).values({ kind: "standard", slug: slug("cover") }).returning();
    const [v] = await h.db.insert(pageVersions).values({ pageId: p!.id, version: 1, state: "published", publishedAt: new Date(), locales: ["nl-BE"], coverMediaId: m.id }).returning();
    await h.db.update(pages).set({ status: "published", currentVersionId: v!.id }).where(eq(pages.id, p!.id));
    expect(await deleteMedia({ mediaId: m.id })).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("is refused without site.edit", async () => {
    jar.clear();
    await staffSession(h.db, jar, []);
    expect(await uploadMedia(form(PNG_1X1, "image/png", "dot.png"))).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });
});
