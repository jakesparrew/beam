/**
 * site-P7 seeds seen from the app: after the `defaults` seed `getCurrentLegalVersion` finds the
 * terms and the guardian consent, the seeded pages pass the publish checks, and the demo seed adds
 * one blog post, twice without duplicates.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { pages, pageVersions } from "@beam/db/schema";
import { createTestDb } from "@beam/db/testing";
import { seedDefaults } from "@beam/db/seed";
import { DEMO_POST_SLUG } from "@beam/db/seed/site";

vi.mock("next/cache", () => ({ revalidateTag: () => undefined, unstable_cache: (fn: (...a: unknown[]) => unknown) => fn }));
vi.mock("next/server", () => ({ after: () => undefined }));

const { eq, setAppDb } = await import("@/lib/ctx");
const { makeCtx, resetRuntime } = await import("@/lib/testing");
const { getCurrentLegalVersion } = await import("../server/legal");
const { checkVersion } = await import("../server/refs");
const { seed } = await import("../seed");

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
  await seedDefaults(h.db);
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

describe("site seed content", () => {
  it("makes the terms and the guardian consent current legal versions", async () => {
    const terms = await getCurrentLegalVersion(h.db, "terms");
    expect(terms).toMatchObject({ version: 1, requiresReacceptance: false });
    expect(terms!.text["en"]).toContain("House rules");
    expect(terms!.urlByLocale["nl-BE"]).toMatch(/\/nl\/voorwaarden$/);
    expect(await getCurrentLegalVersion(h.db, "guardian_consent")).not.toBeNull();
  });

  it("seeds pages that pass the publish checks", async () => {
    const rows = await h.db.select({ page: pages, version: pageVersions }).from(pages).innerJoin(pageVersions, eq(pageVersions.id, pages.currentVersionId));
    expect(rows.length).toBe(14);
    for (const { page, version } of rows) {
      const issues = await checkVersion(h.db, page, version);
      expect(issues, page.slug).toEqual([]);
    }
  });

  it("the demo seed adds one blog post, twice without duplicates", async () => {
    const s = { db: h.db, ctx: makeCtx(h.db), now: new Date(), rand: () => 0.5, ids: new Map<string, string>() };
    await seed.run(s as never);
    await seed.run(s as never);
    const posts = await h.db.select().from(pages).where(eq(pages.slug, DEMO_POST_SLUG));
    expect(posts).toEqual([expect.objectContaining({ kind: "post", status: "published" })]);
    expect(await h.db.select().from(pageVersions).where(eq(pageVersions.pageId, posts[0]!.id))).toHaveLength(1);
    const [v] = await h.db.select().from(pageVersions).where(eq(pageVersions.pageId, posts[0]!.id));
    expect(await checkVersion(h.db, posts[0]!, v!)).toEqual([]);
  });
});
