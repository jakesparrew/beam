/**
 * credits schema (credits spec section 2, data model 1.2.5). Wave 0 stubs of `credit_grants` and
 * `credit_entries` by platform-P2, completed by credits-P1 with the final V1 tables, enums,
 * checks and indexes. R2 (`credit_sharing_reviews`) and R3/R4 objects (referrals, partner
 * commissions) are added by later credits packages (expand only).
 *
 * No column here is sensitive. Free-text staff columns (`credit_grants.note`,
 * `credit_entries.reason`, `memberships.notes`) are PII-risk: never in AI context, segments or
 * exports, redacted on erasure.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  smallint,
  text,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { mandates, orderLines, orders, priceVersions, products } from "./commerce";
import { persons } from "./crm";
import { users } from "./platform";
import {
  createdAt,
  id,
  localized,
  timestamps,
  tstz,
  vatRate,
  vatRateCheck,
  type ActorJson,
} from "./_shared";

/** The APPEND tables of this module (also listed in `APPEND_ONLY_TABLES`). */
export const CREDITS_APPEND_ONLY = ["credit_entries", "membership_periods"] as const;

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const creditGrantsCreditKind = pgEnum("credit_grants_credit_kind", ["day", "night", "euro"]);
export const creditGrantsStatus = pgEnum("credit_grants_status", ["active", "exhausted", "expired", "revoked"]);
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
export const creditGrantsValidityRule = pgEnum("credit_grants_validity_rule", ["from_purchase", "fixed"]);
export const creditGrantsVatTreatment = pgEnum("credit_grants_vat_treatment", [
  "single_purpose",
  "multi_purpose",
  "not_applicable",
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
export const packageSharesStatus = pgEnum("package_shares_status", ["active", "revoked"]);
export const membershipsStatus = pgEnum("memberships_status", ["pending", "active", "past_due", "cancelled", "expired"]);
export const membershipsInterval = pgEnum("memberships_interval", ["month", "year"]);
export const membershipsSource = pgEnum("memberships_source", ["purchase", "import", "staff"]);
export const membershipsEndReason = pgEnum("memberships_end_reason", [
  "cancelled_by_customer",
  "cancelled_by_staff",
  "refunded",
  "payment_failed",
  "not_renewed",
  "merged",
  "erased",
]);
export const membershipPlanBenefitsKind = pgEnum("membership_plan_benefits_kind", [
  "included_units",
  "discount",
  "member_only_access",
  "event_access",
  "event_discount",
  "other",
]);
export const creditBulkExtensionsStatus = pgEnum("credit_bulk_extensions_status", ["pending", "running", "done", "failed"]);
export const membershipPeriodsSource = pgEnum("membership_periods_source", [
  "purchase",
  "renewal",
  "late_payment",
  "import",
  "staff_extension",
]);
export const creditReconciliationRunsStatus = pgEnum("credit_reconciliation_runs_status", ["ok", "mismatch", "error"]);

/** The values of `credit_entries.ref_type` (check constraint `credit_entries_ref_type_ck`). */
export const CREDIT_ENTRY_REF_TYPES = [
  "booking",
  "order",
  "order_line",
  "voucher",
  "refund",
  "membership",
  "import",
  "referral",
  "transfer",
  "bulk_extension",
  "privacy_request",
] as const;
export type CreditEntryRefType = (typeof CREDIT_ENTRY_REF_TYPES)[number];

// ---------------------------------------------------------------------------
// JSON shapes
// ---------------------------------------------------------------------------

/** `GrantSharing` (Zod in `packages/core/src/credits`). */
export type GrantSharingJson = {
  mode: "none" | "guests" | "named";
  max_guest_uses_per_month: number;
  allowed_person_ids: string[];
};

/** `credit_grants.data`. */
export type CreditGrantDataJson = {
  original_units?: number;
  legacy_source?: string;
  legacy_id?: string;
  import_id?: string;
  transfer_from_grant_id?: string;
  last_bulk_extension_id?: string;
  refund_id?: string;
};

/** `credit_entries.data` (`extend`: old and new expiry; euro `consume`: `vat_at_redemption`; release `reason`). */
export type CreditEntryDataJson = {
  old_expires_at?: string | null;
  new_expires_at?: string | null;
  vat_at_redemption?: boolean;
  reason?: string;
  [key: string]: unknown;
};

/** `credit_bulk_extensions.filter`. */
export type BulkExtensionFilterJson = {
  kinds: ("day" | "night" | "euro")[];
  sources: (typeof creditGrantsSource.enumValues)[number][];
  expires_from_on: string;
  expires_to_on: string;
};

/** One `credit_reconciliation_runs.findings` item (ids only). */
export type ReconciliationFindingJson = {
  check: string;
  grant_id?: string;
  booking_id?: string;
  membership_id?: string;
  expected: unknown;
  actual: unknown;
};

/** `'a', 'b', ...` for an `in (...)` list of constant strings. */
const sqlList = (list: readonly string[]) => sql.raw(list.map((v) => `'${v}'`).join(", "));

// ---------------------------------------------------------------------------
// Memberships (declared before grants: membership grants reference them)
// ---------------------------------------------------------------------------

export const memberships = pgTable(
  "memberships",
  {
    id: id(),
    personId: uuid()
      .notNull()
      .references(() => persons.id, { onDelete: "restrict" }),
    productId: uuid()
      .notNull()
      .references(() => products.id),
    status: membershipsStatus().notNull().default("pending"),
    interval: membershipsInterval().notNull(),
    source: membershipsSource().notNull().default("purchase"),
    startedAt: tstz().notNull(),
    currentPeriodStartAt: tstz().notNull(),
    currentPeriodEndAt: tstz().notNull(),
    cancelAt: tstz(),
    cancelRequestedAt: tstz(),
    endedAt: tstz(),
    endReason: membershipsEndReason(),
    /** The SEPA mandate of a direct-debit membership; set null when the mandate row goes. */
    mandateId: uuid().references((): AnyPgColumn => mandates.id, { onDelete: "set null" }),
    priceVersionId: uuid().references(() => priceVersions.id),
    firstOrderId: uuid().references(() => orders.id),
    renewalOrderId: uuid().references(() => orders.id),
    discountPct: numeric({ precision: 5, scale: 2 }).notNull().default("0"),
    nextChargeAt: tstz(),
    dunningAttempt: smallint().notNull().default(0),
    pastDueSinceAt: tstz(),
    notes: text(),
    version: integer().notNull().default(1),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("memberships_person_live_uq")
      .on(t.personId)
      .where(sql`${t.status} in ('active', 'past_due')`),
    uniqueIndex("memberships_person_pending_uq")
      .on(t.personId)
      .where(sql`${t.status} = 'pending'`),
    index("memberships_status_period_end_idx").on(t.status, t.currentPeriodEndAt),
    index("memberships_next_charge_idx")
      .on(t.nextChargeAt)
      .where(sql`${t.status} in ('active', 'past_due')`),
    index("memberships_renewal_order_idx").on(t.renewalOrderId),
    check("memberships_period_ck", sql`${t.currentPeriodEndAt} > ${t.currentPeriodStartAt}`),
    check(
      "memberships_end_reason_ck",
      sql`(${t.endReason} is not null) = (${t.status} in ('cancelled', 'expired'))`,
    ),
    check("memberships_discount_ck", sql`${t.discountPct} between 0 and 100`),
    check("memberships_dunning_ck", sql`${t.dunningAttempt} between 0 and 3`),
    check("memberships_version_ck", sql`${t.version} >= 1`),
  ],
);

/** APPEND: one row per paid, imported or extended membership period (history). */
export const membershipPeriods = pgTable(
  "membership_periods",
  {
    id: id(),
    membershipId: uuid()
      .notNull()
      .references(() => memberships.id),
    personId: uuid()
      .notNull()
      .references(() => persons.id, { onDelete: "restrict" }),
    periodStartAt: tstz().notNull(),
    periodEndAt: tstz().notNull(),
    source: membershipPeriodsSource().notNull(),
    orderId: uuid().references(() => orders.id),
    amountCents: integer().notNull().default(0),
    createdByUserId: uuid().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique("membership_periods_membership_start_uq").on(t.membershipId, t.periodStartAt),
    index("membership_periods_person_idx").on(t.personId),
    check("membership_periods_window_ck", sql`${t.periodEndAt} > ${t.periodStartAt}`),
    check("membership_periods_amount_ck", sql`${t.amountCents} >= 0`),
  ],
);

/** Extra included credit kinds per plan beyond the product's primary inclusion. */
export const membershipPlanInclusions = pgTable(
  "membership_plan_inclusions",
  {
    id: id(),
    productId: uuid()
      .notNull()
      .references(() => products.id),
    creditKind: creditGrantsCreditKind().notNull(),
    unitsPerPeriod: integer().notNull(),
    isActive: boolean().notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    unique("membership_plan_inclusions_product_kind_uq").on(t.productId, t.creditKind),
    check("membership_plan_inclusions_kind_ck", sql`${t.creditKind} <> 'euro'`),
    check("membership_plan_inclusions_units_ck", sql`${t.unitsPerPeriod} > 0`),
  ],
);

/** NO_PII. The benefits list shown in the shop, the portal and the plan screen (display only). */
export const membershipPlanBenefits = pgTable(
  "membership_plan_benefits",
  {
    id: id(),
    productId: uuid()
      .notNull()
      .references(() => products.id),
    kind: membershipPlanBenefitsKind().notNull(),
    text: localized().notNull(),
    sortOrder: smallint().notNull().default(0),
    isActive: boolean().notNull().default(true),
    ...timestamps(),
  },
  (t) => [index("membership_plan_benefits_product_sort_idx").on(t.productId, t.sortOrder)],
);

// ---------------------------------------------------------------------------
// Grants and the ledger
// ---------------------------------------------------------------------------

/** A package is a grant. Balances are never stored: see `v_credit_grant_balances`. */
export const creditGrants = pgTable(
  "credit_grants",
  {
    id: id(),
    personId: uuid()
      .notNull()
      .references(() => persons.id, { onDelete: "restrict" }),
    productId: uuid().references(() => products.id),
    orderLineId: uuid().references(() => orderLines.id),
    lineUnitIndex: smallint(),
    // commerce `vouchers.id`; no FK (commerce's `vouchers.credit_grant_id` references this table).
    voucherId: uuid(),
    membershipId: uuid().references(() => memberships.id),
    creditKind: creditGrantsCreditKind().notNull(),
    unitsGranted: integer().notNull(),
    unitValueCents: integer().notNull().default(0),
    vatRatePct: vatRate(),
    vatTreatment: creditGrantsVatTreatment().notNull().default("not_applicable"),
    startsAt: tstz().notNull().defaultNow(),
    expiresAt: tstz(),
    validityRule: creditGrantsValidityRule().notNull().default("from_purchase"),
    status: creditGrantsStatus().notNull().default("active"),
    statusChangedAt: tstz().notNull().defaultNow(),
    source: creditGrantsSource().notNull(),
    sharing: jsonb()
      .$type<GrantSharingJson>()
      .notNull()
      .default({
        mode: "none",
        max_guest_uses_per_month: 0,
        allowed_person_ids: [],
      }),
    label: localized(),
    note: text(),
    data: jsonb().$type<CreditGrantDataJson>().notNull().default({}),
    createdByUserId: uuid().references(() => users.id),
    ...timestamps(),
  },
  (t) => [
    index("credit_grants_person_kind_idx").on(t.personId, t.creditKind, t.status, t.expiresAt),
    index("credit_grants_active_expires_idx")
      .on(t.expiresAt)
      .where(sql`${t.status} = 'active'`),
    index("credit_grants_order_line_idx").on(t.orderLineId),
    index("credit_grants_product_idx").on(t.productId),
    uniqueIndex("credit_grants_order_line_unit_uq")
      .on(t.orderLineId, t.lineUnitIndex)
      .where(sql`${t.source} = 'purchase'`),
    uniqueIndex("credit_grants_voucher_uq")
      .on(t.voucherId)
      .where(sql`${t.source} = 'voucher'`),
    uniqueIndex("credit_grants_membership_kind_start_uq")
      .on(t.membershipId, t.creditKind, t.startsAt)
      .where(sql`${t.source} = 'membership'`),
    check("credit_grants_units_ck", sql`${t.unitsGranted} > 0`),
    check("credit_grants_unit_value_ck", sql`${t.unitValueCents} >= 0`),
    check("credit_grants_euro_unit_ck", sql`${t.creditKind} <> 'euro' or ${t.unitValueCents} = 1`),
    check("credit_grants_expiry_ck", sql`${t.expiresAt} is null or ${t.expiresAt} > ${t.startsAt}`),
    check("credit_grants_line_unit_index_ck", sql`${t.lineUnitIndex} is null or ${t.lineUnitIndex} > 0`),
    vatRateCheck("credit_grants_vat_rate_ck", t.vatRatePct),
    check(
      "credit_grants_order_line_ck",
      sql`${t.source} not in ('purchase', 'voucher') or ${t.orderLineId} is not null`,
    ),
    check("credit_grants_purchase_unit_ck", sql`${t.source} <> 'purchase' or ${t.lineUnitIndex} is not null`),
    check(
      "credit_grants_voucher_ck",
      sql`${t.source} <> 'voucher' or (${t.voucherId} is not null and ${t.creditKind} = 'euro')`,
    ),
    check("credit_grants_membership_ck", sql`${t.source} <> 'membership' or ${t.membershipId} is not null`),
    check(
      "credit_grants_euro_vat_ck",
      sql`${t.creditKind} <> 'euro' or ${t.vatTreatment} in ('multi_purpose', 'not_applicable')`,
    ),
    check("credit_grants_multi_purpose_ck", sql`${t.creditKind} = 'euro' or ${t.vatTreatment} <> 'multi_purpose'`),
    check("credit_grants_note_ck", sql`${t.note} is null or length(${t.note}) <= 1000`),
  ],
);

/** APPEND (the ledger). Rows are never updated or deleted outside erasure and retention. */
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
    refType: text().$type<CreditEntryRefType>(),
    refId: uuid(),
    reversesEntryId: uuid().references((): AnyPgColumn => creditEntries.id),
    data: jsonb().$type<CreditEntryDataJson>().notNull().default({}),
    actor: jsonb().$type<ActorJson>().notNull(),
    idempotencyKey: text().notNull().unique("credit_entries_idempotency_key_unique"),
    createdAt: createdAt(),
  },
  (t) => [
    index("credit_entries_grant_idx").on(t.grantId, t.createdAt),
    index("credit_entries_person_idx").on(t.personId, t.createdAt.desc()),
    index("credit_entries_beneficiary_idx")
      .on(t.beneficiaryPersonId, t.createdAt)
      .where(sql`${t.beneficiaryPersonId} is not null`),
    index("credit_entries_ref_idx").on(t.refType, t.refId),
    uniqueIndex("credit_entries_release_uq")
      .on(t.reversesEntryId)
      .where(sql`${t.kind} = 'release'`),
    check(
      "credit_entries_sign_ck",
      sql`(${t.kind} not in ('grant', 'transfer_in', 'release') or ${t.quantity} > 0) and (${t.kind} not in ('consume', 'expire', 'revoke', 'transfer_out') or ${t.quantity} < 0)`,
    ),
    check(
      "credit_entries_beneficiary_ck",
      sql`${t.beneficiaryPersonId} is null or ${t.kind} in ('consume', 'release')`,
    ),
    check(
      "credit_entries_extend_ck",
      sql`${t.kind} <> 'extend' or (${t.quantity} = 0 and ${t.data} ? 'new_expires_at')`,
    ),
    check(
      "credit_entries_adjust_ck",
      sql`${t.kind} <> 'adjust' or (${t.quantity} <> 0 and ${t.reason} is not null and length(btrim(${t.reason})) >= 3)`,
    ),
    check("credit_entries_release_ck", sql`${t.kind} <> 'release' or ${t.reversesEntryId} is not null`),
    check(
      "credit_entries_ref_type_ck",
      sql`${t.refType} is null or ${t.refType} in (${sqlList(CREDIT_ENTRY_REF_TYPES)})`,
    ),
  ],
);

