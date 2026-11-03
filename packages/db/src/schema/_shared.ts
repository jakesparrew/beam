/**
 * Shared schema helpers (platform-P2, frozen after Wave 0).
 *
 * Every module's schema file builds its tables from these helpers. Columns without an
 * explicit name get their snake_case name from the property key (`casing: 'snake_case'`).
 * `_shared.ts` is not part of the generated schema index, so `platform.ts` re-exports the
 * shared enum `localeEnum` (drizzle-kit only creates enums it finds in the schema index).
 */
import { sql, type SQL } from "drizzle-orm";
import {
  check,
  customType,
  integer,
  jsonb,
  numeric,
  pgEnum,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

/** `{ "nl-BE"?, "fr-BE"?, "en"? }` (structurally identical to `LocalizedText` of `@beam/core/i18n`). */
export type LocalizedText = { "nl-BE"?: string; "fr-BE"?: string; en?: string };

export const LOCALES = ["nl-BE", "fr-BE", "en"] as const;
export type Locale = (typeof LOCALES)[number];

/** Who did something, as stored in `actor jsonb` columns (`audit_log`, `ai_requests`, ledgers). */
export type ActorJson = {
  kind: "staff" | "customer" | "system" | "job" | "webhook";
  id: string | null;
  roleKey?: string;
  provider?: string;
};

/** The shared enum `locale` (`nl-BE|fr-BE|en`). */
export const localeEnum = pgEnum("locale", LOCALES);

/** `id uuid primary key default gen_random_uuid()`. */
export const id = () => uuid("id").primaryKey().defaultRandom();

/** `created_at timestamptz not null default now()`. */
export const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/** `updated_at timestamptz not null default now()`, refreshed by Drizzle on every update. */
export const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/** `created_at` and `updated_at` (mutable tables only). */
export const timestamps = () => ({
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** A `timestamptz` column (name from the property key unless given). */
export const tstz = (name?: string) =>
  name === undefined
    ? timestamp({ withTimezone: true })
    : timestamp(name, { withTimezone: true });

/** Localised text: `jsonb` typed `LocalizedText`. */
export const localized = (name?: string) =>
  (name === undefined ? jsonb() : jsonb(name)).$type<LocalizedText>();

/** Money: integer cents in EUR. */
export const money = (name?: string) =>
  name === undefined ? integer() : integer(name);

/** VAT rate `numeric(4,2)`; pair it with `vatRateCheck()`. */
export const vatRate = (name?: string) =>
  name === undefined
    ? numeric({ precision: 4, scale: 2 })
    : numeric(name, { precision: 4, scale: 2 });

/** Check `<column> in (0, 6, 12, 21)` (nulls pass). */
export const vatRateCheck = (name: string, column: AnyPgColumn) =>
  check(name, sql`${column} in (0, 6, 12, 21)`);

/** `bytea` mapped to `Uint8Array`. */
export const bytea = customType<{
  data: Uint8Array;
  driverData: Uint8Array | Buffer;
}>({
  dataType: () => "bytea",
  fromDriver: (value) =>
    value instanceof Uint8Array ? value : new Uint8Array(value),
});

/** Unique index on `lower(<column>)`, optionally partial. */
export const lowerEmailUnique = (
  name: string,
  column: AnyPgColumn,
  where?: SQL,
) => {
  const index = uniqueIndex(name).on(sql`lower(${column})`);
  return where ? index.where(where) : index;
};

// ---------------------------------------------------------------------------
// Markings
// ---------------------------------------------------------------------------

/** Special-category columns (health, sleep, stress, recovery, wellbeing, medical). */
export const SENSITIVE_COLUMNS: {
  table: string;
  column: string;
  keyColumn: string;
}[] = [];

/**
 * Declares a column as sensitive and registers it in `SENSITIVE_COLUMNS`. The column must be
 * built with an explicit SQL name (`bytea('value_enc')`); `keyColumn` names the column (or
 * `data.key_version` path) holding the encryption key version.
 */
export function sensitive<T>(
  column: T,
  opts: { table: string; keyColumn: string },
): T {
  const name = (column as { config?: { name?: string } }).config?.name;
  if (!name)
    throw new Error(
      `sensitive(): give the column of ${opts.table} an explicit SQL name`,
    );
  if (
    !SENSITIVE_COLUMNS.some((c) => c.table === opts.table && c.column === name)
  ) {
    SENSITIVE_COLUMNS.push({
      table: opts.table,
      column: name,
      keyColumn: opts.keyColumn,
    });
  }
  return column;
}

/**
 * Every append-only or immutable-row table of all twelve modules (data model rule 6), in
 * alphabetical order, including tables later waves create. `0002_append_only.sql` is generated
 * from this list by `scripts/append-only-sql.ts`.
 */
export const APPEND_ONLY_TABLES = [
  "activity_events",
  "ai_requests",
  "audit_log",
  "automation_runs",
  "automation_versions",
  "consent_records",
  "cookie_consents",
  "credit_entries",
  "email_events",
  "imported_history",
  "integration_calls",
  "lightspeed_sales",
  "membership_periods",
  "order_lines",
  "person_declarations",
  "person_merges",
  "price_versions",
  "site_audit_reports",
  "suppressions",
  "terms_acceptances",
  "watch_segments",
  "webhook_events",
  "webinar_interactions",
  "webinar_moderation_actions",
] as const;
export type AppendOnlyTable = (typeof APPEND_ONLY_TABLES)[number];

/**
 * Versioned definitions whose published rows are never edited (data model rule 7). The guard
 * of the last four is service code, not a trigger; `invoices` is immutable after issue at
 * column level.
 */
export const IMMUTABLE_TABLES = [
  "automation_versions",
  "consent_wordings",
  "email_template_versions",
  "form_versions",
  "invoices",
  "order_lines",
  "page_versions",
] as const;
export type ImmutableTable = (typeof IMMUTABLE_TABLES)[number];
