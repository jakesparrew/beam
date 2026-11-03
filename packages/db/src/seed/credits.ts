/**
 * credits seeds (credits-P1, credits spec 12 and rule 6a).
 *
 * - `seed` (the `defaults` profile, also run in production): the `settings` row `credits` with the
 *   rule 6a defaults and the module's `retention_policies` rows, both `on conflict (key) do
 *   nothing`. The retention rows are written only once ops has created `retention_policies`.
 * - `seedCreditsDemo` (the `demo` profile helper): the credits rows of the demo dataset, for the
 *   persons, products and order lines the other demo seeds created. credits' demo seed
 *   (`apps/web/modules/credits/seed.ts`) calls it; it never runs in the `defaults` profile.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { DbOrTx } from "../client";
import { products } from "../schema/commerce";
import {
  creditEntries,
  creditGrants,
  membershipPeriods,
  membershipPlanBenefits,
  memberships,
} from "../schema/credits";
import { settings } from "../schema/platform";
import type { LocalizedText } from "../schema/_shared";
import type { DefaultSeed } from "./run";

/** Rule 6a defaults; identical to the `credits` default in `apps/web/modules/credits/config.ts`. */
export const CREDITS_SETTINGS_DEFAULT = {
  threshold_pcts: [50, 75, 80, 90],
  expiry_warning_days: [30, 7],
  max_named_shares_per_grant: 5,
  max_extension_years: 5,
  reinstate_window_days: 365,
  renewal_charge_lead_days: 3,
  renewal_link_lead_days: 7,
  dunning_retry_days: [3, 7],
  dunning_expire_day: 10,
  yearly_reminder_days: [30, 7],
  monthly_reminder_days: [7],
  failed_renewals_alert_per_day: 3,
} as const;

/** The module's retention policies (spec section 9, cross-module D34 and D37). */
export const CREDITS_RETENTION_POLICIES = [
  {
    key: "credits.ledger",
    tableName: "credit_grants",
    days: 3653,
    action: "delete",
    description: "Closed grants and their ledger entries, 10 years after their last status change",
  },
  {
    key: "credits.memberships",
    tableName: "memberships",
    days: 3653,
    action: "delete",
    description: "Ended memberships and their periods, 10 years after they ended",
  },
  {
    key: "credits.sharing_reviews",
    tableName: "credit_sharing_reviews",
    days: 730,
    action: "delete",
    description: "Package sharing reviews after 2 years",
  },
  {
    key: "credits.reconciliation_runs",
    tableName: "credit_reconciliation_runs",
    days: 365,
    action: "delete",
    description: "Nightly ledger reconciliation runs after 1 year",
  },
] as const;

const rowsOf = <T>(result: unknown): T[] =>
  Array.isArray(result) ? (result as T[]) : ((result as { rows?: T[] }).rows ?? []);

async function tableExists(db: DbOrTx, name: string): Promise<boolean> {
  const rows = rowsOf<{ t: string | null }>(await db.execute(sql`select to_regclass(${`public.${name}`})::text as t`));
  return rows[0]?.t != null;
}

/** Inserts the `credits` setting and the retention policies; idempotent. */
export async function seedCreditsDefaults(db: DbOrTx): Promise<void> {
  await db
    .insert(settings)
    .values({ key: "credits", value: CREDITS_SETTINGS_DEFAULT })
    .onConflictDoNothing({ target: settings.key });
  if (!(await tableExists(db, "retention_policies"))) return;
  for (const p of CREDITS_RETENTION_POLICIES) {
    await db.execute(sql`insert into retention_policies (key, table_name, days, action, description)
      values (${p.key}, ${p.tableName}, ${p.days}, ${p.action}, ${p.description})
      on conflict (key) do nothing`);
  }
}

export const seed: DefaultSeed = {
  after: ["platform", "ops"],
  run: (db) => seedCreditsDefaults(db),
};

// ---------------------------------------------------------------------------
// Demo rows
// ---------------------------------------------------------------------------

export type CreditsDemoInput = {
  /** Start of the Brussels day the demo is seeded on. */
  now: Date;
  /** A 10-day package customer (Jonas Claes): 10 units, 7 used, expires in 10 days. */
  packageCustomer: { personId: string; productId: string; orderLineId: string };
  /** One order line of quantity 3: three grants, line unit index 1..3 (Camille Dubois). */
  threeUnitLine: { personId: string; productId: string; orderLineId: string; units: number; unitValueCents: number };
  /** A redeemed gift voucher: one euro grant owned by the redeemer. */
  voucher: { personId: string; orderLineId: string; voucherId: string; amountCents: number };
  /** The monthly plan with its benefits; the member (Lotte Peeters) and the past-due member (Hanne Wouters). */
  plan: { productId: string; nextPlanProductId: string };
  memberPersonId: string;
  pastDuePersonId: string;
};

