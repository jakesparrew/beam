/**
 * `seedAutomation(tx)` (automation-P4; internal, not exported from `api.ts`): writes the seeded
 * groups, tags, block-backed templates (through email's `seedTemplate`) and journeys of spec 3.6.
 * Inserts a slug only when absent and never overwrites (decisions 30, 38); a second run returns
 * zero counts. The writer is `seedAutomationRows` of `@beam/db/seed/automation`, which the
 * `defaults` profile also runs.
 */
import type { Tx } from "@beam/db";
import { seedAutomationRows, type AutomationSeedCounts } from "@beam/db/seed/automation";
import { seedTemplate } from "@/modules/email/api";

export type { AutomationSeedCounts } from "@beam/db/seed/automation";

export function seedAutomation(tx: Tx): Promise<AutomationSeedCounts> {
  return seedAutomationRows(tx, { seedTemplate: (db, input) => seedTemplate(db as Tx, input) });
}
