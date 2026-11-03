/**
 * automation contract stub created by Wave 0 on behalf of automation (platform-P2):
 * `automations` with its architecture columns (data model 1.2.9). automation takes the file
 * over and adds `automation_groups`, the versions, enrolments, runs and the foreign keys.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  pgEnum,
  pgTable,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import { id, timestamps } from "./_shared";

export const automationsStatus = pgEnum("automations_status", [
  "draft",
  "active",
  "paused",
  "archived",
]);
export const automationsPurpose = pgEnum("automations_purpose", [
  "newsletter",
  "events",
  "member_comms",
  "b2b",
]);

export const automations = pgTable(
  "automations",
  {
    id: id(),
    slug: text().notNull().unique(),
    name: text().notNull(),
    // FK to automation_groups is added by automation with that table (Wave 1).
    groupId: uuid().notNull(),
    // FK to automation_versions is added by automation with that table (Wave 1).
    currentVersionId: uuid(),
    status: automationsStatus().notNull().default("draft"),
    isMarketing: boolean().notNull().default(true),
    purpose: automationsPurpose(),
    ...timestamps(),
  },
  (t) => [
    index("automations_status_idx").on(t.status),
    index("automations_group_idx").on(t.groupId),
    check("automations_slug_ck", sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
    check(
      "automations_version_ck",
      sql`${t.status} = 'draft' or ${t.currentVersionId} is not null`,
    ),
    check(
      "automations_purpose_ck",
      sql`${t.isMarketing} = false or ${t.purpose} is not null`,
    ),
  ],
);
