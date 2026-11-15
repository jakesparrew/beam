import { describe, expect, it } from "vitest";
import { BlocksByLocale } from "@beam/core/site";
import { createTestDb } from "../testing";
import { pageVersions } from "../schema/site";
import { seedSiteContent, SITE_SEED_PAGES } from "./site";

describe("site seed content (beam.be rebuild)", () => {
  it("every seeded page's blocks pass the strict block schema in all three locales", async () => {
    const h = await createTestDb();
    try {
      await seedSiteContent(h.db);
      const rows = await h.db.select({ blocks: pageVersions.blocks }).from(pageVersions);
      expect(rows.length).toBe(SITE_SEED_PAGES.length);
      for (const row of rows) {
        const parsed = BlocksByLocale.safeParse(row.blocks);
        expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 3))).toBe(true);
      }
    } finally {
      await h.close();
    }
  });
});
