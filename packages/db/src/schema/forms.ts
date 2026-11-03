/**
 * forms contract stub created by Wave 0 on behalf of forms (platform-P2): `forms` with its
 * architecture columns (data model 1.2.7). forms takes the file over and completes it without
 * changing these columns.
 */
import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { id, localized, timestamps } from "./_shared";

export const formsKind = pgEnum("forms_kind", [
  "lead",
  "intake",
  "survey",
  "assessment",
  "registration",
]);
export const formsStatus = pgEnum("forms_status", [
  "draft",
  "published",
  "archived",
]);

export const forms = pgTable(
  "forms",
  {
    id: id(),
    slug: text().notNull(),
    kind: formsKind().notNull(),
    name: localized().notNull(),
    status: formsStatus().notNull().default("draft"),
    // FK to form_versions is added by forms with that table (Wave 1).
    currentVersionId: uuid(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("forms_slug_uq").on(t.slug),
    index("forms_status_idx").on(t.status),
    check(
      "forms_slug_ck",
      sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(${t.slug}) <= 64 and ${t.slug} not in ('result', 'import')`,
    ),
    check(
      "forms_published_version_ck",
      sql`${t.status} <> 'published' or ${t.currentVersionId} is not null`,
    ),
  ],
);
