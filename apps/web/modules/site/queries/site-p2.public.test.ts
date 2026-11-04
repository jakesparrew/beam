import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { navMenus, pageRoutes, pages, pageVersions } from "@beam/db/schema";
import type { Locale } from "@beam/core/i18n";
import type { PageKind } from "@beam/core/site";
import { eq } from "@/lib/ctx";
import { resetRuntime } from "@/lib/testing";

vi.mock("next/cache", () => ({ unstable_cache: (fn: (...a: unknown[]) => unknown) => fn }));

const { setAppDb } = await import("@/lib/ctx");
const { getNavMenus, listPosts, getPageAlternates } = await import("./public");

let handle: DbHandle;
beforeAll(async () => {
  handle = await createTestDb();
  setAppDb(handle.db);
});
afterAll(async () => {
  resetRuntime();
  await handle.close();
});

async function livePage(kind: PageKind, paths: Partial<Record<Locale, string>>, firstPublishedAt = new Date()): Promise<string> {
  const [p] = await handle.db.insert(pages).values({ kind, slug: `p-${randomUUID().slice(0, 8)}` }).returning();
  const locales = Object.keys(paths) as Locale[];
  const [v] = await handle.db
    .insert(pageVersions)
    .values({ pageId: p!.id, version: 1, state: "published", publishedAt: firstPublishedAt, title: Object.fromEntries(locales.map((l) => [l, `T ${paths[l]}`])), paths, locales, excerpt: { en: "Excerpt" } })
    .returning();
  await handle.db.update(pages).set({ status: "published", currentVersionId: v!.id, firstPublishedAt }).where(eq(pages.id, p!.id));
  for (const l of locales) await handle.db.insert(pageRoutes).values({ pageId: p!.id, locale: l, path: paths[l]!, versionId: v!.id });
  return p!.id;
}

describe("getNavMenus", () => {
  it("resolves page, url and portal targets and hides items whose page is not live in the locale (rule 24)", async () => {
    const both = await livePage("offer", { "nl-BE": "dagsessies", en: "day-sessions" });
    const nlOnly = await livePage("offer", { "nl-BE": "nachten" });
    await handle.db.insert(navMenus).values({
      key: "header",
      items: [
        { id: "a", label: { "nl-BE": "Dag", "fr-BE": "Jour", en: "Day" }, target: { kind: "page", pageId: both }, children: [{ id: "a1", label: { "nl-BE": "Nacht", "fr-BE": "Nuit", en: "Night" }, target: { kind: "page", pageId: nlOnly } }] },
        { id: "b", label: { "nl-BE": "Boek", "fr-BE": "Réserver", en: "Book" }, target: { kind: "portal", route: "book_day" } },
        { id: "c", label: { "nl-BE": "Partner", "fr-BE": "Partenaire", en: "Partner" }, target: { kind: "url", href: "https://partner.example.com" } },
        { id: "d", label: { "nl-BE": "Weg", "fr-BE": "Parti", en: "Gone" }, target: { kind: "page", pageId: randomUUID() } },
      ],
    });
    const nl = await getNavMenus("nl-BE");
    expect(nl.header.map((i) => [i.id, i.href])).toEqual([
      ["a", "/nl/dagsessies"],
      ["b", "/nl/account/book?kind=day"],
      ["c", "https://partner.example.com"],
    ]);
    expect(nl.header[0]!.children.map((c) => c.href)).toEqual(["/nl/nachten"]);
    expect(nl.header[2]!.external).toBe(true);
    const en = await getNavMenus("en");
    expect(en.header[0]).toMatchObject({ label: "Day", href: "/en/day-sessions", children: [] });
    expect(en.footer).toEqual([]);
  });
});

describe("listPosts and alternates", () => {
  it("lists posts of the locale newest first with paging", async () => {
    const old = await livePage("post", { en: "blog/old" }, new Date("2026-01-01T00:00:00Z"));
    const recent = await livePage("post", { en: "blog/new", "nl-BE": "blog/nieuw" }, new Date("2026-02-01T00:00:00Z"));
    const page1 = await listPosts("en", { page: 1, limit: 1 });
    expect(page1.items.map((p) => p.pageId)).toEqual([recent]);
    expect(page1.hasMore).toBe(true);
    const page2 = await listPosts("en", { page: 2, limit: 1 });
    expect(page2.items.map((p) => [p.pageId, p.href, p.excerpt])).toEqual([[old, "/en/blog/old", "Excerpt"]]);
    expect(page2.hasMore).toBe(false);
    expect((await listPosts("nl-BE", { page: 1, limit: 10 })).items.map((p) => p.pageId)).toEqual([recent]);
    expect(await getPageAlternates(recent)).toMatchObject({ routes: { en: "blog/new", "nl-BE": "blog/nieuw" } });
  });
});
