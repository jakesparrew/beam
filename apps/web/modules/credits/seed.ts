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
import { creditGrants, memberships, packageShares, persons, products, users } from "@beam/db/schema";
import { BEAM_SKUS, DEMO_SKUS } from "@beam/db/seed/commerce";
import { and, asc, eq, inArray } from "@/lib/ctx";
import type { SeedCtx } from "@/scripts/seed-demo";
import { grantCredits, importGrant } from "./server/ledger";
import { importMembership } from "./server/memberships";
import { addShare } from "./server/sharing";

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

/** Packages taken over from the previous booking tool, expiring soon (`grant:demo:legacy:<key>`). */
export const DEMO_LEGACY_GRANTS: readonly { person: string; units: number; originalUnits: number; expiresInDays: number; legacyId: string }[] = [
  { person: "platform.person.customer5", units: 2, originalUnits: 5, expiresInDays: 12, legacyId: "SB-10412" },
  { person: "crm.customer.eline-wouters", units: 3, originalUnits: 10, expiresInDays: 20, legacyId: "SB-09877" },
];

/** A yearly membership taken over from the previous tool whose period ends within two weeks (no mandate). */
export const DEMO_LEGACY_MEMBERSHIP = { person: "crm.customer.geert-lemmens", endsInDays: 9 } as const;

/**
 * The booking demo's credit side: Lotte (`customer1`) shares her 20-hour package with Jonas
 * (`customer2`, at most 4 sessions) through the staff sharing path, the legacy packages of
 * `DEMO_LEGACY_GRANTS` through `importGrant`, and `DEMO_LEGACY_MEMBERSHIP` through
 * `importMembership`. Idempotent: an active share, an existing key or any membership of the
 * person is left alone. Needs a staff user for the share (skipped without one).
 */
export async function runCreditsDemoActivitySeed(s: Pick<SeedCtx, "db" | "ctx" | "now" | "ids">): Promise<{ created: number; skipped: number }> {
  const tx = s.db as Tx;
  let created = 0;
  let skipped = 0;
  const DAY_MS = 86_400_000;
  const productId = async (sku: string) => (await tx.select({ id: products.id }).from(products).where(eq(products.sku, sku)))[0]?.id;

  const owner = s.ids.get("platform.person.customer1");
  const friend = s.ids.get("platform.person.customer2");
  const staff =
    s.ids.get("platform.user.owner") ??
    (await tx.select({ id: users.id }).from(users).where(and(eq(users.audience, "staff"), eq(users.status, "active"))).orderBy(asc(users.createdAt)).limit(1))[0]?.id;
  const hours20 = await productId(BEAM_SKUS.hours20);
  const [grant] =
    owner && hours20
      ? await tx
          .select({ id: creditGrants.id })
          .from(creditGrants)
          .where(and(eq(creditGrants.personId, owner), eq(creditGrants.productId, hours20), eq(creditGrants.source, "purchase"), eq(creditGrants.status, "active")))
          .limit(1)
      : [];
  const [invitee] = friend ? await tx.select({ email: persons.email, firstName: persons.firstName }).from(persons).where(eq(persons.id, friend)) : [];
  const [shared] =
    grant && friend ? await tx.select({ id: packageShares.id }).from(packageShares).where(and(eq(packageShares.grantId, grant.id), eq(packageShares.sharedWithPersonId, friend), eq(packageShares.status, "active"))) : [];
  if (grant && staff && invitee?.email && !shared) {
    await addShare(tx, s.ctx, { grantId: grant.id, email: invitee.email, firstName: invitee.firstName ?? "Jonas", maxUnits: 4 }, { kind: "staff", userId: staff });
    created++;
  } else skipped++;

  const pkg5 = await productId(DEMO_SKUS.package5Days);
  for (const g of DEMO_LEGACY_GRANTS) {
    const personId = s.ids.get(g.person);
    if (!personId) {
      skipped++;
      continue;
    }
    const r = await importGrant(tx, s.ctx, {
      personId,
      productId: pkg5 ?? null,
      creditKind: "day",
      units: g.units,
      originalUnits: g.originalUnits,
      unitValueCents: 4_000,
      legacyId: g.legacyId,
      expiresAt: new Date(s.now.getTime() + g.expiresInDays * DAY_MS + 12 * 3_600_000),
      idempotencyKey: `demo:legacy:${g.person}`,
    });
    if (r.created) created++;
    else skipped++;
  }

  const memberId = s.ids.get(DEMO_LEGACY_MEMBERSHIP.person);
  const yearly = await productId(BEAM_SKUS.membershipYear);
  const [member] = memberId ? await tx.select({ id: memberships.id }).from(memberships).where(and(eq(memberships.personId, memberId), inArray(memberships.status, ["active", "past_due", "pending"]))).limit(1) : [];
  if (memberId && yearly && !member) {
    const periodEndAt = new Date(s.now.getTime() + DEMO_LEGACY_MEMBERSHIP.endsInDays * DAY_MS + 12 * 3_600_000);
    await importMembership(tx, s.ctx, { personId: memberId, productId: yearly, periodEndAt, idempotencyKey: `demo:legacy:${DEMO_LEGACY_MEMBERSHIP.person}` });
    created++;
  } else skipped++;
  return { created, skipped };
}

export const seed = {
  after: ["commerce"],
  run: async (s: SeedCtx) => {
    const a = await runCreditsDemoSeed(s);
    const b = await runCreditsDemoActivitySeed(s);
    return { created: a.created + b.created, skipped: a.skipped + b.skipped };
  },
};
