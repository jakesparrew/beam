/**
 * credits test factories (credits-P1). Each takes `(db, overrides?)`, fills every required column
 * with a value that satisfies the credits checks and returns the inserted row. The shared
 * `makeGrant` of `factories.ts` stays the short form; these cover every source and status.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { DbOrTx } from "../client";
import { products } from "../schema/commerce";
import {
  creditEntries,
  creditGrants,
  memberships,
  type CreditEntryRefType,
} from "../schema/credits";
import { makePerson, makeProduct } from "./factories";

export type CreditGrantRow = typeof creditGrants.$inferSelect;
export type CreditEntryRow = typeof creditEntries.$inferSelect;
export type MembershipRow = typeof memberships.$inferSelect;

const DAY = 24 * 60 * 60 * 1000;

/** The `vat_treatment` the services give a grant of this kind and source (credits rules 1a, 4, 6, 20a). */
export function defaultVatTreatment(
  kind: CreditGrantRow["creditKind"],
  source: CreditGrantRow["source"],
): CreditGrantRow["vatTreatment"] {
  if (source === "voucher") return "multi_purpose";
  if (source === "purchase" || source === "import" || source === "transfer")
    return kind === "euro" ? "multi_purpose" : "single_purpose";
  return "not_applicable";
}

/**
 * A credit grant with its first ledger entry (`grant`, or `transfer_in` for source `transfer`)
 * of `units_granted`, so the balance views see it. `units` is a short form of `unitsGranted`.
 * A person is created when `personId` is missing; a `membership` grant without `membershipId`
 * gets a membership of that person. `withEntry: false` skips the first entry.
 */
export async function makeCreditGrant(
  db: DbOrTx,
  overrides: Partial<typeof creditGrants.$inferInsert> & { units?: number; withEntry?: boolean } = {},
): Promise<CreditGrantRow> {
  const { units, withEntry = true, ...rest } = overrides;
  const personId = rest.personId ?? (await makePerson(db)).id;
  const creditKind = rest.creditKind ?? "day";
  const source = rest.source ?? "manual";
  const values: typeof creditGrants.$inferInsert = {
    personId,
    creditKind,
    source,
    unitsGranted: units ?? rest.unitsGranted ?? 5,
    unitValueCents: creditKind === "euro" ? 1 : 0,
    vatTreatment: defaultVatTreatment(creditKind, source),
    expiresAt: new Date(Date.now() + 365 * DAY),
    ...(source === "voucher" ? { voucherId: randomUUID() } : {}),
    ...rest,
  };
  if (source === "membership" && !values.membershipId) {
    values.membershipId = (await makeMembership(db, { personId })).id;
  }
  const [grant] = await db.insert(creditGrants).values(values).returning();
  if (withEntry) {
    await makeEntry(db, {
      grantId: grant!.id,
      personId,
      kind: source === "transfer" ? "transfer_in" : "grant",
      quantity: grant!.unitsGranted,
      createdAt: grant!.startsAt < new Date() ? grant!.startsAt : undefined,
    });
  }
  return grant!;
}

/**
 * A ledger entry. `grantId` is required; `personId` defaults to the grant owner, `quantity` to a
 * value of the right sign for `kind` (1, or -1, or 0 for `extend`), and an `adjust` gets a reason,
 * an `extend` its `data.new_expires_at`. A `release` needs `reversesEntryId`.
 */
export async function makeEntry(
  db: DbOrTx,
  overrides: Partial<typeof creditEntries.$inferInsert> & { grantId: string; refType?: CreditEntryRefType | null },
): Promise<CreditEntryRow> {
  const kind = overrides.kind ?? "consume";
  let personId = overrides.personId;
  if (!personId) {
    const [g] = await db
      .select({ personId: creditGrants.personId })
      .from(creditGrants)
      .where(eq(creditGrants.id, overrides.grantId));
    if (!g) throw new Error(`makeEntry: no grant ${overrides.grantId}`);
    personId = g.personId;
  }
  const negative = ["consume", "expire", "revoke", "transfer_out"].includes(kind);
  const quantity = overrides.quantity ?? (kind === "extend" ? 0 : negative ? -1 : 1);
  const [row] = await db
    .insert(creditEntries)
    .values({
      kind,
      quantity,
      personId,
      actor: { kind: "system", id: null },
      idempotencyKey: `test:${kind}:${randomUUID()}`,
      ...(kind === "adjust" ? { reason: "test adjustment" } : {}),
      ...(kind === "extend" ? { data: { old_expires_at: null, new_expires_at: new Date(Date.now() + 30 * DAY).toISOString() } } : {}),
      ...overrides,
    })
    .returning();
  return row!;
}

/**
 * A membership. Defaults to an `active` monthly membership of a new person on a new membership
 * product, started 10 days ago, with the current period running from then for one month.
 * `cancelled` and `expired` rows get `ended_at` and an `end_reason` when not given.
 */
export async function makeMembership(
  db: DbOrTx,
  overrides: Partial<typeof memberships.$inferInsert> = {},
): Promise<MembershipRow> {
  const personId = overrides.personId ?? (await makePerson(db)).id;
  let productId = overrides.productId;
  let interval = overrides.interval;
  if (!productId) {
    const product = await makeProduct(db, { kind: "membership", memberDiscountPct: "10.00" });
    productId = product.id;
    interval ??= product.recurringInterval ?? "month";
  } else if (!interval) {
    const [p] = await db
      .select({ interval: products.recurringInterval })
      .from(products)
      .where(eq(products.id, productId));
    interval = p?.interval ?? "month";
  }
  const status = overrides.status ?? "active";
  const startedAt = overrides.startedAt ?? new Date(Date.now() - 10 * DAY);
  const periodStart = overrides.currentPeriodStartAt ?? startedAt;
  const periodEnd =
    overrides.currentPeriodEndAt ??
    new Date(periodStart.getTime() + (interval === "year" ? 365 : 30) * DAY);
  const ended = status === "cancelled" || status === "expired";
  const [row] = await db
    .insert(memberships)
    .values({
      personId,
      productId,
      interval,
      status,
      startedAt,
      currentPeriodStartAt: periodStart,
      currentPeriodEndAt: periodEnd,
      ...(ended
        ? {
            endedAt: overrides.endedAt ?? new Date(),
            endReason: overrides.endReason ?? (status === "cancelled" ? "cancelled_by_customer" : "not_renewed"),
          }
        : {}),
      ...overrides,
    })
    .returning();
  return row!;
}
