/**
 * email schema (email spec section 2, data model 1.2.8). Wave 0 (platform-P2) created the
 * contract stubs `email_templates` and `email_messages`; email-P1 completes them with additive
 * columns and adds `email_template_versions`, `campaigns`, `campaign_recipients`,
 * `email_events` (APPEND) and `email_ai_drafts` (R4). Views live in `email.views.ts` (email-P3).
 *
 * `email_messages.template_version_id` stays nullable: the Wave 0 `email.sendTransactional`
 * (platform-P7) queues code-backed registry templates by key before their system version rows
 * are seeded. The check `email_messages_template_version_ck` requires it for every other kind.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
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
import type { BlockDocument } from "@beam/core/email";
import { persons } from "./crm";
import { createdAt, id, localized, timestamps, tstz, type LocalizedText } from "./_shared";
import { aiRequests, files, users } from "./platform";

/** The tables of this module that are append-only (all listed in `APPEND_ONLY_TABLES`). */
export const EMAIL_APPEND_ONLY_TABLES = ["email_events"] as const;

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const emailTemplatesKind = pgEnum("email_templates_kind", ["transactional", "marketing"]);
export const emailTemplatesPurpose = pgEnum("email_templates_purpose", ["newsletter", "events", "member_comms", "b2b"]);
export const emailTemplatesStatus = pgEnum("email_templates_status", ["draft", "published", "archived"]);
export const campaignsPurpose = pgEnum("campaigns_purpose", ["newsletter", "events", "member_comms", "b2b"]);
export const campaignsStatus = pgEnum("campaigns_status", [
  "draft",
  "planning",
  "scheduled",
  "sending",
  "paused",
  "sent",
  "stopped",
  "cancelled",
]);
export const campaignsPausedReason = pgEnum("campaigns_paused_reason", ["manual", "bounce_rate"]);
export const campaignRecipientsStatus = pgEnum("campaign_recipients_status", [
  "planned",
  "sent",
  "skipped_suppressed",
  "skipped_consent",
  "skipped_translation",
  "skipped_unreachable",
  "removed",
  "failed",
]);
export const emailMessagesKind = pgEnum("email_messages_kind", ["transactional", "campaign", "automation", "test"]);
export const emailMessagesPurpose = pgEnum("email_messages_purpose", ["newsletter", "events", "member_comms", "b2b"]);
export const emailMessagesStatus = pgEnum("email_messages_status", [
  "queued",
  "blocked_translation",
  "suppressed",
  "sent",
  "delivered",
  "bounced",
  "complained",
  "failed",
]);
export const emailMessagesBounceType = pgEnum("email_messages_bounce_type", ["hard", "soft"]);
export const emailMessagesFromDomain = pgEnum("email_messages_from_domain", ["mail.beam.be", "news.beam.be"]);
export const emailEventsType = pgEnum("email_events_type", [
  "sent",
  "delivered",
  "delayed",
  "bounced",
  "complained",
  "opened",
  "clicked",
  "failed",
]);
export const emailEventsSource = pgEnum("email_events_source", ["resend", "tracking"]);
export const emailAiDraftsStatus = pgEnum("email_ai_drafts_status", ["queued", "ready", "failed", "accepted", "discarded"]);

// ---------------------------------------------------------------------------
// Templates and versions
// ---------------------------------------------------------------------------

export const emailTemplates = pgTable(
  "email_templates",
  {
    id: id(),
    slug: text().notNull().unique(),
    name: text().notNull(),
    description: text(),
    kind: emailTemplatesKind().notNull(),
    purpose: emailTemplatesPurpose(),
    /** Points only at a published version (enforced by the actions). */
    currentVersionId: uuid().references((): AnyPgColumn => emailTemplateVersions.id, { onDelete: "restrict" }),
    status: emailTemplatesStatus().notNull().default("draft"),
    isSystem: boolean().notNull().default(false),
    createdByUserId: uuid().references(() => users.id, { onDelete: "restrict" }),
    ...timestamps(),
  },
  (t) => [
    index("email_templates_kind_status_idx").on(t.kind, t.status),
    check(
      "email_templates_slug_ck",
      sql`(${t.kind} = 'transactional' and ${t.slug} ~ '^[a-z]+\\.[a-z][a-z0-9_]{1,60}$') or (${t.kind} = 'marketing' and ${t.slug} ~ '^[a-z0-9][a-z0-9-]{2,79}$')`,
    ),
    check("email_templates_purpose_ck", sql`(${t.kind} = 'marketing') = (${t.purpose} is not null)`),
  ],
);

