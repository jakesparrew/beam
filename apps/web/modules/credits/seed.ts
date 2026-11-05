/**
 * credits's demo seed (runbook 6.3), run by `apps/web/scripts/seed-demo.ts` in `after` order. Facade
 * read by `pnpm gen:indexes`.
 *
 * ops-P10 request: the purchase grants of crm's non-tester demo customers come from commerce's
 * paid demo orders (the paid transaction calls `grantCredits`); this seed records the
 * 10-session package of `crm.customer.an-verbruggen` as `credits.grant.package10.an-verbruggen`
 * and gives `crm.customer.sarah-lenaerts` (acquired by referral) one bonus day as a thank-you, so
 * the credit reports show a purchase and a bonus grant. Idempotent: grants are keyed
 * (`grant:demo:<slug>:bonus`), and a rerun returns the existing grant.
 */
import type { Tx } from "@beam/db";
import { creditGrants, products } from "@beam/db/schema";
import { DEMO_SKUS } from "@beam/db/seed/commerce";
import { and, eq } from "@/lib/ctx";
import type { SeedCtx } from "@/scripts/seed-demo";
import { grantCredits } from "./server/ledger";

const DAY = 86_400_000;

export const DEMO_BONUS = {
  customer: "sarah-lenaerts",
  units: 1,
  validityDays: 180,
  label: { "nl-BE": "Bedankt voor je doorverwijzing", "fr-BE": "Merci pour votre parrainage", en: "Thank you for your referral" },
  reason: "Demo: referral thank-you",
} as const;

export async function runCreditsDemoSeed(s: Pick<SeedCtx, "db" | "ctx" | "now" | "ids">): Promise<{ created: number; skipped: number }> {
  let created = 0;
  let skipped = 0;
  const tx = s.db as Tx;

  const buyer = s.ids.get("crm.customer.an-verbruggen");
  const [pkg] = await tx.select({ id: products.id }).from(products).where(eq(products.sku, DEMO_SKUS.package10Days));
  const [grant] =
    buyer && pkg
      ? await tx
          .select({ id: creditGrants.id })
          .from(creditGrants)
          .where(and(eq(creditGrants.personId, buyer), eq(creditGrants.productId, pkg.id), eq(creditGrants.source, "purchase")))
          .limit(1)
      : [];
  if (grant) s.ids.set("credits.grant.package10.an-verbruggen", grant.id);

  const personId = s.ids.get(`crm.customer.${DEMO_BONUS.customer}`);
  if (!personId) return { created, skipped: skipped + 1 };
  const startsAt = new Date(s.now.getTime() - 10 * DAY);
  const r = await grantCredits(tx, s.ctx, {
    personId,
    kind: "day",
    units: DEMO_BONUS.units,
    source: "bonus",
    label: { ...DEMO_BONUS.label },
    reason: DEMO_BONUS.reason,
    startsAt,
    expiresAt: new Date(startsAt.getTime() + DEMO_BONUS.validityDays * DAY),
    key: `grant:demo:${DEMO_BONUS.customer}:bonus`,
  });
  if (r.created) created++;
  else skipped++;
  s.ids.set(`credits.grant.bonus.${DEMO_BONUS.customer}`, r.grantId);
  return { created, skipped };
}

export const seed = { after: ["commerce"], run: (s: SeedCtx) => runCreditsDemoSeed(s) };
