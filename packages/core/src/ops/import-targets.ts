/**
 * Import kinds, sources and target fields (ops spec 2.2 `imports`, rules 42-43). Every kind
 * also accepts `external_id`. No target is a sensitive field.
 */

export const IMPORT_KINDS = ["persons", "suppressions", "consents", "tags", "companies", "bookings", "packages", "memberships", "history"] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

export const IMPORT_SOURCES = [
  "simplybook",
  "lightspeed",
  "mailchimp",
  "spreadsheet",
  "event_db",
  "b2b_list",
  "webinar_tool",
  "assessment_tool",
  "other",
] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];

export const IMPORT_STATUSES = ["uploaded", "dry_run", "running", "done", "failed", "cancelled"] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

export const IMPORT_ROW_STATUSES = ["pending", "imported", "updated", "skipped", "error"] as const;
export type ImportRowStatus = (typeof IMPORT_ROW_STATUSES)[number];

export const IMPORT_ENTITY_TYPES = ["person", "company", "booking", "grant", "membership", "suppression", "consent", "tag", "history"] as const;
export type ImportEntityType = (typeof IMPORT_ENTITY_TYPES)[number];

/** `import_external_ids.entity_type`. */
export const EXTERNAL_ID_ENTITY_TYPES = ["person", "company", "booking", "grant", "membership"] as const;
export type ExternalIdEntityType = (typeof EXTERNAL_ID_ENTITY_TYPES)[number];

export const IMPORTED_HISTORY_KINDS = [
  "purchase",
  "visit",
  "no_show",
  "cancellation",
  "event_attendance",
  "webinar_registration",
  "webinar_attendance",
  "assessment_result",
  "email_engagement",
] as const;
export type ImportedHistoryKind = (typeof IMPORTED_HISTORY_KINDS)[number];

export const IMPORTED_PRODUCT_KINDS = ["session", "night", "package", "membership", "ticket", "item", "voucher"] as const;

/** The target fields per kind, `external_id` included. */
export const IMPORT_TARGETS = {
  persons: [
    "external_id",
    "email",
    "phone",
    "first_name",
    "last_name",
    "locale",
    "birth_on",
    "street",
    "postal_code",
    "city",
    "country",
    "preferred_channel",
    "company_name",
    "created_at",
    "source_campaign",
  ],
  suppressions: ["external_id", "email", "scope", "reason", "suppressed_at"],
  consents: ["external_id", "email", "purpose", "status", "recorded_at", "wording_version", "source"],
  tags: ["external_id", "email", "tag_key"],
  companies: [
    "external_id",
    "name",
    "vat_number",
    "street",
    "postal_code",
    "city",
    "country",
    "website",
    "industry",
    "size",
    "contact_email",
    "contact_position",
    "contact_decision_role",
  ],
  bookings: ["external_id", "email", "session_starts_at", "session_kind", "paid_with"],
  packages: ["external_id", "email", "product_sku", "units_remaining", "units_original", "expires_on", "unit_value_cents"],
  memberships: ["external_id", "email", "product_sku", "period_end_on", "started_on", "status"],
  history: [
    "external_id",
    "email",
    "history_kind",
    "occurred_at",
    "description",
    "amount_cents",
    "product_kind",
    "session_kind",
    "campaign",
    "webinar_title",
    "webinar_starts_at",
    "outcome_key",
  ],
} as const satisfies Record<ImportKind, readonly string[]>;

export type TargetField<K extends ImportKind = ImportKind> = (typeof IMPORT_TARGETS)[K][number];

/** The options of `ImportMapping.options` that can stand in for a column (rule 43). */
export type ImportOptionsForRequired = { productId?: string; tagKey?: string };

/**
 * Rule 43: the required targets that the mapping does not cover. Alternatives are reported as
 * one entry joined by `|` (for example `email|phone+last_name`).
 */
export function missingTargets(kind: ImportKind, mapped: readonly string[], options: ImportOptionsForRequired = {}): string[] {
  const has = (t: string) => mapped.includes(t);
  const missing: string[] = [];
  const need = (t: string) => {
    if (!has(t)) missing.push(t);
  };
  switch (kind) {
    case "persons":
      if (!has("email") && !(has("phone") && has("last_name"))) missing.push("email|phone+last_name");
      break;
    case "suppressions":
      need("email");
      break;
    case "consents":
      need("email");
      need("status");
      break;
    case "tags":
      need("email");
      if (!has("tag_key") && !options.tagKey) missing.push("tag_key|option:tagKey");
      break;
    case "companies":
      need("name");
      break;
    case "bookings":
      need("email");
      need("session_starts_at");
      break;
    case "packages":
      need("email");
      need("units_remaining");
      need("expires_on");
      if (!has("product_sku") && !options.productId) missing.push("product_sku|option:productId");
      break;
    case "memberships":
      need("email");
      need("product_sku");
      need("period_end_on");
      break;
    case "history":
      need("email");
      need("occurred_at");
      need("history_kind");
      need("external_id");
      break;
  }
  return missing;
}

/** Rule 42: upload limits. */
export const IMPORT_MAX_BYTES = 50 * 1024 * 1024;
export const IMPORT_PART_BYTES = 3 * 1024 * 1024;
export const IMPORT_MAX_PARTS = 17;
export const IMPORT_SAMPLE_ROWS = 20;
/** Rule 51: rows per `import.process_chunk` job. */
export const IMPORT_CHUNK_ROWS = 500;