/** IMMUTABLE once `published_at` is set: the guard is `assertDraftVersion()` (`@beam/core/email`). */
export const emailTemplateVersions = pgTable(
  "email_template_versions",
  {
    id: id(),
    templateId: uuid()
      .notNull()
      .references(() => emailTemplates.id, { onDelete: "restrict" }),
    version: integer().notNull(),
    subject: localized().notNull().default({}),
    preheader: localized().notNull().default({}),
    /** Block-backed templates: `{ schemaVersion: 1, locales: { [locale]: Block[] } }`. */
    document: jsonb().$type<BlockDocument>(),
    /** Code-backed transactional templates: editable copy slots of the react-email component. */
    copy: jsonb().$type<Record<string, LocalizedText>>(),
    /** Code-backed transactional templates: the `TEMPLATE_REGISTRY` key. */
    reactComponent: text(),
    /** Block-backed: compiled HTML per locale and dynamic variant path, written at publish. */
    htmlByLocale: jsonb().$type<Record<string, Record<string, string>>>(),
    textByLocale: jsonb().$type<Record<string, Record<string, string>>>(),
    locales: text().array().notNull().default(sql`'{}'::text[]`),
    publishedAt: tstz(),
    createdByUserId: uuid().references(() => users.id, { onDelete: "restrict" }),
    aiDraftId: uuid().references((): AnyPgColumn => emailAiDrafts.id),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("email_template_versions_template_version_uq").on(t.templateId, t.version),
    uniqueIndex("email_template_versions_one_draft_uq")
      .on(t.templateId)
      .where(sql`${t.publishedAt} is null`),
    check("email_template_versions_version_ck", sql`${t.version} > 0`),
    check("email_template_versions_locales_ck", sql`${t.locales} <@ array['nl-BE','fr-BE','en']::text[]`),
    check("email_template_versions_copy_ck", sql`(${t.reactComponent} is null) = (${t.copy} is null)`),
    check("email_template_versions_body_ck", sql`(${t.reactComponent} is null) = (${t.document} is not null)`),
  ],
);

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

export const campaigns = pgTable(
  "campaigns",
  {
    id: id(),
    name: text().notNull(),
    templateId: uuid()
      .notNull()
      .references(() => emailTemplates.id, { onDelete: "restrict" }),
    templateVersionId: uuid().references(() => emailTemplateVersions.id, { onDelete: "restrict" }),
    /** `segments.id` (crm); no FK, the actions check existence. */
    segmentId: uuid(),
    excludeSegmentIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    purpose: campaignsPurpose().notNull(),
    status: campaignsStatus().notNull().default("draft"),
    scheduledAt: tstz(),
    audienceSnapshotAt: tstz(),
    recipientsCount: integer().notNull().default(0),
    sentCount: integer().notNull().default(0),
    chunkCount: integer().notNull().default(0),
    runNo: smallint().notNull().default(1),
    pausedReason: campaignsPausedReason(),
    testSentAt: tstz(),
    startedAt: tstz(),
    finishedAt: tstz(),
    stoppedAt: tstz(),
    cancelledAt: tstz(),
    lastError: text(),
    statsSnapshot: jsonb().$type<Record<string, unknown>>(),
    aiDraftId: uuid().references((): AnyPgColumn => emailAiDrafts.id),
    createdByUserId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    updatedByUserId: uuid().references(() => users.id, { onDelete: "restrict" }),
    version: integer().notNull().default(1),
    ...timestamps(),
  },
  (t) => [
    index("campaigns_scheduled_idx")
      .on(t.scheduledAt)
      .where(sql`${t.status} = 'scheduled'`),
    index("campaigns_status_created_idx").on(t.status, t.createdAt.desc()),
    check("campaigns_name_ck", sql`length(${t.name}) between 1 and 160`),
    check("campaigns_paused_reason_ck", sql`(${t.status} = 'paused') = (${t.pausedReason} is not null)`),
  ],
);

