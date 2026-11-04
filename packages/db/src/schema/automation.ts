/**
 * automation schema (automation spec section 2, data model 1.2.9). Takes over the Wave 0 stub of
 * `automations` (its columns are kept) and adds the groups, the immutable versions, the
 * enrolments and the append-only run log.
 *
 * `automation_versions` and `automation_runs` are in `APPEND_ONLY_TABLES`; the orchestrator's
 * `select beam_protect_append_only();` attaches the trigger once the tables exist (D43).
 * `automation_runs.task_id` has no FK yet: crm's `tasks` table is not in this package's base.
 */
import type { PlannedStep } from "@beam/core/automation";
import { sql } from "drizzle-orm";
import {
  bigint,
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
import { createdAt, id, timestamps, tstz, type ActorJson } from "./_shared";
import { activityEvents, persons } from "./crm";
import { emailMessages } from "./email";
import { users } from "./platform";

// ---------------------------------------------------------------------------
// Enums (section 2.1)
// ---------------------------------------------------------------------------

export const automationsStatus = pgEnum("automations_status", ["draft", "active", "paused", "archived"]);
export const automationsPurpose = pgEnum("automations_purpose", ["newsletter", "events", "member_comms", "b2b"]);
export const automationEnrolmentsStatus = pgEnum("automation_enrolments_status", ["active", "completed", "exited"]);
export const automationEnrolmentsSource = pgEnum("automation_enrolments_source", [
  "trigger",
  "segment",
  "staff",
  "staff_move",
  "enrol_step",
  "migration",
  "api",
]);
export const AUTOMATION_RUN_OUTCOMES = [
  "entered",
  "scheduled",
  "sent",
  "task_created",
  "tag_applied",
  "tag_removed",
  "field_set",
  "status_set",
  "enrolled",
  "notified",
  "webhook_called",
  "branched",
  "skipped_late_entry",
  "skipped_condition",
  "skipped_unreachable",
  "skipped_translation",
  "skipped_exclusive",
  "skipped_paused",
  "skipped_stale",
  "skipped_frequency_cap",
  "exited",
  "completed",
  "failed",
] as const;
export const automationRunsOutcome = pgEnum("automation_runs_outcome", AUTOMATION_RUN_OUTCOMES);

/** `automation_enrolments.context` (section 2.5). */
export type EnrolmentContextJson = {
  trigger?: {
    event_id: string | null;
    kind: string;
    ref_type: string | null;
    ref_id: string | null;
    mode: string | null;
    data: Record<string, unknown>;
  };
  subject?: string;
  vars?: Record<string, string | number | boolean | null>;
};

/** `automation_runs.data` (section 2.6). */
export type RunDataJson = {
  due_at?: string;
  branch?: string;
  result?: boolean;
  target?: string;
  template_slug?: string;
  template_version_id?: string;
  event_id?: string;
  trigger_event_id?: string;
  superseded_enrolment_id?: string;
  superseded_by?: string;
} & Record<string, unknown>;

// ---------------------------------------------------------------------------
// automation_groups (section 2.2)
// ---------------------------------------------------------------------------

export const automationGroups = pgTable(
  "automation_groups",
  {
    id: id(),
    key: text().notNull().unique("automation_groups_key_unique"),
    name: text().notNull(),
    description: text(),
    isExclusive: boolean().notNull().default(false),
    lane: text(),
    priority: smallint().notNull().default(100),
    ...timestamps(),
  },
  (t) => [
    check("automation_groups_key_ck", sql`${t.key} ~ '^[a-z][a-z0-9_]*$'`),
    check("automation_groups_lane_ck", sql`${t.lane} is null or ${t.lane} ~ '^[a-z][a-z0-9_]*$'`),
    check("automation_groups_priority_ck", sql`${t.priority} between 0 and 1000`),
  ],
);

// ---------------------------------------------------------------------------
// automations (section 2.3)
// ---------------------------------------------------------------------------

export const automations = pgTable(
  "automations",
  {
    id: id(),
    slug: text().notNull().unique(),
    name: text().notNull(),
    description: text(),
    groupId: uuid()
      .notNull()
      .references(() => automationGroups.id, { onDelete: "restrict" }),
    priority: smallint().notNull().default(100),
    currentVersionId: uuid().references((): AnyPgColumn => automationVersions.id, { onDelete: "restrict" }),
    status: automationsStatus().notNull().default("draft"),
    isMarketing: boolean().notNull().default(true),
    purpose: automationsPurpose(),
    draftDefinition: jsonb().$type<unknown>(),
    draftUpdatedAt: tstz(),
    draftUpdatedByUserId: uuid().references((): AnyPgColumn => users.id, { onDelete: "restrict" }),
    activatedAt: tstz(),
    pausedAt: tstz(),
    lastResumedAt: tstz(),
    requiresDpia: text(),
    requiresFlag: text(),
    createdByUserId: uuid().references((): AnyPgColumn => users.id, { onDelete: "restrict" }),
    ...timestamps(),
  },
  (t) => [
    index("automations_status_idx").on(t.status),
    index("automations_group_idx").on(t.groupId),
    check("automations_slug_ck", sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
    check("automations_version_ck", sql`${t.status} = 'draft' or ${t.currentVersionId} is not null`),
    check("automations_purpose_ck", sql`${t.isMarketing} = false or ${t.purpose} is not null`),
    check("automations_priority_ck", sql`${t.priority} between 0 and 1000`),
    check("automations_paused_ck", sql`(${t.pausedAt} is not null) = (${t.status} = 'paused')`),
    check("automations_requires_flag_ck", sql`${t.requiresFlag} is null or ${t.requiresFlag} ~ '^ff_[a-z]+_[a-z0-9_]+$'`),
  ],
);

// ---------------------------------------------------------------------------
// automation_versions IMMUTABLE (section 2.4)
// ---------------------------------------------------------------------------

export const automationVersions = pgTable(
  "automation_versions",
  {
    id: id(),
    automationId: uuid()
      .notNull()
      .references((): AnyPgColumn => automations.id, { onDelete: "restrict" }),
    version: integer().notNull(),
    definition: jsonb().$type<unknown>().notNull(),
    definitionHash: text().notNull(),
    changeNote: text(),
    publishedAt: tstz().notNull().defaultNow(),
    createdByUserId: uuid().references((): AnyPgColumn => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("automation_versions_automation_version_uq").on(t.automationId, t.version),
    check("automation_versions_version_ck", sql`${t.version} > 0`),
  ],
);

// ---------------------------------------------------------------------------
// automation_enrolments (section 2.5, PD)
// ---------------------------------------------------------------------------

export const automationEnrolments = pgTable(
  "automation_enrolments",
  {
    id: id(),
    automationId: uuid()
      .notNull()
      .references(() => automations.id, { onDelete: "restrict" }),
    automationVersionId: uuid()
      .notNull()
      .references(() => automationVersions.id, { onDelete: "restrict" }),
    personId: uuid()
      .notNull()
      .references(() => persons.id, { onDelete: "restrict" }),
    subjectKey: text().notNull().default(""),
    groupId: uuid()
      .notNull()
      .references(() => automationGroups.id, { onDelete: "restrict" }),
    exclusiveDomain: text(),
    source: automationEnrolmentsSource().notNull(),
    triggerEventId: bigint({ mode: "bigint" }).references(() => activityEvents.id, { onDelete: "restrict" }),
    anchorAt: tstz(),
    status: automationEnrolmentsStatus().notNull().default("active"),
    nextStepKey: text(),
    nextStepAt: tstz(),
    enteredAt: tstz().notNull().defaultNow(),
    endedAt: tstz(),
    endReason: text(),
    plan: jsonb().$type<PlannedStep[]>().notNull().default([]),
    context: jsonb().$type<EnrolmentContextJson>().notNull().default({}),
    enteredByUserId: uuid().references((): AnyPgColumn => users.id, { onDelete: "restrict" }),
    migratedFromEnrolmentId: uuid().references((): AnyPgColumn => automationEnrolments.id, { onDelete: "restrict" }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("uq_enrolment_active").on(t.automationId, t.personId, t.subjectKey).where(sql`${t.status} = 'active'`),
    uniqueIndex("uq_enrolment_domain")
      .on(t.personId, t.exclusiveDomain)
      .where(sql`${t.status} = 'active' and ${t.exclusiveDomain} is not null`),
    uniqueIndex("uq_enrolment_trigger").on(t.automationId, t.triggerEventId).where(sql`${t.triggerEventId} is not null`),
    index("ix_enrolment_due").on(t.nextStepAt).where(sql`${t.status} = 'active'`),
    index("automation_enrolments_person_status_idx").on(t.personId, t.status),
    index("automation_enrolments_automation_status_idx").on(t.automationId, t.status, t.enteredAt.desc()),
    index("automation_enrolments_person_automation_idx").on(t.personId, t.automationId, t.enteredAt.desc()),
    check("automation_enrolments_ended_ck", sql`(${t.status} = 'active') = (${t.endedAt} is null)`),
    check("automation_enrolments_next_step_ck", sql`${t.status} = 'active' or ${t.nextStepAt} is null`),
    check("automation_enrolments_end_reason_ck", sql`${t.status} <> 'exited' or ${t.endReason} is not null`),
    check("automation_enrolments_subject_key_ck", sql`${t.subjectKey} = '' or ${t.subjectKey} ~ '^[a-z_]+:.+$'`),
  ],
);

// ---------------------------------------------------------------------------
// automation_runs APPEND (section 2.6, PD)
// ---------------------------------------------------------------------------

export const automationRuns = pgTable(
  "automation_runs",
  {
    id: id(),
    enrolmentId: uuid().references(() => automationEnrolments.id, { onDelete: "restrict" }),
    personId: uuid()
      .notNull()
      .references(() => persons.id, { onDelete: "restrict" }),
    automationId: uuid()
      .notNull()
      .references(() => automations.id, { onDelete: "restrict" }),
    automationVersionId: uuid().references(() => automationVersions.id, { onDelete: "restrict" }),
    stepKey: text(),
    outcome: automationRunsOutcome().notNull(),
    reason: text(),
    data: jsonb().$type<RunDataJson>().notNull().default({}),
    emailMessageId: uuid().references(() => emailMessages.id, { onDelete: "restrict" }),
    // FK to crm's tasks is added once that table is in the base (Requests).
    taskId: uuid(),
    actor: jsonb().$type<ActorJson>().notNull(),
    dedupeKey: text().unique("automation_runs_dedupe_key_unique"),
    occurredAt: tstz().notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    index("automation_runs_person_idx").on(t.personId, t.occurredAt.desc()),
    index("automation_runs_enrolment_idx").on(t.enrolmentId, t.occurredAt),
    index("automation_runs_automation_idx").on(t.automationId, t.occurredAt.desc()),
    index("automation_runs_issues_idx")
      .on(t.occurredAt.desc())
      .where(sql`${t.outcome} in ('failed', 'skipped_translation')`),
  ],
);
