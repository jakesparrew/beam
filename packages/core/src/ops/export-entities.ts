/**
 * Entity CSV exports (ops rules 54-57). The column lists per entity live with the export jobs
 * (`apps/web/modules/ops/exports/entities.ts`, ops-P6); this file names the entities, which of
 * them need `invoices.read`, and the export limits.
 */

export const EXPORT_ENTITIES = [
  "persons",
  "companies",
  "company_contacts",
  "tags",
  "consents",
  "suppressions",
  "bookings",
  "sessions",
  "orders",
  "order_lines",
  "payments",
  "refunds",
  "invoices",
  "credit_grants",
  "credit_entries",
  "memberships",
  "form_submissions",
  "email_messages",
  "campaigns",
  "tasks",
  "activity_events",
] as const;
export type ExportEntity = (typeof EXPORT_ENTITIES)[number];

/** Entities that also need `invoices.read` (ops spec 4.1 and section 7). */
export const FINANCE_EXPORT_ENTITIES = ["invoices", "payments", "refunds"] as const satisfies readonly ExportEntity[];

export const DATA_EXPORT_KINDS = ["entity", "full"] as const;
export type DataExportKind = (typeof DATA_EXPORT_KINDS)[number];

export const DATA_EXPORT_STATUSES = ["queued", "running", "done", "failed", "expired"] as const;
export type DataExportStatus = (typeof DATA_EXPORT_STATUSES)[number];

/** Rule 55: rows per chunk (one CSV part), the part size limit and the file lifetime. */
export const EXPORT_CHUNK_ROWS = 5000;
export const EXPORT_PART_MAX_BYTES = 9 * 1024 * 1024;
export const EXPORT_EXPIRY_DAYS = 7;

/** Column names never exported by staff exports (rule 54), besides `SENSITIVE_COLUMNS`. */
export const EXPORT_EXCLUDED_COLUMNS = [
  "password_hash",
  "totp_secret",
  "totp_secret_enc",
  "recovery_codes",
  "recovery_codes_enc",
  "token_hash",
  "raw",
] as const;
