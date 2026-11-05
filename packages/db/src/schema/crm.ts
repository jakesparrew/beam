/**
 * crm tables (crm spec section 2). Wave 0 (platform-P2) created `persons`, `consent_records`,
 * `suppressions` and `activity_events` with their architecture columns; crm-P1 adds the ADD
 * columns to them (expand only) and creates every other V1 table. R3 tables (`opportunities`,
 * `playbook_stages`, inbox) are added by crm-P8 and crm-P9 (`inbox_threads`, `inbox_messages`,
 * `inbox_reply_templates`); R4 crm-P10 adds the AI draft columns and `support_knowledge_articles`.
 *
 * APPEND tables (`reject_update_delete()` trigger, listed in `APPEND_ONLY_TABLES`):
 * `activity_events`, `consent_records`, `suppressions`, `person_merges`, `person_declarations`.
 * `consent_wordings` is IMMUTABLE once published (service rule, `IMMUTABLE_TABLES`).
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  index,
  inet,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import {
  bytea,
  createdAt,
  id,
  localeEnum,
  localized,
  sensitive,
  timestamps,
  tstz,
  type ActorJson,
  type LocalizedText,
} from "./_shared";
import { emailMessages } from "./email";
import { aiRequests, users } from "./platform";

/** `tsvector` (read-only generated column). */
const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const personsPreferredChannel = pgEnum("persons_preferred_channel", [
  "email",
  "phone",
  "whatsapp",
]);
export const personsStatusOverride = pgEnum("persons_status_override", [
  "lead",
  "customer",
  "member",
]);
export const consentRecordsPurpose = pgEnum("consent_records_purpose", [
  "newsletter",
  "events",
  "member_comms",
  "b2b",
  "assessment_result",
  "sensitive_processing",
  "ai_processing",
]);
export const consentRecordsStatus = pgEnum("consent_records_status", [
  "granted",
  "withdrawn",
]);
export const consentRecordsMethod = pgEnum("consent_records_method", [
  "form",
  "portal",
  "import",
  "staff",
  "preference_centre",
  "unsubscribe_link",
  "complaint",
]);
export const consentRecordsLawfulBasis = pgEnum(
  "consent_records_lawful_basis",
  ["consent", "legitimate_interest"],
);
export const suppressionsScope = pgEnum("suppressions_scope", [
  "all",
  "newsletter",
  "events",
  "member_comms",
  "b2b",
]);
export const suppressionsReason = pgEnum("suppressions_reason", [
  "unsubscribe",
  "hard_bounce",
  "complaint",
  "manual",
  "erased",
]);
export const activityEventsMode = pgEnum("activity_events_mode", [
  "live",
  "replay",
  "on_demand",
]);
export const personDuplicateCandidatesStatus = pgEnum(
  "person_duplicate_candidates_status",
  ["open", "merged", "dismissed"],
);
export const personSensitiveFieldsKey = pgEnum("person_sensitive_fields_key", [
  "health_note",
  "sleep",
  "stress",
  "recovery",
  "wellbeing",
  "medical",
]);
export const personDeclarationsKind = pgEnum("person_declarations_kind", [
  "guardian_consent",
]);
export const personDeclarationsStatus = pgEnum("person_declarations_status", [
  "accepted",
  "revoked",
]);
export const personDeclarationsMethod = pgEnum("person_declarations_method", [
  "portal",
  "reception",
  "form",
  "import",
]);
export const personTagsSource = pgEnum("person_tags_source", [
  "manual",
  "automation",
  "import",
  "form",
]);
export const segmentsKind = pgEnum("segments_kind", ["dynamic", "static"]);
export const segmentMembersSource = pgEnum("segment_members_source", [
  "rule",
  "manual",
]);
export const tasksKind = pgEnum("tasks_kind", [
  "call",
  "follow_up",
  "payment",
  "proposal",
  "review",
  "other",
]);
export const tasksPriority = pgEnum("tasks_priority", ["low", "normal", "high"]);
export const tasksStatus = pgEnum("tasks_status", ["open", "done", "cancelled"]);
export const tasksSource = pgEnum("tasks_source", [
  "manual",
  "automation",
  "retention",
  "system",
]);
export const companiesSize = pgEnum("companies_size", [
  "1_9",
  "10_49",
  "50_249",
  "250_plus",
]);
export const companiesStatus = pgEnum("companies_status", [
  "target",
  "prospect",
  "customer",
  "partner",
  "inactive",
]);
export const companyContactsDecisionRole = pgEnum(
  "company_contacts_decision_role",
  ["decision_maker", "influencer", "user", "gatekeeper"],
);