const DAY = 24 * 60 * 60 * 1000;
const system = { kind: "system" as const, id: null };

const BENEFITS: { kind: (typeof membershipPlanBenefits.$inferInsert)["kind"]; text: LocalizedText }[] = [
  {
    kind: "included_units",
    text: { "nl-BE": "4 dagsessies per maand inbegrepen", "fr-BE": "4 séances de jour incluses par mois", en: "4 day sessions included every month" },
  },
  {
    kind: "discount",
    text: { "nl-BE": "10 % korting op extra sessies en nachten", "fr-BE": "10 % de réduction sur les séances et nuits supplémentaires", en: "10% off extra sessions and nights" },
  },
  {
    kind: "member_only_access",
    text: { "nl-BE": "Toegang tot sessies alleen voor leden", "fr-BE": "Accès aux séances réservées aux membres", en: "Access to members-only sessions" },
  },
  {
    kind: "event_access",
    text: { "nl-BE": "Voorrang bij evenementen", "fr-BE": "Priorité pour les événements", en: "Priority access to events" },
  },
];

/** Inserts a grant and its first entry under `key`, unless an entry with that key exists. */
async function demoGrant(db: DbOrTx, key: string, values: typeof creditGrants.$inferInsert): Promise<string> {
  const [existing] = await db.select({ grantId: creditEntries.grantId }).from(creditEntries).where(eq(creditEntries.idempotencyKey, key));
  if (existing) return existing.grantId;
  const [g] = await db.insert(creditGrants).values(values).returning();
  await db.insert(creditEntries).values({
    grantId: g!.id,
    personId: g!.personId,
    kind: "grant",
    quantity: g!.unitsGranted,
    refType: values.orderLineId ? "order_line" : values.membershipId ? "membership" : null,
    refId: values.orderLineId ?? values.membershipId ?? null,
    actor: system,
    idempotencyKey: key,
    createdAt: g!.startsAt,
  });
  return g!.id;
}

async function demoMembership(
  db: DbOrTx,
  values: typeof memberships.$inferInsert,
): Promise<string> {
  const [existing] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.personId, values.personId), eq(memberships.productId, values.productId), eq(memberships.status, values.status!)));
  if (existing) return existing.id;
  const [m] = await db.insert(memberships).values(values).returning();
  await db.insert(membershipPeriods).values({
    membershipId: m!.id,
    personId: m!.personId,
    periodStartAt: m!.currentPeriodStartAt,
    periodEndAt: m!.currentPeriodEndAt,
    source: "purchase",
  }).onConflictDoNothing();
  return m!.id;
}

