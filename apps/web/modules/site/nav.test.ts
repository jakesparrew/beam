/**
 * site-P3 navigation menus (site spec section 4 `updateNavMenu`, rule 24, section 8): labels must
 * be complete in all three locales, the optimistic version lock refuses stale saves, and items
 * pointing at pages hidden in a locale are reported (and listed as content issues).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { auditLog, navMenus, pageRoutes, pages, pageVersions } from "@beam/db/schema";
import { createTestDb } from "@beam/db/testing";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.42" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));
vi.mock("next/cache", () => ({ revalidateTag: () => undefined, unstable_cache: (fn: (...a: unknown[]) => unknown) => fn }));

const { updateNavMenu } = await import("./actions/nav");
const { eq, setAppDb } = await import("@/lib/ctx");
const { resetRuntime } = await import("@/lib/testing");
const { getContentIssues, listNavMenusForAdmin } = await import("./queries/admin");
const { slug, staffSession } = await import("./site-p3.fixtures");

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
  await staffSession(h.db, jar, ["site.edit", "site.publish"]);
});

const label = (t: string) => ({ "nl-BE": `${t} nl`, "fr-BE": `${t} fr`, en: `${t} en` });

/** A published page live only in `locales`. */
async function livePage(locales: ("nl-BE" | "fr-BE" | "en")[]) {
  const [p] = await h.db.insert(pages).values({ kind: "standard", slug: slug("nav") }).returning();
  const paths = Object.fromEntries(locales.map((l) => [l, `nav-${p!.id.slice(0, 8)}`]));
  const [v] = await h.db.insert(pageVersions).values({ pageId: p!.id, version: 1, state: "published", publishedAt: new Date(), locales, paths }).returning();
  await h.db.update(pages).set({ status: "published", currentVersionId: v!.id }).where(eq(pages.id, p!.id));
  for (const l of locales) await h.db.insert(pageRoutes).values({ pageId: p!.id, locale: l, path: paths[l]!, versionId: v!.id });
  return p!.id;
}

describe("updateNavMenu", () => {
  it("refuses a label missing a locale (completeness of every item and sub-item)", async () => {
    const items = [{ id: "a", label: { "nl-BE": "Over ons", en: "About" }, target: { kind: "url", href: "/nl/over-ons" } }];
    const res = await updateNavMenu({ key: "footer", items, expectedVersion: 0 });
    expect(res).toMatchObject({ ok: false, error: { code: "validation", fields: { "items.0.label": "missing fr-BE" } } });
    const child = [{ id: "b", label: label("Top"), target: { kind: "portal", route: "home" }, children: [{ id: "c", label: { en: "Only en" }, target: { kind: "portal", route: "shop" } }] }];
    expect(await updateNavMenu({ key: "footer", items: child, expectedVersion: 0 })).toMatchObject({ ok: false, error: { code: "validation", fields: { "items.0.children.0.label": "missing nl-BE, fr-BE" } } });
    expect(await h.db.select().from(navMenus).where(eq(navMenus.key, "footer"))).toEqual([]);
  });

  it("refuses more than 8 top-level items and a third level", async () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ id: `i${i}`, label: label(`I${i}`), target: { kind: "portal", route: "home" } }));
    expect(await updateNavMenu({ key: "legal", items: many, expectedVersion: 0 })).toMatchObject({ ok: false, error: { code: "validation" } });
    const deep = [{ id: "x", label: label("X"), target: { kind: "portal", route: "home" }, children: [{ id: "y", label: label("Y"), target: { kind: "portal", route: "home" }, children: [] }] }];
    expect(await updateNavMenu({ key: "legal", items: deep, expectedVersion: 0 })).toMatchObject({ ok: false, error: { code: "validation" } });
  });

  it("saves under a version lock and refuses a stale expectedVersion", async () => {
    const items = [{ id: randomUUID(), label: label("Prijzen"), target: { kind: "portal", route: "shop" } }];
    const first = await updateNavMenu({ key: "header", items, expectedVersion: 0 });
    expect(first).toMatchObject({ ok: true, data: { version: 1 } });
    const second = await updateNavMenu({ key: "header", items: [], expectedVersion: 1 });
    expect(second).toMatchObject({ ok: true, data: { version: 2 } });
    expect(await updateNavMenu({ key: "header", items, expectedVersion: 1 })).toMatchObject({ ok: false, error: { code: "conflict", message: "menu_changed" } });
    const [row] = await h.db.select().from(navMenus).where(eq(navMenus.key, "header"));
    expect(row).toMatchObject({ version: 2, items: [] });
    const audits = await h.db.select().from(auditLog).where(eq(auditLog.action, "site.nav.update"));
    expect(audits.length).toBeGreaterThanOrEqual(2);
  });

  it("reports items whose target page is hidden in a locale, and lists them as content issues", async () => {
    const nlOnly = await livePage(["nl-BE"]);
    const [draft] = await h.db.insert(pages).values({ kind: "standard", slug: slug("draft") }).returning();
    const items = [
      { id: "nl-only", label: label("Nl"), target: { kind: "page", pageId: nlOnly } },
      { id: "unpublished", label: label("Draft"), target: { kind: "page", pageId: draft!.id } },
    ];
    const [existing] = await h.db.select().from(navMenus).where(eq(navMenus.key, "legal"));
    const res = await updateNavMenu({ key: "legal", items, expectedVersion: existing?.version ?? 0 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.hidden.map((x) => `${x.itemId}:${x.locale}`).sort()).toEqual(["nl-only:en", "nl-only:fr-BE", "unpublished:en", "unpublished:fr-BE", "unpublished:nl-BE"]);
    const issues = (await getContentIssues(h.db)).filter((i) => i.code === "nav_target_hidden");
    expect(issues.map((i) => `${i.details?.[1]}:${i.locale}`).sort()).toEqual(expect.arrayContaining(["nl-only:en", "unpublished:nl-BE"]));
    const menus = await listNavMenusForAdmin(h.db);
    expect(menus.find((m) => m.key === "legal")!.hidden).toHaveLength(5);
  });

  it("is refused without site.publish", async () => {
    jar.clear();
    await staffSession(h.db, jar, ["site.edit"]);
    expect(await updateNavMenu({ key: "header", items: [], expectedVersion: 2 })).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });
});
