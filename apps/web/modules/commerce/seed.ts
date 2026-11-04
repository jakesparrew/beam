/**
 * commerce's demo seed (runbook 6.3), run by `apps/web/scripts/seed-demo.ts` in `after` order. Facade
 * read by `pnpm gen:indexes`.
 *
 * commerce-P3 seeds the catalogue of runbook 6.3 through `seedCommerceCatalogue` from
 * `@beam/db/seed/commerce`: nine products with their price versions (the 10-day package has two,
 * €360 until 1 October and €380 since) and the promotions `WELKOM10` and the automatic December
 * offer on the 2-night package, authored by the demo owner (or the first staff user). Ids are
 * recorded as `commerce.product.<sku>` and `commerce.promotion.<code>`. The paid orders, the
 * expired order, the abandoned checkout and the refund of runbook 6.3 need `createOrder` and the
 * paid transaction, so the order packages (commerce-P4a onwards) add them here.
 */
import { users } from "@beam/db/schema";
import { seedCommerceCatalogue } from "@beam/db/seed/commerce";
import { and, asc, eq } from "@/lib/ctx";
import type { SeedCtx } from "@/scripts/seed-demo";

async function staffAuthor(s: SeedCtx): Promise<string | null> {
  const owner = s.ids.get("platform.user.owner");
  if (owner) return owner;
  const [row] = await s.db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.audience, "staff"), eq(users.status, "active")))
    .orderBy(asc(users.createdAt))
    .limit(1);
  return row?.id ?? null;
}

export const seed = {
  after: ["forms"],
  run: async (s: SeedCtx): Promise<void> => {
    const result = await seedCommerceCatalogue(s.db, { now: s.now, staffUserId: await staffAuthor(s) });
    for (const [sku, id] of Object.entries(result.productIds)) s.ids.set(`commerce.product.${sku}`, id);
    for (const [code, id] of Object.entries(result.promotionIds)) s.ids.set(`commerce.promotion.${code}`, id);
  },
};