export const campaignRecipients = pgTable(
  "campaign_recipients",
  {
    id: id(),
    campaignId: uuid()
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    /**
     * `persons.id`. The foreign key (on delete restrict) is added once `campaign_recipients` is in
     * email's `privacy.ts` `tables` (email-P3): `gdpr:coverage` refuses a person reference that no
     * privacy registration covers, and `privacy.ts` is not email-P1's file.
     */
    personId: uuid().notNull(),
    locale: text().notNull(),
    chunkNo: integer().notNull(),
    status: campaignRecipientsStatus().notNull().default("planned"),
    emailMessageId: uuid()
      .references((): AnyPgColumn => emailMessages.id)
      .unique("campaign_recipients_email_message_id_unique"),
    removedByUserId: uuid().references(() => users.id, { onDelete: "restrict" }),
    removedAt: tstz(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("campaign_recipients_campaign_person_uq").on(t.campaignId, t.personId),
    index("campaign_recipients_chunk_idx").on(t.campaignId, t.chunkNo, t.status),
    index("campaign_recipients_person_idx").on(t.personId),
    check("campaign_recipients_locale_ck", sql`${t.locale} in ('nl-BE', 'fr-BE', 'en')`),
    check("campaign_recipients_chunk_ck", sql`${t.chunkNo} >= 0`),
    check("campaign_recipients_removed_ck", sql`(${t.status} = 'removed') = (${t.removedByUserId} is not null)`),
  ],
);

// ---------------------------------------------------------------------------
// Messages and events
// ---------------------------------------------------------------------------

export const emailMessages = pgTable(
  "email_messages",
  {
    id: id(),
    personId: uuid().references(() => persons.id, { onDelete: "restrict" }),
    toEmail: text(),
    kind: emailMessagesKind().notNull(),
    purpose: emailMessagesPurpose(),
    templateVersionId: uuid().references(() => emailTemplateVersions.id, { onDelete: "restrict" }),
    campaignId: uuid().references(() => campaigns.id),
    /** `automation_enrolments.id` (no FK, automation's table). */
    enrolmentId: uuid(),
    locale: text().notNull(),
    subject: text(),
    props: jsonb(),
    context: jsonb(),
    attachments: jsonb().$type<{ fileId: string; filename: string; inline?: boolean }[]>().notNull().default([]),
    replyTo: text(),
    extraHeaders: jsonb().$type<Record<string, string>>(),
    sendAt: tstz(),
    fromDomain: emailMessagesFromDomain().notNull().default("mail.beam.be"),
    idempotencyKey: text().notNull().unique("email_messages_idempotency_key_unique"),
    resendId: text().unique("email_messages_resend_id_unique"),
    status: emailMessagesStatus().notNull().default("queued"),
    bounceType: emailMessagesBounceType(),
    attempt: smallint().notNull().default(1),
    retryOfMessageId: uuid().references((): AnyPgColumn => emailMessages.id),
    linkTokenHash: text().unique("email_messages_link_token_hash_unique"),
    links: jsonb().$type<string[]>(),
    renderedFileId: uuid().references(() => files.id),
    error: text(),
    queuedAt: tstz().notNull().defaultNow(),
    sentAt: tstz(),
    deliveredAt: tstz(),
    openedAt: tstz(),
    clickedAt: tstz(),
    bouncedAt: tstz(),
    complainedAt: tstz(),
    lastEventAt: tstz(),
    ...timestamps(),
  },
  (t) => [
    index("email_messages_person_created_idx").on(t.personId, t.createdAt.desc()),
    index("email_messages_campaign_status_idx").on(t.campaignId, t.status),
    index("email_messages_queued_idx")
      .on(t.queuedAt)
      .where(sql`${t.status} in ('queued', 'blocked_translation')`),
    index("email_messages_person_template_idx").on(t.personId, t.templateVersionId, t.createdAt.desc()),
    index("email_messages_domain_sent_idx").on(t.fromDomain, t.sentAt),
    index("email_messages_to_email_prefix_idx").on(sql`lower(${t.toEmail}) text_pattern_ops`),
    check("email_messages_campaign_purpose_ck", sql`${t.kind} <> 'campaign' or ${t.purpose} is not null`),
    check("email_messages_template_version_ck", sql`${t.kind} = 'transactional' or ${t.templateVersionId} is not null`),
    check("email_messages_attempt_ck", sql`${t.attempt} between 1 and 2`),
    check("email_messages_send_at_ck", sql`${t.sendAt} <= ${t.createdAt} + interval '400 days'`),
  ],
);

/** APPEND: rows are never updated; only the erasure job deletes (under `beam.allow_rewrite`). */
export const emailEvents = pgTable(
  "email_events",
  {
    id: id(),
    emailMessageId: uuid()
      .notNull()
      .references(() => emailMessages.id, { onDelete: "cascade" }),
    type: emailEventsType().notNull(),
    source: emailEventsSource().notNull(),
    /** The `svix-id`; null for tracking events. */
    resendEventId: text().unique("email_events_resend_event_id_unique"),
    url: text(),
    linkIndex: smallint(),
    /** Only `{ bounce: { type, subType, message } }`, `{ ua_family }` or `{ reason }`; never addresses or IP. */
    payload: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: tstz().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("email_events_message_type_idx").on(t.emailMessageId, t.type),
    index("email_events_type_occurred_idx").on(t.type, t.occurredAt),
  ],
);

// ---------------------------------------------------------------------------
// AI drafts (R4)
// ---------------------------------------------------------------------------

export type EmailAiDraftInputs = {
  sessionIds: string[];
  segmentId: string | null;
  purpose: "newsletter" | "events" | "member_comms" | "b2b";
  locales: string[];
};

export const emailAiDrafts = pgTable(
  "email_ai_drafts",
  {
    id: id(),
    campaignId: uuid().references((): AnyPgColumn => campaigns.id),
    brief: text().notNull(),
    inputs: jsonb().$type<EmailAiDraftInputs>().notNull(),
    status: emailAiDraftsStatus().notNull().default("queued"),
    output: jsonb().$type<Record<string, unknown>>(),
    aiRequestId: uuid().references(() => aiRequests.id, { onDelete: "set null" }),
    error: text(),
    createdByUserId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    decidedByUserId: uuid(),
    decidedAt: tstz(),
    ...timestamps(),
  },
  (t) => [
    index("email_ai_drafts_creator_created_idx").on(t.createdByUserId, t.createdAt.desc()),
    check("email_ai_drafts_brief_ck", sql`length(${t.brief}) between 10 and 4000`),
  ],
);
