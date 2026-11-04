/**
 * Shared test factories (platform-P2). Each takes `(db, overrides?)`, fills every required
 * column with a valid default and returns the inserted row. Module-specific factories live in
 * files owned by that module's packages, never here.
 */
import { randomUUID } from "node:crypto";
import type { DbOrTx } from "../client";
import { sessions } from "../schema/booking";
import { priceVersions, products } from "../schema/commerce";
import { creditEntries, creditGrants } from "../schema/credits";
import { persons } from "../schema/crm";
import { roles, users, type RoleKey } from "../schema/platform";

let counter = 0;
/** A short unique suffix: a per-process counter plus random characters. */
const unique = () => `${(++counter).toString(36)}${randomUUID().slice(0, 6)}`;

export type PersonRow = typeof persons.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export type ProductRow = typeof products.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type GrantRow = typeof creditGrants.$inferSelect;

/** A person with a unique `@example.com` email, `nl-BE`, `is_tester = true`. */
export async function makePerson(
  db: DbOrTx,
  overrides: Partial<typeof persons.$inferInsert> = {},
): Promise<PersonRow> {
  const suffix = unique();
  const [row] = await db
    .insert(persons)
    .values({
      email: `person-${suffix}@example.com`,
      firstName: "Test",
      lastName: `Person ${suffix}`,
      locale: "nl-BE",
      isTester: true,
      acquisition: { source: "manual" },
      ...overrides,
    })
    .returning();
  return row!;
}

const ROLE_NAMES: Record<RoleKey, string> = {
  owner: "Owner",
  management: "Management",
  customer_service: "Customer service",
  sales: "Sales",
  marketing: "Marketing",
  finance: "Finance",
  reception: "Reception",
  technical_admin: "Technical admin",
  external_partner: "External partner",
};

/** Makes sure a `roles` row exists for `key` (the seed's rows win when present). */
export async function ensureRole(db: DbOrTx, key: RoleKey): Promise<void> {
  await db
    .insert(roles)
    .values({
      key,
      name: { en: ROLE_NAMES[key] },
      permissions: key === "owner" ? ["*"] : [],
    })
    .onConflictDoNothing({ target: roles.key });
}

/**
 * A user. Defaults to an active staff `technical_admin` with MFA enrolled. With
 * `audience: 'customer'` and no `personId`, a person is created first. The role row is
 * created when missing.
 */
export async function makeUser(
  db: DbOrTx,
  overrides: Partial<typeof users.$inferInsert> = {},
): Promise<UserRow> {
  const audience = overrides.audience ?? "staff";
  const values: typeof users.$inferInsert = {
    audience,
    email: `user-${unique()}@example.com`,
    name: "Test User",
    locale: "nl-BE",
    isTester: true,
    ...(audience === "staff"
      ? { roleKey: "technical_admin", mfaEnrolledAt: new Date() }
      : {}),
    ...overrides,
  };
  if (audience === "customer" && !values.personId) {
    values.personId = (await makePerson(db, { email: values.email })).id;
  }
  if (values.roleKey) await ensureRole(db, values.roleKey);
  if (values.roleKey === "external_partner" && !values.personId) {
    values.personId = (await makePerson(db)).id;
  }
  const [row] = await db.insert(users).values(values).returning();
  return row!;
}

type ProductInsert = typeof products.$inferInsert;

/** Defaults that satisfy the `products_*_chk` checks for each kind (an `item` needs a category). */
function productDefaults(kind: ProductInsert["kind"]): Partial<ProductInsert> {
  switch (kind) {
    case "package":
      return {
        creditKind: "day",
        creditUnits: 5,
        validityDays: 365,
        vatRatePct: "21.00",
      };
    case "voucher":
      return { creditKind: "euro", vatRatePct: "0.00", validityDays: 730 };
    case "membership":
      return {
        recurringInterval: "month",
        includedCreditKind: "day",
        includedCreditUnits: 4,
        vatRatePct: "21.00",
      };
    case "item":
      return { vatRatePct: "21.00", itemCategory: "merchandise" };
    default:
      return { vatRatePct: "21.00" };
  }
}

/**
 * An active product (default: a five-day `package`). `priceCents` also inserts the
 * public price version 1.
 */
export async function makeProduct(
  db: DbOrTx,
  overrides: Partial<ProductInsert> & { priceCents?: number } = {},
): Promise<ProductRow> {
  const { priceCents, ...rest } = overrides;
  const kind = rest.kind ?? "package";
  const suffix = unique().toUpperCase();
  const [row] = await db
    .insert(products)
    .values({
      kind,
      sku: `TEST-${suffix}`.slice(0, 32),
      name: {
        "nl-BE": `Testproduct ${suffix}`,
        "fr-BE": `Produit test ${suffix}`,
        en: `Test product ${suffix}`,
      },
      isActive: true,
      ...productDefaults(kind),
      ...rest,
    } as ProductInsert)
    .returning();
  if (priceCents !== undefined) {
    await db
      .insert(priceVersions)
      .values({
        productId: row!.id,
        version: 1,
        audience: "public",
        amountCents: priceCents,
      });
  }
  return row!;
}

/**
 * An open day session tomorrow at 10:00 UTC for two hours, 10 seats, paid with one day credit.
 * A `night` gets 6 beds and a night credit; an `event` gets the category `lecture`.
 */
export async function makeSession(
  db: DbOrTx,
  overrides: Partial<typeof sessions.$inferInsert> = {},
): Promise<SessionRow> {
  const startsAt =
    overrides.startsAt ??
    new Date(
      Date.UTC(
        new Date().getUTCFullYear(),
        new Date().getUTCMonth(),
        new Date().getUTCDate() + 1,
        10,
      ),
    );
  const kind = overrides.kind ?? "day";
  const [row] = await db
    .insert(sessions)
    .values({
      kind,
      title: {
        "nl-BE": "Testsessie",
        "fr-BE": "Session test",
        en: "Test session",
      },
      startsAt,
      endsAt: new Date(startsAt.getTime() + 2 * 60 * 60 * 1000),
      ...(kind === "night"
        ? { capacityBeds: 6, creditKind: "night" as const }
        : { capacitySeats: 10 }),
      ...(kind === "day" ? { creditKind: "day" as const } : {}),
      ...(kind === "event" ? { eventCategory: "lecture" as const } : {}),
      ...overrides,
    })
    .returning();
  return row!;
}

/**
 * A credit grant with its `grant` ledger entry, so balance views see it. `units` is a short
 * form of `unitsGranted`; a person is created when `personId` is missing.
 */
export async function makeGrant(
  db: DbOrTx,
  overrides: Partial<typeof creditGrants.$inferInsert> & {
    units?: number;
  } = {},
): Promise<GrantRow> {
  const { units, ...rest } = overrides;
  const personId = rest.personId ?? (await makePerson(db)).id;
  const creditKind = rest.creditKind ?? "day";
  const [grant] = await db
    .insert(creditGrants)
    .values({
      personId,
      creditKind,
      unitsGranted: units ?? rest.unitsGranted ?? 5,
      unitValueCents: creditKind === "euro" ? 1 : 0,
      source: "manual",
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      ...rest,
    })
    .returning();
  await db.insert(creditEntries).values({
    grantId: grant!.id,
    personId,
    kind: "grant",
    quantity: grant!.unitsGranted,
    reason: "test factory",
    actor: { kind: "system", id: null },
    idempotencyKey: `grant:test:${grant!.id}`,
  });
  return grant!;
}
