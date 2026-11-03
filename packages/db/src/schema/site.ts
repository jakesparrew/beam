/**
 * site contract stub created by Wave 0 on behalf of site (platform-P2): `pages` with its
 * architecture columns (data model 1.2.11). site takes the file over and adds the versions,
 * routes and the remaining columns and foreign keys.
 */
import { sql } from "drizzle-orm";
import { check, index, pgEnum, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { id, timestamps } from "./_shared";

export const pagesKind = pgEnum("pages_kind", [
  "home",
  "standard",
  "offer",
  "pricing",
  "events_index",
  "event",
  "blog_index",
  "post",
  "contact",
  "legal",
  "landing",
]);
export const pagesStatus = pgEnum("pages_status", [
  "draft",
  "published",
  "archived",
]);

export const pages = pgTable(
  "pages",
  {
    id: id(),
    kind: pagesKind().notNull(),
    slug: text().notNull().unique(),
    status: pagesStatus().notNull().default("draft"),
    // FK to page_versions is added by site with that table (Wave 1).
    currentVersionId: uuid(),
    ...timestamps(),
  },
  (t) => [
    index("pages_kind_status_idx").on(t.kind, t.status),
    check(
      "pages_slug_ck",
      sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(${t.slug}) <= 80`,
    ),
  ],
);
