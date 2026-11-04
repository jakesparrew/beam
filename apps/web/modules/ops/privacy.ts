/**
 * ops's GDPR registration (ops spec 9, architecture section 11, ops rule 62). Facade read by
 * `pnpm gen:indexes`. ops-P1 registers every ops table that references a person (OD-9) and the
 * tables without person data (`noPiiTables`); ops-P5 implements `export` and `erase` (and wires
 * the `sweep` handlers of ops-P6's `exports/sweep.ts`). ops' own retention rows are seeded by
 * `packages/db/src/seed/ops.ts`, so `retention` stays unset.
 */
import type { Tx } from "@beam/db";
import type { PrivacyRegistration } from "@beam/core/privacy";

export const privacy: PrivacyRegistration<Tx> = {
  tables: [
    "person_stats",
    "import_rows",
    "imported_history",
    "import_external_ids",
    "privacy_requests",
    "processing_restrictions",
    "retention_list_items",
    "attribution_credits",
    "nl_questions",
  ],
  export: () => Promise.resolve({}),
  erase: () => Promise.resolve([]),
};

/** ops tables that hold no person data (ops spec 9). */
export const noPiiTables = [
  "ad_spend_daily",
  "dashboards",
  "management_summaries",
  "retention_policies",
  "dpia_records",
  "data_exports",
  "cutover_checklist_items",
  "ops_state",
] as const;