/** R3 (crm-P8): the B2B pipeline stages in board order (rule 3.47). */
export const OPPORTUNITY_STAGES = [
  "target",
  "prospect_identified",
  "contact_identified",
  "outreach",
  "response",
  "qualified",
  "discovery",
  "proposal",
  "negotiation",
  "won",
  "lost",
  "account_management",
  "renewal",
] as const;
export type OpportunityStage = (typeof OPPORTUNITY_STAGES)[number];
export const opportunitiesStage = pgEnum("opportunities_stage", OPPORTUNITY_STAGES);
export const PLAYBOOK_PIPELINES = ["b2b", "b2c"] as const;
export type PlaybookPipeline = (typeof PLAYBOOK_PIPELINES)[number];
export const playbookStagesPipeline = pgEnum("playbook_stages_pipeline", PLAYBOOK_PIPELINES);
export const INBOX_CHANNELS = ["email", "instagram", "messenger", "form"] as const;
export type InboxChannel = (typeof INBOX_CHANNELS)[number];
export const inboxThreadsChannel = pgEnum("inbox_threads_channel", INBOX_CHANNELS);
export const INBOX_THREAD_STATUSES = ["open", "pending", "resolved"] as const;
export type InboxThreadStatus = (typeof INBOX_THREAD_STATUSES)[number];
export const inboxThreadsStatus = pgEnum("inbox_threads_status", INBOX_THREAD_STATUSES);
export const INBOX_MESSAGE_DIRECTIONS = ["in", "out", "note"] as const;
export type InboxMessageDirection = (typeof INBOX_MESSAGE_DIRECTIONS)[number];
export const inboxMessagesDirection = pgEnum("inbox_messages_direction", INBOX_MESSAGE_DIRECTIONS);
/** R4 (crm-P10): the AI draft of an inbound message (rules 3.51, 3.58). */
export const INBOX_AI_DRAFT_STATUSES = ["none", "pending", "ready", "blocked_sensitive", "failed", "used", "discarded"] as const;
export type InboxAiDraftStatus = (typeof INBOX_AI_DRAFT_STATUSES)[number];
export const inboxMessagesAiDraftStatus = pgEnum("inbox_messages_ai_draft_status", INBOX_AI_DRAFT_STATUSES);

// ---------------------------------------------------------------------------
// JSON shapes (Zod schemas live in `@beam/core/crm`)
// ---------------------------------------------------------------------------

/** `PostalAddress` of `packages/core/src/crm/types.ts`. */
export type PostalAddressJson = {
  street?: string;
  number?: string;
  box?: string;
  postal_code?: string;
  city?: string;
  country: string;
};

/** `Acquisition` (written once at creation; Zod `AcquisitionSchema` lives in core). */
export type AcquisitionJson = {
  source?: string;
  captured_at?: string;
} & Record<string, unknown>;

/** `persons.emergency_contact`. */
export type EmergencyContactJson = {
  name: string;
  phone: string;
  relation?: string;
};

/** `persons.external_ids` (D13's seven import sources plus R3 `meta_psid`). */
export type ExternalIdsJson = Partial<
  Record<
    | "simplybook"
    | "mailchimp"
    | "lightspeed"
    | "webinargeek"
    | "typeform"
    | "scoreapp"
    | "sheet"
    | "meta_psid",
    string
  >
>;

/** `segments.definition`: a `SegmentRule` of `@beam/core/crm` (validated by `SegmentRuleSchema`). */
export type SegmentRuleJson = Record<string, unknown>;

/** R3 `playbook_stages.automated_communication`. */
export type PlaybookAutomatedCommunicationJson = { automation_slug?: string; template_slug?: string };
/** R3 `playbook_stages.escalation` (rule 3.48). */
export type PlaybookEscalationJson = { after_days?: number; notify_role?: string; create_task?: boolean };
/** R3 `playbook_stages.kpi`. */
export type PlaybookKpiJson = { name?: LocalizedText; target?: number; unit?: "count" | "pct" | "cents" | "days" };

// ---------------------------------------------------------------------------
// 2.1 persons
// ---------------------------------------------------------------------------