/** Named sharing of a grant (rows used from R2). */
export const packageShares = pgTable(
  "package_shares",
  {
    id: id(),
    grantId: uuid()
      .notNull()
      .references(() => creditGrants.id),
    sharedWithPersonId: uuid()
      .notNull()
      .references(() => persons.id, { onDelete: "restrict" }),
    maxUnits: integer(),
    status: packageSharesStatus().notNull().default("active"),
    createdByUserId: uuid().references(() => users.id),
    createdByPersonId: uuid().references(() => persons.id, { onDelete: "restrict" }),
    revokedAt: tstz(),
    revokedReason: text(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("package_shares_active_uq")
      .on(t.grantId, t.sharedWithPersonId)
      .where(sql`${t.status} = 'active'`),
    index("package_shares_shared_with_idx")
      .on(t.sharedWithPersonId)
      .where(sql`${t.status} = 'active'`),
    check("package_shares_max_units_ck", sql`${t.maxUnits} is null or ${t.maxUnits} > 0`),
    check("package_shares_creator_ck", sql`num_nonnulls(${t.createdByUserId}, ${t.createdByPersonId}) = 1`),
  ],
);

/** NO_PII. One row per staff bulk extension (closure periods). */
export const creditBulkExtensions = pgTable(
  "credit_bulk_extensions",
  {
    id: id(),
    reason: text().notNull(),
    days: smallint().notNull(),
    filter: jsonb().$type<BulkExtensionFilterJson>().notNull(),
    status: creditBulkExtensionsStatus().notNull().default("pending"),
    matchedCount: integer().notNull().default(0),
    extendedCount: integer().notNull().default(0),
    createdByUserId: uuid()
      .notNull()
      .references(() => users.id),
    finishedAt: tstz(),
    ...timestamps(),
  },
  (t) => [
    index("credit_bulk_extensions_created_idx").on(t.createdAt.desc()),
    check("credit_bulk_extensions_reason_ck", sql`length(btrim(${t.reason})) >= 3`),
    check("credit_bulk_extensions_days_ck", sql`${t.days} between 1 and 90`),
    check("credit_bulk_extensions_counts_ck", sql`${t.matchedCount} >= 0 and ${t.extendedCount} >= 0`),
  ],
);

/** NO_PII (ids only). One row per nightly `ledger.reconcile` run. */
export const creditReconciliationRuns = pgTable(
  "credit_reconciliation_runs",
  {
    id: id(),
    jobId: uuid(),
    startedAt: tstz().notNull(),
    finishedAt: tstz(),
    status: creditReconciliationRunsStatus(),
    checkedGrants: integer().notNull().default(0),
    checkedBookings: integer().notNull().default(0),
    findings: jsonb().$type<ReconciliationFindingJson[]>().notNull().default([]),
    fixed: jsonb().$type<ReconciliationFindingJson[]>().notNull().default([]),
    createdAt: createdAt(),
  },
  (t) => [
    index("credit_reconciliation_runs_started_idx").on(t.startedAt.desc()),
    check(
      "credit_reconciliation_runs_finished_ck",
      sql`(${t.finishedAt} is null) = (${t.status} is null)`,
    ),
  ],
);
