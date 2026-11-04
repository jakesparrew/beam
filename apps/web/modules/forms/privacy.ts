/**
 * forms's GDPR registration (forms spec section 9, architecture section 11, ops rule 62).
 * Facade read by `pnpm gen:indexes`. forms-P1 registers every forms table that holds personal
 * data and lists the four tables without it in `noPiiTables`; forms-P3 implements `export`,
 * `erase` and the retention `sweep` handlers (keys `forms.form_submissions`,
 * `forms.form_sensitive_answers`, `forms.form_submissions_anonymous_abandoned`,
 * `forms.form_sensitive_answers_unlinked`, `forms.form_submissions_ip_hash`,
 * `forms.form_import_events`, `forms.form_views_daily`).
 */
import type { Tx } from "@beam/db";
import type { PrivacyRegistration } from "@beam/core/privacy";

export const privacy: PrivacyRegistration<Tx> = {
  tables: ["form_submissions", "form_sensitive_answers", "form_links", "form_import_events"],
  export: () => Promise.resolve({}),
  erase: () => Promise.resolve([]),
};

/** Definitions, staff user ids, aggregates and secret hashes only (forms spec section 9). */
export const noPiiTables = ["forms", "form_versions", "form_views_daily", "form_import_sources"];
