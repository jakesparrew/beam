/**
 * forms schema (forms spec section 2, data model 1.2.7). Wave 0 stub of `forms` by platform-P2,
 * completed by forms-P1 with every V1 table, enum, check and index of the module, keeping the
 * stub's columns. Later forms packages only add (expand only).
 *
 * No table is APPEND (timeline facts go to `activity_events`, consent to `consent_records`).
 * `form_versions` is IMMUTABLE once `published_at` is set (`IMMUTABLE_TABLES`; the guard is
 * service code: every update filters `published_at is null`).
 *
 * Sensitive data: only `form_sensitive_answers.value_enc` (declared with `sensitive()`), read
 * only through `readSensitive()`. `form_submissions.answers` and `score` hold non-sensitive
 * fields only (rule SE1).
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { companies, persons } from "./crm";
import { emailMessages } from "./email";
import { users } from "./platform";
import { bytea, id, localized, sensitive, timestamps, tstz, updatedAt } from "./_shared";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const formsKind = pgEnum("forms_kind", ["lead", "intake", "survey", "assessment", "registration"]);
export const formsStatus = pgEnum("forms_status", ["draft", "published", "archived"]);
export const formSubmissionsStatus = pgEnum("form_submissions_status", ["started", "partial", "abandoned", "completed"]);
export const formSubmissionsIdentifiedBy = pgEnum("form_submissions_identified_by", [
  "session",
  "token",
  "staff",
  "email",
  "import",
  "none",
]);
export const formLinksChannel = pgEnum("form_links_channel", [
  "link",
  "qr",
  "ad",
  "email",
  "social",
  "partner",
  "referral",
  "print",
  "b2b",
]);
export const formImportSourcesProvider = pgEnum("form_import_sources_provider", ["scoreapp", "typeform"]);
export const formImportEventsStatus = pgEnum("form_import_events_status", ["received", "processed", "skipped", "failed"]);

/**
 * `form_submissions.source`: crm's `AcquisitionSource` vocabulary as the forms spec lists it
 * (rule A2). crm's `guest` is not a form source and is refused by the check.
 */
export const FORM_SUBMISSION_SOURCES = [
  "website",
  "landing_page",
  "paid_meta",
  "paid_google",
  "paid_other",
  "organic_search",
  "social_media",
  "webinar",
  "event",
  "referral",
  "partner",
  "customer_introduction",
  "walk_in",
  "qr_code",
  "b2b_campaign",
  "import",
  "manual",
  "other",
] as const;
export type FormSubmissionSource = (typeof FORM_SUBMISSION_SOURCES)[number];

// ---------------------------------------------------------------------------
// JSON column shapes (the full Zod schemas live in `@beam/core/forms`, forms-P2)
// ---------------------------------------------------------------------------

/** `forms.cta_warnings` entry, overwritten nightly by `forms.check_cta_targets`. */
export type FormCtaWarningJson = {
  endingKey: string;
  ctaKey: string;
  reason: "inactive_product" | "past_session" | "inactive_template" | "missing_webinar";
};

/** `form_versions.definition` (`FormDefinition`, rules F1 to F5); opaque at the schema level. */
export type FormDefinitionJson = Record<string, unknown>;

/** `form_versions.scoring` (`FormScoring`); `{}` = not scored. */
export type FormScoringJson = Record<string, unknown>;

/** `form_submissions.score`: non-sensitive dimensions only. */
export type FormScoreJson = {
  total: number | null;
  totalRangeKey: string | null;
  dimensions: Record<string, { value: number | null; rangeKey: string | null }>;
};

/** UTM parameters as stored on submissions and links. */
export type FormUtmJson = { source?: string; medium?: string; campaign?: string; term?: string; content?: string };

/** `form_submissions.consent_snapshot` entry (rule C2). */
export type FormConsentSnapshotJson = {
  purpose: string;
  granted: boolean;
  wordingVersion: string;
  fieldKey: string;
  skippedMinor?: boolean;
};

/** `form_import_sources.mapping` (`ImportMapping`, rule I2); opaque at the schema level. */
export type FormImportMappingJson = Record<string, unknown>;

// ---------------------------------------------------------------------------
// forms
// ---------------------------------------------------------------------------

