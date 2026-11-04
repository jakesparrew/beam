/**
 * site-P3 redirects (site spec section 4 `upsertRedirect`/`deleteRedirect`, section 2, edge case 6):
 * `from_path` normalisation, refusal of a path a live page uses, and refusal of loops.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { auditLog, pageRoutes, pages, pageVersions, redirects } from "@beam/db/schema";
import { createTestDb } from "@beam/db/testing";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.43" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));
vi.mock("next/cache", () => ({ revalidateTag: () => undefined, unstable_cache: (fn: (...a: unknown[]) => unknown) => fn }));

const { deleteRedirect, upsertRedirect } = await import("./actions/redirects");
const { eq, setAppDb } = await import("@/lib/ctx");
const { resetRuntime } = await import("@/lib/testing");
const { listRedirects } = await import("./queries/admin");
const { slug, staffSession } = await import("./site-p3.fixtures");

let h: DbHandle;
let pageId: string;
beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
  const [p] = await h.db.insert(pages).values({ kind: "standard", slug: slug("live") }).returning();
  const [v] = await h.db.insert(pageVersions).values({ pageId: p!.id, version: 1, state: "published", publishedAt: new Date(), locales: ["nl-BE"], paths: { "nl-BE": "dagsessies" } }).returning();
  await h.db.update(pages).set({ status: "published", currentVersionId: v!.id }).where(eq(pages.id, p!.id));
  await h.db.insert(pageRoutes).values({ pageId: p!.id, locale: "nl-BE", path: "dagsessies", versionId: v!.id });
  pageId = p!.id;
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  jar.clear();
  await staffSession(h.db, jar, ["site.edit", "site.publish"]);
});

describe("upsertRedirect", () => {
  it("normalises the from path (case, trailing slash, query except p and page_id)", async () => {
    const res = await upsertRedirect({ fromPath: "/NL/Over-Ons/?utm_source=x", to: { pageId, locale: "nl-BE" }, isPermanent: true });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const [row] = await h.db.select().from(redirects).where(eq(redirects.id, res.data.id));
    expect(row).toMatchObject({ fromPath: "/nl/over-ons", toPageId: pageId, toLocale: "nl-BE", toUrl: null, source: "manual", isPermanent: true });
    const wp = await upsertRedirect({ fromPath: "/?p=123&foo=1", to: { url: "/nl/dagsessies" }, isPermanent: false });
    expect(wp.ok).toBe(true);
    expect((await h.db.select().from(redirects).where(eq(redirects.fromPath, "/?p=123"))).length).toBe(1);
    const [audit] = await h.db.select().from(auditLog).where(eq(auditLog.action, "site.redirect.upsert"));
    expect(audit).toBeTruthy();
  });

  it("refuses a path a live page uses (conflict) and the reserved prefixes (validation)", async () => {
    expect(await upsertRedirect({ fromPath: "/nl/dagsessies/", to: { url: "/nl/elders" }, isPermanent: true })).toMatchObject({ ok: false, error: { code: "conflict", message: "live_path" } });
    expect(await upsertRedirect({ fromPath: "/admin/site", to: { url: "/nl" }, isPermanent: true })).toMatchObject({ ok: false, error: { code: "validation" } });
  });

  it("refuses a redirect to itself and one that closes a loop", async () => {
    expect(await upsertRedirect({ fromPath: "/nl/a", to: { url: "/nl/a/" }, isPermanent: true })).toMatchObject({ ok: false, error: { code: "validation", fields: { to: "loop" } } });
    expect((await upsertRedirect({ fromPath: "/nl/b", to: { url: "/nl/c" }, isPermanent: true })).ok).toBe(true);
    expect((await upsertRedirect({ fromPath: "/nl/c", to: { url: "/nl/d" }, isPermanent: true })).ok).toBe(true);
    expect(await upsertRedirect({ fromPath: "/nl/d", to: { url: "/nl/b" }, isPermanent: true })).toMatchObject({ ok: false, error: { code: "validation", fields: { to: "loop" } } });
    expect(await upsertRedirect({ fromPath: "/nl/e", to: { url: "javascript:alert(1)" }, isPermanent: true })).toMatchObject({ ok: false, error: { code: "validation" } });
  });

  it("refuses a duplicate from path, edits an existing redirect and deletes it", async () => {
    const first = await upsertRedirect({ fromPath: "/nl/promo", to: { url: "https://partner.example.com/beam" }, isPermanent: false });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(await upsertRedirect({ fromPath: "/nl/promo", to: { url: "/nl" }, isPermanent: true })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect((await upsertRedirect({ id: first.data.id, fromPath: "/nl/promo", to: { pageId, locale: "nl-BE" }, isPermanent: true })).ok).toBe(true);
    const listed = await listRedirects({ q: "promo" }, "nl-BE", h.db);
    expect(listed.rows).toEqual([expect.objectContaining({ fromPath: "/nl/promo", toPageId: pageId, toUrl: null })]);
    expect(await deleteRedirect({ id: first.data.id })).toMatchObject({ ok: true });
    expect(await deleteRedirect({ id: first.data.id })).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("is refused without site.publish", async () => {
    jar.clear();
    await staffSession(h.db, jar, ["site.edit"]);
    expect(await upsertRedirect({ fromPath: "/nl/x", to: { url: "/nl" }, isPermanent: true })).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });
});
