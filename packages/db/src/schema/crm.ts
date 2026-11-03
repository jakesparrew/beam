/**
 * crm tables created by Wave 0 on behalf of crm (platform-P2): `persons`, `consent_records`,
 * `suppressions` and `activity_events` with their architecture columns (architecture section 2,
 * data model 1.2.2). crm takes the file over and adds columns and tables (expand only).
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  index,
  inet,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import {
  createdAt,
  id,
  localeEnum,
  sensitive,
  timestamps,
  tstz,
  type ActorJson,
} from "./_shared";
import { users } from "./platform";

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

export const persons = pgTable(
  "persons",
  {
    id: id(),
    email: text(),
    phone: text(),
    firstName: text(),
    lastName: text(),
    locale: localeEnum().notNull().default("nl-BE"),
    address: jsonb().$type<PostalAddressJson>(),
    birthOn: date(),
    preferredChannel: personsPreferredChannel(),
    statusOverride: personsStatusOverride(),
    statusOverrideReason: text(),
    statusOverrideByUserId: uuid().references((): AnyPgColumn => users.id),
    acquisition: jsonb().$type<AcquisitionJson>().notNull().default({}),
    // FK to companies is added by crm when it creates `companies` (Wave 1).
    partnerCompanyId: uuid(),
    isTester: boolean().notNull().default(false),
    processingRestrictedAt: tstz(),
    mergedIntoPersonId: uuid().references((): AnyPgColumn => persons.id),
    erasedAt: tstz(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("persons_email_active_uq")
      .on(sql`lower(${t.email})`)
      .where(sql`${t.erasedAt} is null and ${t.mergedIntoPersonId} is null`),
    index("persons_email_idx").on(sql`lower(${t.email})`),
    index("persons_name_idx").on(
      sql`lower(${t.lastName})`,
      sql`lower(${t.firstName})`,
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
    source: text().notNull(),
    method: consentRecordsMethod().notNull(),
    wordingVersion: text().notNull(),
    ip: inet(),
    recordedAt: tstz().notNull().defaultNow(),
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
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("suppressions_email_hash_scope_uq").on(t.emailHash, t.scope),
  ],
);

/** APPEND. `data` is SENSITIVE (`{ body_enc, key_version }`) on rows with `is_sensitive`. */
export const activityEvents = pgTable(
  "activity_events",
  {
    id: bigint({ mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
    personId: uuid().references(() => persons.id, { onDelete: "restrict" }),
    // FK to companies is added by crm when it creates `companies` (Wave 1).
    companyId: uuid(),
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
