/**
 * automation's GDPR registration (automation spec section 9, ops rule 62). Facade read by
 * `pnpm gen:indexes`. automation-P1 registers the two tables that reference a person and lists
 * the configuration tables in `noPiiTables`; automation-P2 implements `export`, `erase` and the
 * `sweep` handlers (`automation.automation_runs`, `automation.automation_enrolments`).
 */
import type { Tx } from "@beam/db";
import type { PrivacyRegistration } from "@beam/core/privacy";

export const privacy: PrivacyRegistration<Tx> = {
  tables: ["automation_enrolments", "automation_runs"],
  export: () => Promise.resolve({}),
  erase: () => Promise.resolve([]),
};

/** Configuration tables: staff user ids only, no personal data (section 9). */
export const noPiiTables = ["automation_groups", "automations", "automation_versions"];