export const forms = pgTable(
  "forms",
  {
    id: id(),
    slug: text().notNull(),
    kind: formsKind().notNull(),
    name: localized().notNull(),
    status: formsStatus().notNull().default("draft"),
    /** The version served to visitors. */
    currentVersionId: uuid().references((): AnyPgColumn => formVersions.id, { onDelete: "restrict" }),
    ...timestamps(),
    /** Internal note (staff only). */
    description: text(),
    /** Null = created by the `defaults` seed. */
    createdByUserId: uuid().references(() => users.id),
    archivedAt: tstz(),
    ctaWarnings: jsonb().$type<FormCtaWarningJson[]>().notNull().default([]),
  },
  (t) => [
    uniqueIndex("forms_slug_uq").on(t.slug),
    index("forms_status_idx").on(t.status),
    check(
      "forms_slug_ck",
      sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(${t.slug}) <= 64 and ${t.slug} not in ('result', 'import')`,
    ),
    check("forms_published_version_ck", sql`${t.status} <> 'published' or ${t.currentVersionId} is not null`),
  ],
);

// ---------------------------------------------------------------------------
// form_versions (IMMUTABLE once published_at is set)
// ---------------------------------------------------------------------------

export const formVersions = pgTable(
  "form_versions",
  {
    id: id(),
    formId: uuid()
      .notNull()
      .references((): AnyPgColumn => forms.id, { onDelete: "restrict" }),
    version: integer().notNull(),
    definition: jsonb().$type<FormDefinitionJson>().notNull(),
    scoring: jsonb().$type<FormScoringJson>().notNull().default({}),
    /** Derived from `definition` on every save; never edited directly. */
    sensitiveFieldKeys: text().array().notNull().default(sql`'{}'::text[]`),
    locales: text().array().notNull().default(sql`'{nl-BE}'::text[]`),
    /** Derived: purposes of the consent fields. */
    consentPurposes: text().array().notNull().default(sql`'{}'::text[]`),
    /** sha256 of the canonical JSON of definition + scoring. */
    definitionHash: text().notNull(),
    changeNote: text(),
    /** Null = the editable draft. */
    publishedAt: tstz(),
    /** Null on a published row = published by the `defaults` seed. */
    publishedByUserId: uuid().references(() => users.id),
    /** Null = `defaults` seed. */
    createdByUserId: uuid().references(() => users.id),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("form_versions_form_version_uq").on(t.formId, t.version),
    uniqueIndex("form_versions_one_draft_uq")
      .on(t.formId)
      .where(sql`${t.publishedAt} is null`),
    check("form_versions_version_ck", sql`${t.version} > 0`),
    check(
      "form_versions_locales_ck",
      sql`cardinality(${t.locales}) >= 1 and ${t.locales} <@ array['nl-BE', 'fr-BE', 'en']::text[]`,
    ),
    check("form_versions_publisher_ck", sql`${t.publishedByUserId} is null or ${t.publishedAt} is not null`),
  ],
);

// ---------------------------------------------------------------------------
// form_links (tracked links and QR codes)
// ---------------------------------------------------------------------------

export const formLinks = pgTable(
  "form_links",
  {
    id: id(),
    formId: uuid()
      .notNull()
      .references(() => forms.id),
    /** 8 chars `[a-z0-9]`, used as `?l=<key>`. */
    key: text().notNull(),
    name: text().notNull(),
    channel: formLinksChannel().notNull().default("link"),
    /** Defaults applied when the URL has no UTM. */
    utm: jsonb().$type<FormUtmJson>().notNull().default({}),
    /** R3 partner links; nulled when the company is deleted. */
    partnerCompanyId: uuid().references(() => companies.id, { onDelete: "set null" }),
    /** R3 referral links; nulled on erasure. */
    referrerPersonId: uuid().references(() => persons.id),
    /** Inactive links still resolve the form but record no link. */
    isActive: boolean().notNull().default(true),
    createdByUserId: uuid()
      .notNull()
      .references(() => users.id),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("form_links_key_uq").on(t.key),
    index("form_links_form_idx").on(t.formId),
    check("form_links_key_ck", sql`${t.key} ~ '^[a-z0-9]{8}$'`),
  ],
);

// ---------------------------------------------------------------------------
// form_import_sources and form_import_events (V1 stopgap)
// ---------------------------------------------------------------------------

export const formImportSources = pgTable(
  "form_import_sources",
  {
    id: id(),
    /** 12 chars `[a-z0-9]`; path segment of the import URL. */
    key: text().notNull(),
    provider: formImportSourcesProvider().notNull(),
    name: text().notNull(),
    /** Mirror form (kind `assessment`) with a published version mirroring the mapping. */
    formId: uuid()
      .notNull()
      .references(() => forms.id),
    /** sha256 of the 32-byte URL secret; the secret is shown once on creation. */
    tokenHash: text().notNull(),
    mapping: jsonb().$type<FormImportMappingJson>().notNull(),
    isActive: boolean().notNull().default(true),
    lastReceivedAt: tstz(),
    createdByUserId: uuid()
      .notNull()
      .references(() => users.id),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("form_import_sources_key_uq").on(t.key),
    index("form_import_sources_form_idx").on(t.formId),
    check("form_import_sources_key_ck", sql`${t.key} ~ '^[a-z0-9]{12}$'`),
  ],
);

export const formImportEvents = pgTable(
  "form_import_events",
  {
    id: id(),
    sourceId: uuid()
      .notNull()
      .references(() => formImportSources.id),
    /** Typeform `event_id`, ScoreApp response id, or sha256 of the CSV row. */
    externalId: text().notNull(),
    /** Raw body (person data; deleted after 90 days). */
    payload: jsonb().$type<Record<string, unknown>>().notNull(),
    /** sha256 of the lower-cased email found by the mapping (erasure lookup). */
    emailHash: text(),
    status: formImportEventsStatus().notNull().default("received"),
    error: text(),
    submissionId: uuid().references((): AnyPgColumn => formSubmissions.id, { onDelete: "set null" }),
    receivedAt: tstz().notNull().defaultNow(),
    processedAt: tstz(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("form_import_events_uq").on(t.sourceId, t.externalId),
    index("form_import_events_status_idx").on(t.status, t.receivedAt),
    index("form_import_events_email_idx").on(t.emailHash),
    index("form_import_events_submission_idx")
      .on(t.submissionId)
      .where(sql`${t.submissionId} is not null`),
  ],
);

// ---------------------------------------------------------------------------
// form_submissions
// ---------------------------------------------------------------------------

const sourceList = sql.raw(FORM_SUBMISSION_SOURCES.map((s) => `'${s}'`).join(", "));

export const formSubmissions = pgTable(
  "form_submissions",
  {
    id: id(),
    /** Denormalised for reporting. */
    formId: uuid()
      .notNull()
      .references(() => forms.id),
    /** Pinned at start (rule U6). */
    formVersionId: uuid()
      .notNull()
      .references(() => formVersions.id, { onDelete: "restrict" }),
    /** Null for anonymous or not yet identified visitors. */
    personId: uuid().references(() => persons.id),
    status: formSubmissionsStatus().notNull().default("started"),
    identifiedBy: formSubmissionsIdentifiedBy().notNull().default("none"),
    /** `{ [fieldKey]: value }`, non-sensitive fields only (SE1). */
    answers: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    /** Non-sensitive dimensions only. */
    score: jsonb().$type<FormScoreJson>(),
    outcomeKey: text(),
    endingKey: text(),
    /** Section keys visited, in order. */
    path: text().array().notNull().default(sql`'{}'::text[]`),
    /** For resume. */
    currentSectionKey: text(),
    utm: jsonb().$type<FormUtmJson>().notNull().default({}),
    /** crm's `AcquisitionSource` vocabulary (rule A2). */
    source: text().$type<FormSubmissionSource>().notNull().default("website"),
    /** `utm_campaign` or link name. */
    campaign: text(),
    /** `FormSettings.funnel` or `form:<slug>` (rule A6). */
    funnel: text().notNull(),
    linkId: uuid().references(() => formLinks.id),
    /** Origin + path only, no query, max 500 chars. */
    referrerUrl: text(),
    /** Path of the BEAM page or the embedding page, max 300 chars, no query. */
    landingPath: text(),
    /** Host of the page that embedded the form. */
    embedHost: text(),
    /** Tags this submission applied (rule A5). */
    appliedTagKeys: text().array().notNull().default(sql`'{}'::text[]`),
    /** Staff-assisted entry (rule ID10). */
    enteredByUserId: uuid().references(() => users.id),
    /** Also one of the version's locales (enforced in code). */
    locale: text().notNull(),
    /** sha256 of the result token. */
    resultTokenHash: text(),
    /** A bump revokes the result link. */
    resultTokenVersion: smallint().notNull().default(1),
    /** completed_at + 180 days. */
    resultTokenExpiresAt: tstz(),
    /** sha256; null when resume is off. */
    resumeTokenHash: text(),
    /** HMAC of the client IP; nulled after 30 days. */
    ipHash: text(),
    consentSnapshot: jsonb().$type<FormConsentSnapshotJson[]>().notNull().default([]),
    importEventId: uuid().references((): AnyPgColumn => formImportEvents.id),
    /** ScoreApp or Typeform response id. */
    externalRef: text(),
    resultEmailMessageId: uuid().references(() => emailMessages.id),
    startedAt: tstz().notNull().defaultNow(),
    lastActivityAt: tstz().notNull().defaultNow(),
    completedAt: tstz(),
    abandonedAt: tstz(),
    ...timestamps(),
  },
  (t) => [
    index("form_submissions_form_status_idx").on(t.formId, t.status, t.startedAt.desc()),
    index("form_submissions_person_idx")
      .on(t.personId, t.formId, t.completedAt.desc())
      .where(sql`${t.personId} is not null`),
    index("form_submissions_open_idx")
      .on(t.lastActivityAt)
      .where(sql`${t.status} in ('started', 'partial')`),
    index("form_submissions_version_idx").on(t.formVersionId),
    index("form_submissions_link_idx")
      .on(t.linkId)
      .where(sql`${t.linkId} is not null`),
    index("form_submissions_ip_idx")
      .on(t.formId, t.ipHash, t.startedAt)
      .where(sql`${t.ipHash} is not null`),
    uniqueIndex("form_submissions_result_token_uq").on(t.resultTokenHash),
    uniqueIndex("form_submissions_resume_token_uq").on(t.resumeTokenHash),
    uniqueIndex("form_submissions_import_uq")
      .on(t.importEventId)
      .where(sql`${t.importEventId} is not null`),
    check("form_submissions_source_ck", sql`${t.source} in (${sourceList})`),
    check("form_submissions_locale_ck", sql`${t.locale} in ('nl-BE', 'fr-BE', 'en')`),
    check("form_submissions_completed_ck", sql`(${t.status} = 'completed') = (${t.completedAt} is not null)`),
    check("form_submissions_abandoned_ck", sql`${t.status} <> 'abandoned' or ${t.abandonedAt} is not null`),
    check("form_submissions_referrer_url_ck", sql`${t.referrerUrl} is null or length(${t.referrerUrl}) <= 500`),
    check("form_submissions_landing_path_ck", sql`${t.landingPath} is null or length(${t.landingPath}) <= 300`),
  ],
);

// ---------------------------------------------------------------------------
// form_sensitive_answers (every value column is SENSITIVE)
// ---------------------------------------------------------------------------

export const formSensitiveAnswers = pgTable(
  "form_sensitive_answers",
  {
    id: id(),
    submissionId: uuid()
      .notNull()
      .references(() => formSubmissions.id, { onDelete: "cascade" }),
    /** Set when the submission is linked to a person. */
    personId: uuid().references(() => persons.id),
    /** A field key, or `score:<dimensionKey>` for a dimension computed from sensitive fields. */
    fieldKey: text().notNull(),
    /**
     * `encryptSensitive(JSON.stringify(value), aad)` with
     * `aad = 'form_sensitive_answers:<submission_id>:<field_key>'` (AES-256-GCM, platform).
     */
    valueEnc: sensitive(bytea("value_enc").notNull(), {
      table: "form_sensitive_answers",
      keyColumn: "key_version",
    }),
    keyVersion: smallint().notNull().default(1),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("form_sensitive_answers_uq").on(t.submissionId, t.fieldKey),
    index("form_sensitive_answers_person_idx")
      .on(t.personId)
      .where(sql`${t.personId} is not null`),
  ],
);

// ---------------------------------------------------------------------------
// form_views_daily (page-view counter for the funnel; no personal data)
// ---------------------------------------------------------------------------

export const formViewsDaily = pgTable(
  "form_views_daily",
  {
    id: id(),
    formId: uuid()
      .notNull()
      .references(() => forms.id),
    /** Europe/Brussels calendar day. */
    dayOn: date({ mode: "string" }).notNull(),
    linkKey: text().notNull().default(""),
    locale: text().notNull(),
    views: integer().notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("form_views_daily_uq").on(t.formId, t.dayOn, t.linkKey, t.locale),
    check("form_views_daily_views_ck", sql`${t.views} >= 0`),
  ],
);

// ---------------------------------------------------------------------------
// Inferred row types
// ---------------------------------------------------------------------------

export type Form = typeof forms.$inferSelect;
export type NewForm = typeof forms.$inferInsert;
export type FormVersionRow = typeof formVersions.$inferSelect;
export type NewFormVersionRow = typeof formVersions.$inferInsert;
export type FormSubmissionRow = typeof formSubmissions.$inferSelect;
export type NewFormSubmissionRow = typeof formSubmissions.$inferInsert;
export type FormSensitiveAnswerRow = typeof formSensitiveAnswers.$inferSelect;
export type FormLinkRow = typeof formLinks.$inferSelect;
export type FormViewsDailyRow = typeof formViewsDaily.$inferSelect;
export type FormImportSourceRow = typeof formImportSources.$inferSelect;
export type FormImportEventRow = typeof formImportEvents.$inferSelect;
