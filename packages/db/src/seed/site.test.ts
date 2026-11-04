/** site's `defaults` seed (site-P7): placeholder pages with one published version, routes, menus; nothing in production. */
import { and, eq, isNotNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BlocksByLocale } from "@beam/core/site";
import type { DbHandle } from "../client";
import { settings } from "../schema/platform";
import { navMenus, pageRoutes, pages, pageVersions } from "../schema/site";
import { createTestDb } from "../testing";
import { DEFAULT_SEEDS } from "./index.generated";
import { seedDefaults } from "./run";
import { seed, seedSiteContent, seedUuid, SITE_SEED_PAGES, siteContentSeedAllowed } from "./site";

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
});
afterAll(() => h.close());

/** The live version of a legal page (what `getCurrentLegalVersion` reads). */
async function liveLegal(key: "terms" | "guardian_consent") {
  const [row] = await h.db
    .select({ versionId: pageVersions.id, publishedAt: pageVersions.publishedAt })
    .from(pages)
    .innerJoin(pageVersions, eq(pageVersions.id, pages.currentVersionId))
    .where(and(eq(pages.legalKey, key), eq(pages.status, "published"), isNotNull(pageVersions.publishedAt)));
  return row ?? null;
}

describe("site defaults seed", () => {
  it("is registered after platform", () => {
    expect((DEFAULT_SEEDS as readonly { module: string }[]).map((s) => s.module)).toContain("site");
    expect(seed.after).toEqual(["platform"]);
  });

  it("seeding twice yields one published version per seeded page", async () => {
    await seedDefaults(h.db);
    await seedDefaults(h.db);
    const rows = await h.db.select().from(pages);
    expect(rows.map((r) => r.slug).sort()).toEqual(SITE_SEED_PAGES.map((p) => p.slug).sort());
    for (const p of rows) {
      const versions = await h.db.select().from(pageVersions).where(eq(pageVersions.pageId, p.id));
      expect(versions, p.slug).toHaveLength(1);
      expect(versions[0]).toMatchObject({ version: 1, state: "published", createdBy: "user", locales: ["nl-BE", "fr-BE", "en"] });
      expect(p).toMatchObject({ status: "published", currentVersionId: versions[0]!.id });
      expect(BlocksByLocale.safeParse(versions[0]!.blocks).success, p.slug).toBe(true);
      expect(await h.db.select().from(pageRoutes).where(eq(pageRoutes.pageId, p.id))).toHaveLength(3);
    }
    expect(await seedSiteContent(h.db)).toEqual([]);
  });

  it("the terms and guardian consent pages are live", async () => {
    expect(await liveLegal("terms")).not.toBeNull();
    expect(await liveLegal("guardian_consent")).not.toBeNull();
    const [terms] = await h.db.select().from(pageVersions).innerJoin(pages, eq(pages.id, pageVersions.pageId)).where(eq(pages.slug, "terms"));
    const nl = JSON.stringify(terms!.page_versions.blocks["nl-BE"]);
    for (const chapter of ["Huisregels", "Gezondheidsverklaring", "Annuleringsbeleid", "VI.53", "Voorwaarden lidmaatschap"]) expect(nl).toContain(chapter);
    const [privacy] = await h.db.select().from(pageVersions).innerJoin(pages, eq(pages.id, pageVersions.pageId)).where(eq(pages.slug, "privacy"));
    for (const l of ["nl-BE", "fr-BE", "en"] as const) expect(JSON.stringify(privacy!.page_versions.blocks[l])).toContain("Vibrant Lifestyle Collective BV");
  });

  it("seeds the three menus and the site settings once", async () => {
    const menus = await h.db.select().from(navMenus);
    expect(menus.map((m) => m.key).sort()).toEqual(["footer", "header", "legal"]);
    expect(menus.find((m) => m.key === "legal")!.items).toHaveLength(5);
    expect(await h.db.select().from(settings).where(eq(settings.key, "site"))).toHaveLength(1);
    expect(seedUuid("x")).toBe(seedUuid("x"));
    expect(seedUuid("x")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("the production profile seeds nothing", async () => {
    expect(siteContentSeedAllowed({ APP_ENV: "production" })).toBe(false);
    expect(siteContentSeedAllowed({ APP_ENV: "staging" })).toBe(false);
    expect(siteContentSeedAllowed({ APP_ENV: "preview" })).toBe(true);
    const prod = await createTestDb();
    const before = process.env.APP_ENV;
    process.env.APP_ENV = "production";
    try {
      await prod.db.transaction((tx) => seed.run(tx, {}));
      expect(await prod.db.select().from(pages)).toEqual([]);
      expect(await prod.db.select().from(navMenus)).toEqual([]);
      expect(await prod.db.select().from(settings).where(eq(settings.key, "site"))).toEqual([]);
    } finally {
      if (before === undefined) delete process.env.APP_ENV;
      else process.env.APP_ENV = before;
      await prod.close();
    }
  });
});
