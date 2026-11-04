/**
 * email's GDPR registration (email spec section 9, architecture section 11, ops rule 62).
 * Facade read by `pnpm gen:indexes`. email-P1 registers every email table that holds a person
 * reference, directly (`email_messages.person_id`, `campaign_recipients.person_id`) or through a
 * message (`email_events`), plus the tables without person data. `export` and `erase` are
 * implemented by email's privacy package; until then they report nothing, as in Wave 0.
 */
import type { Tx } from "@beam/db";
import type { PrivacyRegistration } from "@beam/core/privacy";

export const privacy: PrivacyRegistration<Tx> = {
  tables: ["email_messages", "email_events", "campaign_recipients", "email_ai_drafts"],
  export: () => Promise.resolve({}),
  erase: () => Promise.resolve([]),
};

/** Staff user ids only (email spec section 9): nothing to export or erase for a person. */
export const noPiiTables = ["campaigns", "email_templates", "email_template_versions"] as const;
