/**
 * site's demo seed (runbook 6.3, site spec section 8; site-P7), run by
 * `apps/web/scripts/seed-demo.ts` in `after` order. Facade read by `pnpm gen:indexes`. The
 * placeholder pages, menus and settings come from the `defaults` profile
 * (`packages/db/src/seed/site.ts`); the demo adds one published blog post. Idempotent.
 */
import { seedSiteDemo } from "@beam/db/seed/site";
import type { SeedCtx } from "@/scripts/seed-demo";

export const seed = {
  after: ["crm"],
  run: async (s: SeedCtx): Promise<void> => {
    await seedSiteDemo(s.db, { now: s.now });
  },
};
