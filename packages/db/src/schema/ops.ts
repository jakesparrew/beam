/**
 * ops schema (ops spec section 2.2, data model 1.2.10), taken over from the empty Wave 0 stub
 * by ops-P1. Every ops table of V1 to R4 is created here (R2-R4 tables stay empty until their
 * release), so later ops packages never edit this file; the views live in `ops.views.ts`.
 *
 * `imported_history` is APPEND (listed in `APPEND_ONLY_TABLES`, trigger `reject_update_delete()`,
 * bypassed only by erasure under `beam.allow_rewrite`). No column here is sensitive; personal
 * data columns are `person_id` everywhere, `import_rows.data`, `imported_history.description`
 * and `data`, and `nl_questions.question`.
 *
 * `retention_list_items.task_id` has no FK yet: crm's `tasks` table is not in BASE (requested).
 */
import { sql } from "drizzle-orm";
import { boolean, check, date, index, integer, jsonb, numeric, pgEnum, pgTable, smallint, text, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import {
  B2C_STAGES,
  DATA_EXPORT_KINDS,
  DATA_EXPORT_STATUSES,
  DPIA_KEYS,
  DPIA_STATUSES,
  EXPORT_ENTITIES,
  EXTERNAL_ID_ENTITY_TYPES,
  IMPORT_ENTITY_TYPES,
  IMPORT_KINDS,
  IMPORT_ROW_STATUSES,
  IMPORT_SOURCES,
  IMPORT_STATUSES,
  IMPORTED_HISTORY_KINDS,
  IMPORTED_PRODUCT_KINDS,
  PRIVACY_KINDS,
  PRIVACY_REQUESTED_BY,
  PRIVACY_STATUSES,
  RESTRICTION_REASONS,
  type ImportMapping,
  type PrivacyReport,
  type DashboardDefinition,
  type PrivacyWarning,
} from "@beam/core/ops";
import { orders } from "./commerce";
import { persons } from "./crm";
import { files, users } from "./platform";
import { createdAt, id, timestamps, tstz } from "./_shared";

/** The APPEND tables of this module (also listed in `APPEND_ONLY_TABLES`). */
export const OPS_APPEND_ONLY = ["imported_history"] as const;

/** `'a', 'b', ...` for an `in (...)` list of constant strings. */
const sqlList = (list: readonly string[]) => sql.raw(list.map((v) => `'${v}'`).join(", "));

// ---------------------------------------------------------------------------
// Enums (ops spec 2.1)
// ---------------------------------------------------------------------------

export const personStatsB2cStage = pgEnum("person_stats_b2c_stage", B2C_STAGES);
export const importsKind = pgEnum("imports_kind", IMPORT_KINDS);
export const importsSource = pgEnum("imports_source", IMPORT_SOURCES);
export const importsStatus = pgEnum("imports_status", IMPORT_STATUSES);
export const importRowsStatus = pgEnum("import_rows_status", IMPORT_ROW_STATUSES);
export const importedHistoryKind = pgEnum("imported_history_kind", IMPORTED_HISTORY_KINDS);
export const privacyRequestsKind = pgEnum("privacy_requests_kind", PRIVACY_KINDS);
export const privacyRequestsStatus = pgEnum("privacy_requests_status", PRIVACY_STATUSES);
export const privacyRequestsRequestedBy = pgEnum("privacy_requests_requested_by", PRIVACY_REQUESTED_BY);
export const retentionPoliciesAction = pgEnum("retention_policies_action", ["anonymise", "delete", "keep"]);
export const dpiaRecordsKey = pgEnum("dpia_records_key", DPIA_KEYS);
export const dpiaRecordsStatus = pgEnum("dpia_records_status", DPIA_STATUSES);
export const dataExportsKind = pgEnum("data_exports_kind", DATA_EXPORT_KINDS);
export const dataExportsStatus = pgEnum("data_exports_status", DATA_EXPORT_STATUSES);
export const adSpendDailyPlatform = pgEnum("ad_spend_daily_platform", ["meta", "google"]);
export const attributionCreditsModel = pgEnum("attribution_credits_model", ["first_touch", "linear"]);
export const nlQuestionsStatus = pgEnum("nl_questions_status", ["answered", "refused", "error", "timeout", "budget_exceeded"]);
export const managementSummariesStatus = pgEnum("management_summaries_status", ["pending", "ready", "failed", "skipped_budget"]);

// ---------------------------------------------------------------------------
// JSON shapes
// ---------------------------------------------------------------------------

/** `imports.counts`. */
export type ImportCountsJson = Partial<Record<(typeof IMPORT_ROW_STATUSES)[number], number>>;
/** `imports.report` (`ImportReport`, row numbers and codes only; shaped by ops-P4). */
export type ImportReportJson = { mapping_hash?: string; error?: string; partial?: boolean; [key: string]: unknown };
/** `imports.reconciliation` (packages and memberships only; shaped by ops-P4). */
export type ImportReconciliationJson = Record<string, unknown>;
/** `data_exports.filters`. */
export type DataExportFiltersJson = { from?: string; to?: string; segmentId?: string };
/** `management_summaries.summary`: one markdown text per generated locale. */
export type ManagementSummaryJson = { "nl-BE"?: string; "fr-BE"?: string; en?: string };

// ---------------------------------------------------------------------------
// Person stats (V1 cache; R4 prediction columns)
// ---------------------------------------------------------------------------

export const personStats = pgTable(
  "person_stats",
  {
    id: id(),
    personId: uuid()
      .notNull()
      .references(() => persons.id, { onDelete: "cascade" }),
    revenueCents: integer().notNull().default(0),
    purchases: integer().notNull().default(0),
    visits: integer().notNull().default(0),
    visitsLast60d: integer("visits_last_60d").notNull().default(0),
    visitsPrev180d: integer("visits_prev_180d").notNull().default(0),
    eventsAttended: integer().notNull().default(0),
    noShows: integer().notNull().default(0),
    lateCancellations: integer().notNull().default(0),
    avgOrderCents: integer().notNull().default(0),
    firstPurchaseAt: tstz(),
    lastPurchaseAt: tstz(),
    firstVisitAt: tstz(),
    lastVisitAt: tstz(),
    lastActivityAt: tstz(),
    nextBookingAt: tstz(),
    b2cStage: personStatsB2cStage().notNull().default("lead"),
    b2cStageChangedAt: tstz(),
    predictedValueCents: integer(),
    churnProbability: numeric({ precision: 4, scale: 3 }),
    repurchaseProbability: numeric({ precision: 4, scale: 3 }),
    predictedAt: tstz(),
    computedAt: tstz().notNull().defaultNow(),
    ...timestamps(),
  },
  (t) => [
    unique("person_stats_person_uq").on(t.personId),
    index("person_stats_stage_idx").on(t.b2cStage),
    index("person_stats_last_visit_idx").on(t.lastVisitAt),
    index("person_stats_revenue_idx").on(t.revenueCents),
    index("person_stats_next_booking_idx").on(t.nextBookingAt),
    check("person_stats_purchases_ck", sql`${t.purchases} >= 0`),
    check("person_stats_visits_ck", sql`${t.visits} >= 0`),
    check("person_stats_counts_ck", sql`${t.visitsLast60d} >= 0 and ${t.visitsPrev180d} >= 0 and ${t.eventsAttended} >= 0 and ${t.noShows} >= 0 and ${t.lateCancellations} >= 0`),
    check("person_stats_churn_ck", sql`${t.churnProbability} is null or ${t.churnProbability} between 0 and 1`),
    check("person_stats_repurchase_ck", sql`${t.repurchaseProbability} is null or ${t.repurchaseProbability} between 0 and 1`),
  ],
);

// ---------------------------------------------------------------------------
// Imports (rules 42-53)
// ---------------------------------------------------------------------------

export const imports = pgTable(
  "imports",
  {
    id: id(),
    kind: importsKind().notNull(),
    source: importsSource().notNull(),
    name: text().notNull(),
    fileId: uuid()
      .notNull()
      .references(() => files.id),
    partFileIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    status: importsStatus().notNull().default("uploaded"),
    header: text().array().notNull().default(sql`'{}'::text[]`),
    rowCount: integer().notNull().default(0),
    mapping: jsonb().$type<ImportMapping | Record<string, never>>().notNull().default({}),
    isDryRun: boolean().notNull().default(true),
    runSeq: integer().notNull().default(0),
    counts: jsonb().$type<ImportCountsJson>().notNull().default({}),
    report: jsonb().$type<ImportReportJson>().notNull().default({}),
    reconciliation: jsonb().$type<ImportReconciliationJson>(),
    signedOffByUserId: uuid().references(() => users.id),
    signedOffAt: tstz(),
    startedAt: tstz(),
    finishedAt: tstz(),
    createdByUserId: uuid()
      .notNull()
      .references(() => users.id),
    ...timestamps(),
  },
  (t) => [
    index("imports_status_created_idx").on(t.status, t.createdAt.desc()),
    index("imports_kind_idx").on(t.kind),
    uniqueIndex("imports_one_running")
      .on(sql`(true)`)
      .where(sql`${t.status} = 'running'`),
    check("imports_name_ck", sql`char_length(${t.name}) between 1 and 120`),
    check("imports_sign_off_ck", sql`(${t.signedOffByUserId} is null) = (${t.signedOffAt} is null)`),
    check("imports_counts_ck", sql`${t.rowCount} >= 0 and ${t.runSeq} >= 0`),
  ],
);

export const importRows = pgTable(
  "import_rows",
  {
    id: id(),
    importId: uuid()
      .notNull()
      .references(() => imports.id, { onDelete: "cascade" }),
    rowNumber: integer().notNull(),
    data: jsonb().$type<Record<string, string | null>>().notNull(),
    status: importRowsStatus().notNull().default("pending"),
    dryRunStatus: importRowsStatus(),
    message: text(),
    personId: uuid().references(() => persons.id),
    entityType: text(),
    entityId: uuid(),
    ...timestamps(),
  },
  (t) => [
    unique("import_rows_import_row_uq").on(t.importId, t.rowNumber),
    index("import_rows_import_status_idx").on(t.importId, t.status),
    index("import_rows_person_idx").on(t.personId),
    check("import_rows_entity_type_ck", sql`${t.entityType} is null or ${t.entityType} in (${sqlList(IMPORT_ENTITY_TYPES)})`),
    check("import_rows_row_number_ck", sql`${t.rowNumber} >= 1`),
  ],
);

/** Old tools' ids, so re-runs are idempotent (rule 50); no FK on `entity_id` (several targets). */
export const importExternalIds = pgTable(
  "import_external_ids",
  {
    id: id(),
    source: importsSource().notNull(),
    entityType: text().notNull(),
    externalId: text().notNull(),
    entityId: uuid().notNull(),
    importId: uuid()
      .notNull()
      .references(() => imports.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique("import_external_ids_uq").on(t.source, t.entityType, t.externalId),
    index("import_external_ids_entity_idx").on(t.entityType, t.entityId),
    check("import_external_ids_entity_type_ck", sql`${t.entityType} in (${sqlList(EXTERNAL_ID_ENTITY_TYPES)})`),
  ],
);

/** APPEND: historical commercial data from the old tools that has no native row. */
export const importedHistory = pgTable(
  "imported_history",
  {
    id: id(),
    personId: uuid()
      .notNull()
      .references(() => persons.id),
    importId: uuid()
      .notNull()
      .references(() => imports.id),
    source: importsSource().notNull(),
    kind: importedHistoryKind().notNull(),
    occurredAt: tstz().notNull(),
    externalId: text().notNull(),
    description: text(),
    amountCents: integer(),
    productKind: text(),
    data: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    unique("imported_history_source_kind_external_uq").on(t.source, t.kind, t.externalId),
    index("imported_history_person_kind_idx").on(t.personId, t.kind, t.occurredAt),
    check("imported_history_product_kind_ck", sql`${t.productKind} is null or ${t.productKind} in (${sqlList(IMPORTED_PRODUCT_KINDS)})`),
  ],
);

export const cutoverChecklistItems = pgTable("cutover_checklist_items", {
  id: id(),
  key: text().notNull().unique("cutover_checklist_items_key_uq"),
  doneAt: tstz(),
  doneByUserId: uuid().references(() => users.id),
  note: text(),
  ...timestamps(),
});

// ---------------------------------------------------------------------------
// Privacy (rules 58-67)
// ---------------------------------------------------------------------------

export const privacyRequests = pgTable(
  "privacy_requests",
  {
    id: id(),
    personId: uuid()
      .notNull()
      .references(() => persons.id),
    kind: privacyRequestsKind().notNull(),
    status: privacyRequestsStatus().notNull().default("received"),
    requestedBy: privacyRequestsRequestedBy().notNull(),
    dueOn: date({ mode: "string" }).notNull(),
    verifiedAt: tstz(),
    verifiedByUserId: uuid().references(() => users.id),
    verificationNote: text(),
    scheduledForAt: tstz(),
    rectifyFields: text().array().notNull().default(sql`'{}'::text[]`),
    warnings: jsonb().$type<PrivacyWarning[]>().notNull().default([]),
    needsManualFollowup: boolean().notNull().default(false),
    runAttempt: smallint().notNull().default(1),
    report: jsonb().$type<PrivacyReport | Record<string, never>>().notNull().default({}),
    fileId: uuid().references(() => files.id),
    partFileIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    createdByUserId: uuid().references(() => users.id),
    completedAt: tstz(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("privacy_requests_open_uq")
      .on(t.personId, t.kind)
      .where(sql`${t.status} in ('received', 'verified', 'running')`),
    index("privacy_requests_status_due_idx").on(t.status, t.dueOn),
    index("privacy_requests_person_idx").on(t.personId),
    check("privacy_requests_note_ck", sql`${t.verificationNote} is null or char_length(${t.verificationNote}) <= 500`),
    check("privacy_requests_run_attempt_ck", sql`${t.runAttempt} >= 1`),
  ],
);

export const processingRestrictions = pgTable(
  "processing_restrictions",
  {
    id: id(),
    personId: uuid()
      .notNull()
      .references(() => persons.id)
      .unique("processing_restrictions_person_uq"),
    privacyRequestId: uuid().references(() => privacyRequests.id),
    reason: text().notNull().default("accuracy_contested"),
    startedByUserId: uuid().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [check("processing_restrictions_reason_ck", sql`${t.reason} in (${sqlList(RESTRICTION_REASONS)})`)],
);

export const retentionPolicies = pgTable(
  "retention_policies",
  {
    id: id(),
    key: text().notNull().unique("retention_policies_key_uq"),
    tableName: text().notNull(),
    days: integer(),
    action: retentionPoliciesAction().notNull(),
    description: text().notNull(),
    runOrder: smallint().notNull().default(100),
    batchSize: integer().notNull().default(1000),
    isActive: boolean().notNull().default(true),
    lastRunAt: tstz(),
    lastRunRows: integer(),
    lastRunStatus: text(),
    updatedByUserId: uuid().references(() => users.id),
    ...timestamps(),
  },
  (t) => [
    check("retention_policies_key_ck", sql`${t.key} ~ '^[a-z]+\\.[a-z][a-z0-9_]*$'`),
    check("retention_policies_days_ck", sql`(${t.action} = 'keep') = (${t.days} is null) and (${t.days} is null or ${t.days} >= 1)`),
    check("retention_policies_batch_ck", sql`${t.batchSize} >= 1`),
    check("retention_policies_status_ck", sql`${t.lastRunStatus} is null or ${t.lastRunStatus} in ('ok', 'no_handler', 'error')`),
    index("retention_policies_order_idx").on(t.runOrder),
  ],
);

export const dpiaRecords = pgTable("dpia_records", {
  id: id(),
  key: dpiaRecordsKey().notNull().unique("dpia_records_key_uq"),
  status: dpiaRecordsStatus().notNull().default("not_started"),
  purpose: text(),
  risks: text(),
  measures: text(),
  decisionNote: text(),
  documentFileId: uuid().references(() => files.id),
  reviewedByUserId: uuid().references(() => users.id),
  reviewedAt: tstz(),
  ...timestamps(),
});

export const dataExports = pgTable(
  "data_exports",
  {
    id: id(),
    kind: dataExportsKind().notNull(),
    entity: text(),
    filters: jsonb().$type<DataExportFiltersJson>().notNull().default({}),
    status: dataExportsStatus().notNull().default("queued"),
    partFileIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    rowCount: integer().notNull().default(0),
    cursor: jsonb().$type<Record<string, unknown>>(),
    createdByUserId: uuid()
      .notNull()
      .references(() => users.id),
    completedAt: tstz(),
    expiresAt: tstz(),
    ...timestamps(),
  },
  (t) => [
    index("data_exports_creator_idx").on(t.createdByUserId, t.createdAt.desc()),
    check("data_exports_entity_ck", sql`(${t.kind} = 'entity') = (${t.entity} is not null)`),
    check("data_exports_entity_list_ck", sql`${t.entity} is null or ${t.entity} in (${sqlList(EXPORT_ENTITIES)})`),
    check("data_exports_row_count_ck", sql`${t.rowCount} >= 0`),
  ],
);

// ---------------------------------------------------------------------------
// Retention lists (R2)
// ---------------------------------------------------------------------------

export const retentionLists = pgTable("retention_lists", {
  id: id(),
  weekStartOn: date({ mode: "string" }).notNull().unique("retention_lists_week_uq"),
  size: smallint().notNull(),
  thresholds: jsonb().$type<Record<string, unknown>>().notNull(),
  generatedAt: tstz().notNull(),
  ...timestamps(),
});

export const retentionListItems = pgTable(
  "retention_list_items",
  {
    id: id(),
    listId: uuid()
      .notNull()
      .references(() => retentionLists.id, { onDelete: "cascade" }),
    rank: smallint().notNull(),
    personId: uuid()
      .notNull()
      .references(() => persons.id),
    score: integer().notNull(),
    primaryReason: text().notNull(),
    reasons: text().array().notNull(),
    detail: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    // FK to crm `tasks.id` once crm has created `tasks` (not in BASE).
    taskId: uuid(),
    actionedAt: tstz(),
    actionedByUserId: uuid().references(() => users.id),
    dismissedAt: tstz(),
    dismissReason: text(),
    ...timestamps(),
  },
  (t) => [
    unique("retention_list_items_person_uq").on(t.listId, t.personId),
    unique("retention_list_items_rank_uq").on(t.listId, t.rank),
    index("retention_list_items_person_idx").on(t.personId),
    check("retention_list_items_rank_ck", sql`${t.rank} between 1 and 100`),
  ],
);

// ---------------------------------------------------------------------------
// Ads and attribution (R3)
// ---------------------------------------------------------------------------

export const adSpendDaily = pgTable(
  "ad_spend_daily",
  {
    id: id(),
    platform: adSpendDailyPlatform().notNull(),
    accountId: text().notNull(),
    campaignExternalId: text().notNull(),
    campaignName: text().notNull(),
    dayOn: date({ mode: "string" }).notNull(),
    spendCents: integer().notNull(),
    impressions: integer().notNull().default(0),
    clicks: integer().notNull().default(0),
    leads: integer().notNull().default(0),
    currency: text().notNull().default("EUR"),
    raw: jsonb().$type<Record<string, unknown>>().notNull(),
    pulledAt: tstz().notNull(),
    ...timestamps(),
  },
  (t) => [
    unique("ad_spend_daily_uq").on(t.platform, t.campaignExternalId, t.dayOn),
    index("ad_spend_daily_day_idx").on(t.dayOn),
    check("ad_spend_daily_amounts_ck", sql`${t.spendCents} >= 0 and ${t.impressions} >= 0 and ${t.clicks} >= 0 and ${t.leads} >= 0`),
    check("ad_spend_daily_currency_ck", sql`${t.currency} = 'EUR'`),
  ],
);

export const attributionCredits = pgTable(
  "attribution_credits",
  {
    id: id(),
    orderId: uuid()
      .notNull()
      .references(() => orders.id),
    personId: uuid()
      .notNull()
      .references(() => persons.id),
    model: attributionCreditsModel().notNull(),
    campaignKey: text().notNull(),
    source: text(),
    medium: text(),
    campaign: text(),
    weight: numeric({ precision: 5, scale: 4 }).notNull(),
    revenueCents: integer().notNull(),
    paidAt: tstz().notNull(),
    computedAt: tstz().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("attribution_credits_uq").on(t.orderId, t.model, t.campaignKey),
    index("attribution_credits_campaign_idx").on(t.campaignKey, t.paidAt),
    index("attribution_credits_person_idx").on(t.personId),
    check("attribution_credits_weight_ck", sql`${t.weight} > 0 and ${t.weight} <= 1`),
  ],
);

// ---------------------------------------------------------------------------
// Dashboards and AI (R4)
// ---------------------------------------------------------------------------

export const dashboards = pgTable(
  "dashboards",
  {
    id: id(),
    name: text().notNull(),
    ownerUserId: uuid()
      .notNull()
      .references(() => users.id),
    definition: jsonb().$type<DashboardDefinition>().notNull(),
    isShared: boolean().notNull().default(false),
    ...timestamps(),
  },
  (t) => [index("dashboards_owner_idx").on(t.ownerUserId), check("dashboards_name_ck", sql`char_length(${t.name}) between 1 and 120`)],
);

export const nlQuestions = pgTable(
  "nl_questions",
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    question: text().notNull(),
    generatedSql: text(),
    status: nlQuestionsStatus().notNull(),
    rowCount: integer(),
    columns: text().array().notNull().default(sql`'{}'::text[]`),
    explanation: text(),
    aiRequestIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    durationMs: integer(),
    ...timestamps(),
  },
  (t) => [index("nl_questions_user_idx").on(t.userId, t.createdAt.desc()), check("nl_questions_question_ck", sql`char_length(${t.question}) <= 500`)],
);

export const managementSummaries = pgTable("management_summaries", {
  id: id(),
  weekStartOn: date({ mode: "string" }).notNull().unique("management_summaries_week_uq"),
  kpis: jsonb().$type<Record<string, unknown>>().notNull(),
  summary: jsonb().$type<ManagementSummaryJson>().notNull(),
  status: managementSummariesStatus().notNull().default("pending"),
  batchId: text(),
  aiRequestIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
  ...timestamps(),
});

/** Small keyed state: `stats_cursor`, `digest_last_sent_on`. */
export const opsState = pgTable("ops_state", {
  key: text().primaryKey(),
  value: jsonb().$type<unknown>().notNull(),
  updatedAt: tstz().notNull().defaultNow(),
});