export const persons = pgTable(
  "persons",
  {
    id: id(),
    customerNumber: bigint({ mode: "number" })
      .notNull()
      .generatedAlwaysAsIdentity()
      .unique("persons_customer_number_unique"),
    email: text(),
    emailHash: text(),
    phone: text(),
    phoneE164: text("phone_e164"),
    firstName: text(),
    lastName: text(),
    locale: localeEnum().notNull().default("nl-BE"),
    address: jsonb().$type<PostalAddressJson>(),
    birthOn: date(),
    preferredChannel: personsPreferredChannel(),
    linkedinUrl: text(),
    emergencyContact: jsonb().$type<EmergencyContactJson>(),
    statusOverride: personsStatusOverride(),
    statusOverrideReason: text(),
    statusOverrideByUserId: uuid().references((): AnyPgColumn => users.id),
    statusOverrideAt: tstz(),
    acquisition: jsonb().$type<AcquisitionJson>().notNull().default({}),
    partnerCompanyId: uuid().references((): AnyPgColumn => companies.id, {
      onDelete: "set null",
    }),
    externalIds: jsonb().$type<ExternalIdsJson>().notNull().default({}),
    isTester: boolean().notNull().default(false),
    processingRestrictedAt: tstz(),
    mergedIntoPersonId: uuid().references((): AnyPgColumn => persons.id),
    erasedAt: tstz(),
    searchTsv: tsvector("search_tsv")
      .notNull()
      .generatedAlwaysAs(
        sql`to_tsvector('simple', coalesce(first_name, '') || ' ' || coalesce(last_name, '') || ' ' || coalesce(email, '') || ' ' || coalesce(phone_e164, ''))`,
      ),
    version: integer().notNull().default(1),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("persons_email_active_uq")
      .on(sql`lower(${t.email})`)
      .where(sql`${t.erasedAt} is null and ${t.mergedIntoPersonId} is null`),
    index("persons_email_idx").on(sql`lower(${t.email})`),
    index("persons_email_hash_idx").on(t.emailHash),
    index("persons_phone_idx").on(t.phoneE164),
    index("persons_name_idx").on(
      sql`lower(${t.lastName})`,
      sql`lower(${t.firstName})`,
    ),
    index("persons_search_gin").using("gin", t.searchTsv),
    index("persons_external_ids_gin").using(
      "gin",
      t.externalIds.op("jsonb_path_ops"),
    ),
    index("persons_merged_into_idx")
      .on(t.mergedIntoPersonId)
      .where(sql`${t.mergedIntoPersonId} is not null`),
    index("persons_partner_company_idx").on(t.partnerCompanyId),
    check(
      "persons_email_ck",
      sql`${t.email} ~ '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$'`,
    ),
    check(
      "persons_phone_e164_ck",
      sql`${t.phoneE164} ~ '^\\+[1-9][0-9]{6,14}$'`,
    ),
    check(
      "persons_name_length_ck",
      sql`(${t.firstName} is null or char_length(${t.firstName}) <= 100) and (${t.lastName} is null or char_length(${t.lastName}) <= 100)`,
    ),
    check("persons_birth_on_ck", sql`${t.birthOn} > '1900-01-01'`),
    check(
      "persons_status_override_reason_ck",
      sql`${t.statusOverride} is null or ${t.statusOverrideReason} is not null`,
    ),
    check("persons_merged_into_ck", sql`${t.mergedIntoPersonId} <> ${t.id}`),
  ],
);

// ---------------------------------------------------------------------------
// 2.2 identity history and sensitive data
// ---------------------------------------------------------------------------

/** APPEND. One row per merge; a person is merged (as loser) once. */
export const personMerges = pgTable(
  "person_merges",
  {
    id: id(),
    winnerPersonId: uuid()
      .notNull()
      .references(() => persons.id),
    loserPersonId: uuid()
      .notNull()
      .references(() => persons.id)
      .unique("person_merges_loser_person_id_unique"),
    loserSnapshot: jsonb().$type<Record<string, unknown>>().notNull(),
    fieldChoices: jsonb()
      .$type<Record<string, "winner" | "loser">>()
      .notNull()
      .default({}),
    repointed: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    mergedByUserId: uuid()
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    index("person_merges_winner_idx").on(t.winnerPersonId),
    check(
      "person_merges_distinct_ck",
      sql`${t.winnerPersonId} <> ${t.loserPersonId}`,
    ),
  ],
);