/** The credits rows of the demo dataset; a second run creates nothing new. */
export async function seedCreditsDemo(db: DbOrTx, input: CreditsDemoInput): Promise<{ grantIds: string[]; membershipIds: string[] }> {
  const { now } = input;
  const grantIds: string[] = [];

  // Jonas: a 10-day package with 3 left, expiring in 10 days.
  const pc = input.packageCustomer;
  const jonas = await demoGrant(db, `grant:order_line:${pc.orderLineId}:1`, {
    personId: pc.personId,
    productId: pc.productId,
    orderLineId: pc.orderLineId,
    lineUnitIndex: 1,
    creditKind: "day",
    unitsGranted: 10,
    unitValueCents: 2500,
    vatRatePct: "21.00",
    vatTreatment: "single_purpose",
    startsAt: new Date(now.getTime() - 355 * DAY),
    expiresAt: new Date(now.getTime() + 10 * DAY),
    source: "purchase",
  });
  grantIds.push(jonas);
  for (let i = 1; i <= 7; i++) {
    await db
      .insert(creditEntries)
      .values({
        grantId: jonas,
        personId: pc.personId,
        beneficiaryPersonId: pc.personId,
        kind: "consume",
        quantity: -1,
        refType: "booking",
        actor: system,
        idempotencyKey: `consume:demo:${jonas}:${i}`,
        createdAt: new Date(now.getTime() - (350 - i * 40) * DAY),
      })
      .onConflictDoNothing();
  }

  // One 3-unit order line: three packages, each with its own thresholds and expiry (rule 1).
  const tl = input.threeUnitLine;
  for (const n of [1, 2, 3]) {
    grantIds.push(
      await demoGrant(db, `grant:order_line:${tl.orderLineId}:${n}`, {
        personId: tl.personId,
        productId: tl.productId,
        orderLineId: tl.orderLineId,
        lineUnitIndex: n,
        creditKind: "day",
        unitsGranted: tl.units,
        unitValueCents: tl.unitValueCents,
        vatRatePct: "21.00",
        vatTreatment: "single_purpose",
        startsAt: new Date(now.getTime() - 20 * DAY),
        expiresAt: new Date(now.getTime() + 345 * DAY),
        source: "purchase",
        sharing: { mode: "guests", max_guest_uses_per_month: 2, allowed_person_ids: [] },
      }),
    );
  }

  // A redeemed gift voucher: euro store credit, multi-purpose (rule 1a).
  const v = input.voucher;
  grantIds.push(
    await demoGrant(db, `grant:voucher:${v.voucherId}`, {
      personId: v.personId,
      orderLineId: v.orderLineId,
      voucherId: v.voucherId,
      creditKind: "euro",
      unitsGranted: v.amountCents,
      unitValueCents: 1,
      vatTreatment: "multi_purpose",
      startsAt: new Date(now.getTime() - 5 * DAY),
      expiresAt: new Date(now.getTime() + 725 * DAY),
      source: "voucher",
    }),
  );

  // Plan benefits (display only), once per plan.
  const [plan] = await db.select().from(products).where(eq(products.id, input.plan.productId));
  if (!plan) throw new Error(`seedCreditsDemo: no plan product ${input.plan.productId}`);
  const known = await db
    .select({ id: membershipPlanBenefits.id })
    .from(membershipPlanBenefits)
    .where(inArray(membershipPlanBenefits.productId, [plan.id]));
  if (known.length === 0) {
    await db.insert(membershipPlanBenefits).values(BENEFITS.map((b, i) => ({ productId: plan.id, kind: b.kind, text: b.text, sortOrder: i })));
  }
  const interval = plan.recurringInterval ?? "month";
  const discountPct = plan.memberDiscountPct ?? "0";

  // Lotte: an active monthly member for 90 days, with this period's inclusion grant.
  const periodStart = new Date(now.getTime() - 12 * DAY);
  const periodEnd = new Date(periodStart.getTime() + 30 * DAY);
  const lotte = await demoMembership(db, {
    personId: input.memberPersonId,
    productId: plan.id,
    status: "active",
    interval,
    startedAt: new Date(now.getTime() - 90 * DAY),
    currentPeriodStartAt: periodStart,
    currentPeriodEndAt: periodEnd,
    discountPct,
    nextChargeAt: new Date(periodEnd.getTime() - 3 * DAY),
  });
  if (plan.includedCreditKind && plan.includedCreditUnits) {
    grantIds.push(
      await demoGrant(db, `grant:membership:${lotte}:${periodStart.toISOString().slice(0, 10)}:${plan.includedCreditKind}`, {
        personId: input.memberPersonId,
        productId: plan.id,
        membershipId: lotte,
        creditKind: plan.includedCreditKind === "night" ? "night" : "day",
        unitsGranted: plan.includedCreditUnits,
        vatTreatment: "not_applicable",
        startsAt: periodStart,
        expiresAt: periodEnd,
        validityRule: "fixed",
        source: "membership",
      }),
    );
  }

  // Lotte's pending plan change: the next plan starts when the current period ends.
  const [next] = await db.select().from(products).where(eq(products.id, input.plan.nextPlanProductId));
  if (!next) throw new Error(`seedCreditsDemo: no plan product ${input.plan.nextPlanProductId}`);
  const pending = await demoMembership(db, {
    personId: input.memberPersonId,
    productId: next.id,
    status: "pending",
    interval: next.recurringInterval ?? "month",
    startedAt: periodEnd,
    currentPeriodStartAt: periodEnd,
    currentPeriodEndAt: new Date(periodEnd.getTime() + 30 * DAY),
    discountPct: next.memberDiscountPct ?? "0",
  });

  // Hanne: past due since the renewal charge 3 days before period end failed, 2 days ago
  // (dunning attempt 1, day-3 retry pending).
  const failedAt = new Date(now.getTime() - 2 * DAY);
  const pastDueEnd = new Date(failedAt.getTime() + 3 * DAY);
  const hanne = await demoMembership(db, {
    personId: input.pastDuePersonId,
    productId: plan.id,
    status: "past_due",
    interval,
    startedAt: new Date(now.getTime() - 200 * DAY),
    currentPeriodStartAt: new Date(pastDueEnd.getTime() - 30 * DAY),
    currentPeriodEndAt: pastDueEnd,
    discountPct,
    dunningAttempt: 1,
    pastDueSinceAt: failedAt,
    nextChargeAt: new Date(failedAt.getTime() + 3 * DAY),
  });

  return { grantIds, membershipIds: [lotte, pending, hanne] };
}
