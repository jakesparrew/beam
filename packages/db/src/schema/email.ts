/**
 * email contract stubs created by Wave 0 on behalf of email (platform-P2): `email_templates` and
 * `email_messages` (data model 1.2.8). email takes the file over and completes them with
 * additive columns only.
 *
 * `email_messages.template_version_id` is nullable here: the Wave 0 `email.sendTransactional`
 * (platform-P7) sends code-backed registry templates before `email_template_versions` exists.
 * email adds the foreign key with that table and enforces presence with a check where needed.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import { persons } from "./crm";
import { id, timestamps, tstz } from "./_shared";
import { files, users } from "./platform";

export const emailTemplatesKind = pgEnum("email_templates_kind", [
  "transactional",
  "marketing",
]);
export const emailTemplatesPurpose = pgEnum("email_templates_purpose", [
  "newsletter",
  "events",
  "member_comms",
  "b2b",
]);
export const emailTemplatesStatus = pgEnum("email_templates_status", [
  "draft",
  "published",
  "archived",
]);
export const emailMessagesKind = pgEnum("email_messages_kind", [
  "transactional",
  "campaign",
  "automation",
  "test",
]);
export const emailMessagesPurpose = pgEnum("email_messages_purpose", [
  "newsletter",
  "events",
  "member_comms",
  "b2b",
]);
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

export const emailTemplates = pgTable(
  "email_templates",
  {
    id: id(),
    slug: text().notNull().unique(),
    name: text().notNull(),
    kind: emailTemplatesKind().notNull(),
    purpose: emailTemplatesPurpose(),
    // FK to email_template_versions is added by email with that table (Wave 1).
    currentVersionId: uuid(),
    status: emailTemplatesStatus().notNull().default("draft"),
    isSystem: boolean().notNull().default(false),
    createdByUserId: uuid().references(() => users.id),
    ...timestamps(),
  },
  (t) => [
    index("email_templates_kind_status_idx").on(t.kind, t.status),
    check(
      "email_templates_slug_ck",
      sql`(${t.kind} = 'transactional' and ${t.slug} ~ '^[a-z]+\\.[a-z][a-z0-9_]{1,60}$') or (${t.kind} = 'marketing' and ${t.slug} ~ '^[a-z0-9][a-z0-9-]{2,79}$')`,
    ),
    check(
      "email_templates_purpose_ck",
      sql`(${t.kind} = 'marketing') = (${t.purpose} is not null)`,
    ),
  ],
);

export const emailMessages = pgTable(
  "email_messages",
  {
    id: id(),
    personId: uuid().references(() => persons.id, { onDelete: "restrict" }),
    toEmail: text(),
    kind: emailMessagesKind().notNull(),
    purpose: emailMessagesPurpose(),
    templateVersionId: uuid(),
    // FKs to campaigns (email) and automation_enrolments (no FK, automation's table) come later.
    campaignId: uuid(),
    enrolmentId: uuid(),
    locale: text().notNull(),
    subject: text(),
    props: jsonb(),
    context: jsonb(),
    attachments: jsonb()
      .$type<{ fileId: string; filename: string; inline?: boolean }[]>()
      .notNull()
      .default([]),
    replyTo: text(),
    extraHeaders: jsonb().$type<Record<string, string>>(),
    sendAt: tstz(),
    idempotencyKey: text()
      .notNull()
      .unique("email_messages_idempotency_key_unique"),
    resendId: text().unique("email_messages_resend_id_unique"),
    linkTokenHash: text().unique("email_messages_link_token_hash_unique"),
    status: emailMessagesStatus().notNull().default("queued"),
    renderedFileId: uuid().references(() => files.id),
    error: text(),
    queuedAt: tstz().notNull().defaultNow(),
    sentAt: tstz(),
    ...timestamps(),
  },
  (t) => [
    index("email_messages_person_created_idx").on(
      t.personId,
      t.createdAt.desc(),
    ),
    index("email_messages_campaign_status_idx").on(t.campaignId, t.status),
    index("email_messages_queued_idx")
      .on(t.queuedAt)
      .where(sql`${t.status} in ('queued', 'blocked_translation')`),
    index("email_messages_person_template_idx").on(
      t.personId,
      t.templateVersionId,
      t.createdAt.desc(),
    ),
    check(
      "email_messages_campaign_purpose_ck",
      sql`${t.kind} <> 'campaign' or ${t.purpose} is not null`,
    ),
  ],
);