export const personDuplicateCandidates = pgTable(
  "person_duplicate_candidates",
  {
    id: id(),
    personAId: uuid()
      .notNull()
      .references(() => persons.id),
    personBId: uuid()
      .notNull()
      .references(() => persons.id),
    score: smallint().notNull(),
    reasons: text().array().notNull(),
    status: personDuplicateCandidatesStatus().notNull().default("open"),
    reviewedByUserId: uuid().references(() => users.id),
    reviewedAt: tstz(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("person_duplicate_candidates_pair_uq").on(
      t.personAId,
      t.personBId,
    ),
    index("person_duplicate_candidates_status_score_idx").on(
      t.status,
      t.score.desc(),
    ),
    index("person_duplicate_candidates_person_b_idx").on(t.personBId),
    check(
      "person_duplicate_candidates_order_ck",
      sql`${t.personAId} < ${t.personBId}`,
    ),
    check(
      "person_duplicate_candidates_score_ck",
      sql`${t.score} between 0 and 100`,
    ),
    check(
      "person_duplicate_candidates_reasons_ck",
      sql`${t.reasons} <@ array['email_variant','phone','name_birth','name_postal','external_id']::text[]`,
    ),
  ],
);

/** SENSITIVE `value_enc` (AES-256-GCM, aad `person_sensitive_fields:<person_id>:<key>`). */
export const personSensitiveFields = pgTable(
  "person_sensitive_fields",
  {
    id: id(),
    personId: uuid()
      .notNull()
      .references(() => persons.id, { onDelete: "cascade" }),
    key: personSensitiveFieldsKey().notNull(),
    valueEnc: sensitive(bytea("value_enc").notNull(), {
      table: "person_sensitive_fields",
      keyColumn: "key_version",
    }),
    keyVersion: smallint().notNull().default(1),
    updatedByUserId: uuid().references(() => users.id),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("person_sensitive_fields_person_key_uq").on(t.personId, t.key),
  ],
);

/** APPEND. Guardian consent for minors (cross-module D15); `document_version_id` has no FK. */
export const personDeclarations = pgTable(
  "person_declarations",
  {
    id: id(),
    personId: uuid()
      .notNull()
      .references(() => persons.id),
    kind: personDeclarationsKind().notNull(),
    documentVersionId: uuid().notNull(),
    documentVersion: integer().notNull(),
    status: personDeclarationsStatus().notNull().default("accepted"),
    method: personDeclarationsMethod().notNull(),
    acceptedAt: tstz().notNull().defaultNow(),
    expiresAt: tstz(),
    guardianPersonId: uuid().references(() => persons.id),
    ip: inet(),
    actor: jsonb().$type<ActorJson>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("person_declarations_person_kind_idx").on(
      t.personId,
      t.kind,
      t.acceptedAt.desc(),
    ),
    index("person_declarations_guardian_idx")
      .on(t.guardianPersonId)
      .where(sql`${t.guardianPersonId} is not null`),
    check(
      "person_declarations_guardian_ck",
      sql`${t.kind} <> 'guardian_consent' or ${t.guardianPersonId} is not null`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// 2.3 consent and suppression
// ---------------------------------------------------------------------------

/** APPEND. */
export const consentRecords = pgTable(
  "consent_records",
  {
    id: id(),
    personId: uuid()
      .notNull()
      .references(() => persons.id, { onDelete: "restrict" }),
    purpose: consentRecordsPurpose().notNull(),
    status: consentRecordsStatus().notNull(),
    lawfulBasis: consentRecordsLawfulBasis().notNull().default("consent"),
    source: text().notNull(),
    method: consentRecordsMethod().notNull(),
    wordingVersion: text().notNull(),
    ip: inet(),
    userAgent: text(),
    recordedAt: tstz().notNull().defaultNow(),
    actor: jsonb().$type<ActorJson>().notNull(),
    refType: text(),
    refId: text(),
    copiedFromRecordId: uuid().references((): AnyPgColumn => consentRecords.id),
    createdAt: createdAt(),
  },
  (t) => [
    index("consent_records_person_purpose_idx").on(
      t.personId,
      t.purpose,
      t.recordedAt.desc(),
      t.id.desc(),
    ),
  ],
);

/** IMMUTABLE once published. `wording_version` strings point to `<purpose>@<version>`. */
export const consentWordings = pgTable(
  "consent_wordings",
  {
    id: id(),
    purpose: consentRecordsPurpose().notNull(),
    version: integer().notNull(),
    text: localized().notNull(),
    publishedAt: tstz(),
    createdByUserId: uuid().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("consent_wordings_purpose_version_uq").on(
      t.purpose,
      t.version,
    ),
    check("consent_wordings_version_ck", sql`${t.version} >= 1`),
  ],
);

/** APPEND. Keyed by address, not by person. */
export const suppressions = pgTable(
  "suppressions",
  {
    id: id(),
    emailHash: text().notNull(),
    email: text(),
    scope: suppressionsScope().notNull(),
    reason: suppressionsReason().notNull(),
    source: text().notNull(),
    personId: uuid().references(() => persons.id, { onDelete: "set null" }),
    actor: jsonb().$type<ActorJson>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("suppressions_email_hash_scope_uq").on(t.emailHash, t.scope),
    index("suppressions_person_idx").on(t.personId),
  ],
);

// ---------------------------------------------------------------------------
// 2.4 timeline
// ---------------------------------------------------------------------------

/** APPEND. `data` is SENSITIVE (`{ body_enc, key_version }`) on rows with `is_sensitive`. */
export const activityEvents = pgTable(
  "activity_events",
  {
    id: bigint({ mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
    personId: uuid().references(() => persons.id, { onDelete: "restrict" }),
    companyId: uuid().references((): AnyPgColumn => companies.id),
    kind: text().notNull(),
    occurredAt: tstz().notNull().defaultNow(),
    mode: activityEventsMode(),
    isSensitive: boolean().notNull().default(false),
    actor: jsonb().$type<ActorJson>().notNull(),
    refType: text(),
    refId: text(),
    data: sensitive(jsonb("data").notNull().default({}), {
      table: "activity_events",
      keyColumn: "data.key_version",
    }),
    dedupeKey: text().unique("activity_events_dedupe_key_unique"),
    createdAt: createdAt(),
  },
  (t) => [
    index("activity_events_person_idx").on(
      t.personId,
      t.occurredAt.desc(),
      t.id.desc(),
    ),
    index("activity_events_company_idx")
      .on(t.companyId, t.occurredAt.desc(), t.id.desc())
      .where(sql`${t.companyId} is not null`),
    index("activity_events_kind_idx").on(t.kind, t.occurredAt.desc()),
    index("activity_events_ref_idx").on(t.refType, t.refId),
    check(
      "activity_events_subject_ck",
      sql`${t.personId} is not null or ${t.companyId} is not null`,
    ),
    check("activity_events_kind_ck", sql`${t.kind} ~ '^[a-z_]+\\.[a-z_]+$'`),
  ],
);

// ---------------------------------------------------------------------------
// 2.5 tags and segments
// ---------------------------------------------------------------------------

/** Interests are tags with key prefix `interest:`; system tags (`vip`) cannot be deleted. */
export const tags = pgTable(
  "tags",
  {
    id: id(),
    key: text().notNull().unique("tags_key_unique"),
    name: localized().notNull(),
    color: text().notNull().default("#64748b"),
    description: text(),
    isSystem: boolean().notNull().default(false),
    ...timestamps(),
  },
  (t) => [
    check("tags_key_ck", sql`${t.key} ~ '^[a-z0-9][a-z0-9_:-]{1,62}$'`),
    check("tags_color_ck", sql`${t.color} ~ '^#[0-9a-f]{6}$'`),
  ],
);

export const personTags = pgTable(
  "person_tags",
  {
    id: id(),
    personId: uuid()
      .notNull()
      .references(() => persons.id, { onDelete: "cascade" }),
    tagId: uuid()
      .notNull()
      .references(() => tags.id, { onDelete: "restrict" }),
    source: personTagsSource().notNull(),
    addedBy: jsonb().$type<ActorJson>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("person_tags_person_tag_uq").on(t.personId, t.tagId),
    index("person_tags_tag_idx").on(t.tagId),
  ],
);

export const segments = pgTable(
  "segments",
  {
    id: id(),
    name: text().notNull(),
    description: text(),
    kind: segmentsKind().notNull(),
    definition: jsonb()
      .$type<SegmentRuleJson>()
      .notNull()
      .default({ op: "and", rules: [] }),
    excludeSegmentIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    isArchived: boolean().notNull().default(false),
    refreshError: text(),
    lastCount: integer(),
    lastCountedAt: tstz(),
    createdByUserId: uuid().references(() => users.id),
    ...timestamps(),
  },
  (t) => [
    check(
      "segments_no_self_exclusion_ck",
      sql`not (${t.id} = any(${t.excludeSegmentIds}))`,
    ),
    check(
      "segments_name_ck",
      sql`char_length(${t.name}) between 1 and 200`,
    ),
  ],
);

/** The raw member set (rule result or manual list); exclusions apply at read time. */
export const segmentMembers = pgTable(
  "segment_members",
  {
    segmentId: uuid()
      .notNull()
      .references(() => segments.id, { onDelete: "cascade" }),
    personId: uuid()
      .notNull()
      .references(() => persons.id, { onDelete: "cascade" }),
    source: segmentMembersSource().notNull(),
    computedAt: tstz().notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.segmentId, t.personId] }),
    index("segment_members_person_idx").on(t.personId),
  ],
);

// ---------------------------------------------------------------------------
// 2.6 tasks (`opportunity_id` added in R3 by crm-P8)
// ---------------------------------------------------------------------------

export const tasks = pgTable(
  "tasks",
  {
    id: id(),
    ownerUserId: uuid()
      .notNull()
      .references(() => users.id),
    personId: uuid().references(() => persons.id),
    companyId: uuid().references((): AnyPgColumn => companies.id),
    /** R3: the opportunity a playbook or escalation task belongs to. */
    opportunityId: uuid().references((): AnyPgColumn => opportunities.id, { onDelete: "set null" }),
    title: text().notNull(),
    kind: tasksKind().notNull(),
    dueAt: tstz(),
    priority: tasksPriority().notNull().default("normal"),
    status: tasksStatus().notNull().default("open"),
    source: tasksSource().notNull().default("manual"),
    refType: text(),
    refId: text(),
    notes: text(),
    doneAt: tstz(),
    doneByUserId: uuid().references(() => users.id),
    createdBy: jsonb().$type<ActorJson>().notNull(),
    dedupeKey: text().unique("tasks_dedupe_key_unique"),
    ...timestamps(),
  },
  (t) => [
    index("tasks_owner_status_due_idx").on(t.ownerUserId, t.status, t.dueAt),
    index("tasks_person_idx").on(t.personId),
    index("tasks_company_idx").on(t.companyId),
    index("tasks_opportunity_idx").on(t.opportunityId),
    index("tasks_open_due_idx")
      .on(t.dueAt)
      .where(sql`${t.status} = 'open'`),
    check(
      "tasks_title_ck",
      sql`char_length(${t.title}) between 1 and 200`,
    ),
    check(
      "tasks_done_at_ck",
      sql`(${t.status} = 'done') = (${t.doneAt} is not null)`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// 2.7 companies
// ---------------------------------------------------------------------------

export const companies = pgTable(
  "companies",
  {
    id: id(),
    name: text().notNull(),
    vatNumber: text(),
    address: jsonb().$type<PostalAddressJson>(),
    website: text(),
    industry: text(),
    size: companiesSize(),
    status: companiesStatus().notNull().default("target"),
    ownerUserId: uuid().references(() => users.id),
    notes: text(),
    isPartner: boolean().notNull().default(false),
    partnerCommissionPct: numeric({ precision: 5, scale: 2 }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("companies_vat_number_uq")
      .on(t.vatNumber)
      .where(sql`${t.vatNumber} is not null`),
    index("companies_name_idx").on(sql`lower(${t.name})`),
    check(
      "companies_vat_number_ck",
      sql`${t.vatNumber} ~ '^[A-Z]{2}[0-9A-Z]{2,12}$'`,
    ),
    check(
      "companies_partner_commission_ck",
      sql`${t.partnerCommissionPct} between 0 and 100`,
    ),
    check(
      "companies_name_ck",
      sql`char_length(${t.name}) between 1 and 200`,
    ),
  ],
);

/** One person can be a B2C customer and a B2B contact; `ended_on` keeps history. */
export const companyContacts = pgTable(
  "company_contacts",
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    personId: uuid()
      .notNull()
      .references(() => persons.id, { onDelete: "restrict" }),
    position: text(),
    decisionRole: companyContactsDecisionRole(),
    relationship: text(),
    isPrimary: boolean().notNull().default(false),
    endedOn: date(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("company_contacts_company_person_uq").on(
      t.companyId,
      t.personId,
    ),
    uniqueIndex("company_contacts_primary_uq")
      .on(t.companyId)
      .where(sql`${t.isPrimary} and ${t.endedOn} is null`),
    index("company_contacts_person_idx").on(t.personId),
  ],
);

// ---------------------------------------------------------------------------
// 2.8 Release 3: B2B pipeline and sales playbook (crm-P8)
// ---------------------------------------------------------------------------

/**
 * A B2B deal with a company (rules 3.46 to 3.48). `version` guards concurrent moves.
 * `probability_set_manually_at` (ADD, crm-P8) records a hand-set probability: when it is at or
 * after `stage_entered_at`, staff changed the probability on the current stage and the next
 * stage change keeps it instead of applying the playbook default (rule 3.46).
 */
export const opportunities = pgTable(
  "opportunities",
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    title: text().notNull(),
    primaryContactPersonId: uuid().references(() => persons.id),
    stage: opportunitiesStage().notNull().default("target"),
    stageEnteredAt: tstz().notNull().defaultNow(),
    valueCents: integer().notNull().default(0),
    probabilityPct: smallint().notNull().default(10),
    probabilitySetManuallyAt: tstz(),
    expectedCloseOn: date(),
    ownerUserId: uuid()
      .notNull()
      .references(() => users.id),
    nextAction: text(),
    nextActionAt: tstz(),
    lostReason: text(),
    wonAt: tstz(),
    lostAt: tstz(),
    source: text(),
    notes: text(),
    version: integer().notNull().default(1),
    ...timestamps(),
  },
  (t) => [
    index("opportunities_stage_idx").on(t.stage),
    index("opportunities_owner_idx").on(t.ownerUserId),
    index("opportunities_company_idx").on(t.companyId),
    index("opportunities_contact_idx").on(t.primaryContactPersonId),
    check("opportunities_value_ck", sql`${t.valueCents} >= 0`),
    check("opportunities_probability_ck", sql`${t.probabilityPct} between 0 and 100`),
    check("opportunities_lost_reason_ck", sql`${t.stage} <> 'lost' or ${t.lostReason} is not null`),
    check("opportunities_title_ck", sql`char_length(${t.title}) between 1 and 200`),
  ],
);

/**
 * Sales playbook stage definitions for the B2B (`opportunities_stage`) and B2C (ops'
 * `person_stats.b2c_stage`) pipelines. No person data (`NO_PII_TABLES`).
 */
export const playbookStages = pgTable(
  "playbook_stages",
  {
    id: id(),
    pipeline: playbookStagesPipeline().notNull(),
    stageKey: text().notNull(),
    sortOrder: smallint().notNull(),
    name: localized().notNull(),
    requiredAction: localized().notNull(),
    ownerRole: text().notNull(),
    deadlineDays: smallint().notNull().default(3),
    defaultProbabilityPct: smallint(),
    automatedCommunication: jsonb().$type<PlaybookAutomatedCommunicationJson>().notNull().default({}),
    humanCommunication: localized(),
    escalation: jsonb().$type<PlaybookEscalationJson>().notNull().default({}),
    kpi: jsonb().$type<PlaybookKpiJson>().notNull().default({}),
    isActive: boolean().notNull().default(true),
    updatedByUserId: uuid().references(() => users.id),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("playbook_stages_pipeline_stage_uq").on(t.pipeline, t.stageKey),
    check("playbook_stages_deadline_ck", sql`${t.deadlineDays} between 0 and 365`),
    check(
      "playbook_stages_probability_ck",
      sql`${t.defaultProbabilityPct} is null or (${t.pipeline} = 'b2b' and ${t.defaultProbabilityPct} between 0 and 100)`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// 2.8 Release 3: unified inbox (crm-P9)
// ---------------------------------------------------------------------------

/**
 * One conversation per channel and external thread id (rules 3.49, 3.50, 3.57): the root
 * Message-ID of an email thread, the sender PSID of a Meta thread, null for a web-form thread.
 * `from_address` is the sender's email address or Meta sender id. `last_inbound_at` (ADD,
 * crm-P9) is the newest inbound message: the Meta 24-hour window and the stale rule read it.
 */
export const inboxThreads = pgTable(
  "inbox_threads",
  {
    id: id(),
    channel: inboxThreadsChannel().notNull(),
    externalThreadId: text(),
    personId: uuid().references(() => persons.id),
    companyId: uuid().references(() => companies.id),
    fromAddress: text(),
    fromName: text(),
    status: inboxThreadsStatus().notNull().default("open"),
    assigneeUserId: uuid().references(() => users.id),
    subject: text(),
    lastMessageAt: tstz().notNull(),
    lastInboundAt: tstz(),
    firstResponseAt: tstz(),
    resolvedAt: tstz(),
    escalatedAt: tstz(),
    isSensitive: boolean().notNull().default(false),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("inbox_threads_channel_external_uq")
      .on(t.channel, t.externalThreadId)
      .where(sql`${t.externalThreadId} is not null`),
    index("inbox_threads_status_last_idx").on(t.status, t.lastMessageAt.desc()),
    index("inbox_threads_person_idx").on(t.personId),
    index("inbox_threads_assignee_idx").on(t.assigneeUserId),
    check("inbox_threads_subject_ck", sql`${t.subject} is null or char_length(${t.subject}) <= 500`),
  ],
);

/**
 * The messages of a thread: `in` from the customer, `out` a staff reply, `note` an internal note
 * that is never sent. `external_message_id` is the email Message-ID or the Meta `mid` (unique: a
 * repeated delivery inserts nothing). `delivery_error` (ADD, crm-P9) says why an `out` message
 * was not delivered (a closed Meta window, a missing permission). Attachments are not stored.
 * R4 (crm-P10): an inbound message can carry an AI reply draft (`ai_draft`, `ai_draft_status`,
 * `ai_request_id`); it is never sent by the system (rule 3.51).
 */
export const inboxMessages = pgTable(
  "inbox_messages",
  {
    id: id(),
    threadId: uuid()
      .notNull()
      .references(() => inboxThreads.id, { onDelete: "cascade" }),
    direction: inboxMessagesDirection().notNull(),
    body: text().notNull(),
    externalMessageId: text().unique("inbox_messages_external_message_id_unique"),
    aiDraft: text(),
    /** R4 (crm-P10): `pending` once requested, `ready` with a draft, `used` once staff sent it. */
    aiDraftStatus: inboxMessagesAiDraftStatus().notNull().default("none"),
    /** R4 (crm-P10): the `ai_requests` row of the draft (null once the 30-day sweep removed it). */
    aiRequestId: uuid().references(() => aiRequests.id, { onDelete: "set null" }),
    sentByUserId: uuid().references(() => users.id),
    emailMessageId: uuid().references(() => emailMessages.id),
    attachmentCount: smallint().notNull().default(0),
    deliveryError: text(),
    occurredAt: tstz().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("inbox_messages_thread_idx").on(t.threadId, t.occurredAt),
    check("inbox_messages_body_ck", sql`char_length(${t.body}) <= 50000`),
    check("inbox_messages_attachment_count_ck", sql`${t.attachmentCount} >= 0`),
  ],
);

/** Staff reply templates (LocalizedText). No person data (`NO_PII_TABLES`). */
export const inboxReplyTemplates = pgTable(
  "inbox_reply_templates",
  {
    id: id(),
    key: text().notNull().unique("inbox_reply_templates_key_unique"),
    name: localized().notNull(),
    body: localized().notNull(),
    isActive: boolean().notNull().default(true),
    ...timestamps(),
  },
  (t) => [check("inbox_reply_templates_key_ck", sql`${t.key} ~ '^[a-z0-9_-]{2,64}$'`)],
);

// ---------------------------------------------------------------------------
// 2.8 Release 4: AI reply knowledge base (crm-P10)
// ---------------------------------------------------------------------------

/**
 * BEAM policies staff write for AI reply drafts (rule 3.58): cancellation rules, opening hours,
 * what to bring. Plain text, at most 5,000 characters per locale (checked in the action). No
 * person data (`NO_PII_TABLES`).
 */
export const supportKnowledgeArticles = pgTable(
  "support_knowledge_articles",
  {
    id: id(),
    key: text().notNull().unique("support_knowledge_articles_key_unique"),
    title: localized().notNull(),
    body: localized().notNull(),
    isActive: boolean().notNull().default(true),
    updatedByUserId: uuid().references(() => users.id),
    ...timestamps(),
  },
  (t) => [check("support_knowledge_articles_key_ck", sql`${t.key} ~ '^[a-z0-9_-]{2,64}$'`)],
);
