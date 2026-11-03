/**
 * credits contract stubs created by Wave 0 on behalf of credits (platform-P2): `credit_grants`
 * and `credit_entries` (the ledger) with their architecture columns (data model 1.2.5). credits
 * takes the file over and adds columns and tables (expand only).
 */
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import { orderLines, products } from "./commerce";
import { persons } from "./crm";
import { createdAt, id, timestamps, tstz, type ActorJson } from "./_shared";

export const creditGrantsCreditKind = pgEnum("credit_grants_credit_kind", [
  "day",
  "night",
  "euro",
]);
export const creditGrantsStatus = pgEnum("credit_grants_status", [
  "active",
  "exhausted",
  "expired",
  "revoked",
]);
export const creditGrantsSource = pgEnum("credit_grants_source", [
  "purchase",
  "voucher",
  "membership",
  "bonus",
  "import",
  "manual",
  "referral",
  "transfer",
]);
export const creditEntriesKind = pgEnum("credit_entries_kind", [
  "grant",
  "consume",
  "release",
  "expire",
  "extend",
  "adjust",
  "revoke",
  "transfer_out",
  "transfer_in",
]);

/** `GrantSharing` (Zod in `packages/core/src/credits`). */
export type GrantSharingJson = {
  mode: "none" | "guests" | "named";
  max_guest_uses_per_month: number;
  allowed_person_ids: string[];
};

export const creditGrants = pgTable(
  "credit_grants",
  {
    id: id(),
    personId: uuid()
      .notNull()
      .references(() => persons.id, { onDelete: "restrict" }),
    productId: uuid().references(() => products.id),
    orderLineId: uuid().references(() => orderLines.id),
    creditKind: creditGrantsCreditKind().notNull(),
    unitsGranted: integer().notNull(),
    unitValueCents: integer().notNull().default(0),
    startsAt: tstz().notNull().defaultNow(),
    expiresAt: tstz(),
    status: creditGrantsStatus().notNull().default("active"),
    source: creditGrantsSource().notNull(),
    sharing: jsonb()
      .$type<GrantSharingJson>()
      .notNull()
      .default({
        mode: "none",
        max_guest_uses_per_month: 0,
        allowed_person_ids: [],
      }),
    ...timestamps(),
  },
  (t) => [
    index("credit_grants_person_kind_idx").on(
      t.personId,
      t.creditKind,
      t.status,
      t.expiresAt,
    ),
    index("credit_grants_active_expires_idx")
      .on(t.expiresAt)
      .where(sql`${t.status} = 'active'`),
    index("credit_grants_order_line_idx").on(t.orderLineId),
    index("credit_grants_product_idx").on(t.productId),
    check("credit_grants_units_ck", sql`${t.unitsGranted} > 0`),
    check("credit_grants_unit_value_ck", sql`${t.unitValueCents} >= 0`),
    check(
      "credit_grants_euro_unit_ck",
      sql`${t.creditKind} <> 'euro' or ${t.unitValueCents} = 1`,
    ),
    check(
      "credit_grants_expiry_ck",
      sql`${t.expiresAt} is null or ${t.expiresAt} > ${t.startsAt}`,
    ),
  ],
);

/** APPEND (the ledger). */
export const creditEntries = pgTable(
  "credit_entries",
  {
    id: id(),
    grantId: uuid()
      .notNull()
      .references(() => creditGrants.id),
    personId: uuid()
      .notNull()
      .references(() => persons.id, { onDelete: "restrict" }),
    beneficiaryPersonId: uuid().references(() => persons.id, {
      onDelete: "restrict",
    }),
    kind: creditEntriesKind().notNull(),
    quantity: integer().notNull(),
    reason: text(),
    refType: text(),
    refId: uuid(),
    data: jsonb().notNull().default({}),
    actor: jsonb().$type<ActorJson>().notNull(),
    idempotencyKey: text()
      .notNull()
      .unique("credit_entries_idempotency_key_unique"),
    createdAt: createdAt(),
  },
  (t) => [
    index("credit_entries_grant_idx").on(t.grantId, t.createdAt),
    index("credit_entries_person_idx").on(t.personId, t.createdAt.desc()),
    index("credit_entries_beneficiary_idx")
      .on(t.beneficiaryPersonId, t.createdAt)
      .where(sql`${t.beneficiaryPersonId} is not null`),
    index("credit_entries_ref_idx").on(t.refType, t.refId),
    check(
      "credit_entries_sign_ck",
      sql`(${t.kind} not in ('grant', 'transfer_in', 'release') or ${t.quantity} > 0) and (${t.kind} not in ('consume', 'expire', 'revoke', 'transfer_out') or ${t.quantity} < 0)`,
    ),
    check(
      "credit_entries_beneficiary_ck",
      sql`${t.beneficiaryPersonId} is null or ${t.kind} in ('consume', 'release')`,
    ),
  ],
);
