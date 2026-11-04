/**
 * ops's `defaults` seed (ops-P1, ops spec 12 and section 9), also run in production. Every
 * insert is `on conflict (key) do nothing`, so a staff edit survives re-seeding and two seeders
 * never fight:
 *
 * - the `retention_policies` rows ops seeds (its own keys and those of webinar, finance,
 *   automation, crm, platform and the forms keys of section 9, whose handlers live in those
 *   modules); `apps/web/modules/ops/seed.ts` adds every module's declared `retention` seeds;
 * - one `dpia_records` row per DPIA key (status `not_started`);
 * - the `settings` row `retention_defaults` with the spec 2.4 thresholds;
 * - the 17 `cutover_checklist_items` rows, all open.
 */
import { CUTOVER_STEPS, DPIA_KEYS, RETENTION_DEFAULTS } from "@beam/core/ops";
import type { RetentionPolicySeed } from "@beam/core/privacy";
import type { DbOrTx } from "../client";
import { cutoverChecklistItems, dpiaRecords, retentionPolicies } from "../schema/ops";
import { settings } from "../schema/platform";
import type { DefaultSeed } from "./run";

type Row = RetentionPolicySeed & { runOrder: number };

const row = (runOrder: number, key: string, tableName: string, days: number | null, action: Row["action"], description: string): Row => ({
  runOrder,
  key,
  tableName,
  days,
  action,
  description,
});

/** Ops spec section 9, "Rows seeded by ops" (31 rows). */
export const OPS_RETENTION_POLICIES: readonly Row[] = [
  row(10, "ops.marketing_contact", "persons", 730, "anonymise", "Marketing contacts who never became customers, after 2 years without activity"),
  row(11, "ops.marketing_profile", "persons", 1095, "anonymise", "Customer profiles after 3 years without activity, order, booking, login, credits or open invoice"),
  row(20, "forms.form_sensitive_answers", "form_sensitive_answers", 1095, "delete", "Sensitive assessment answers after 3 years"),
  row(30, "forms.form_submissions", "form_submissions", 1095, "delete", "Form submissions (scores and outcomes) after 3 years"),
  row(40, "webinar.watch_segments", "watch_segments", 730, "delete", "Webinar watch time after 2 years"),
  row(41, "webinar.webinar_interactions", "webinar_interactions", 730, "delete", "Webinar chat and poll answers after 2 years"),
  row(42, "webinar.webinar_registrations", "webinar_registrations", 1095, "delete", "Webinar registrations and attendance after 3 years, once the webinar ended"),
  row(90, "finance.invoices", "invoices", 3653, "anonymise", "Invoices: customer details removed 10 years after the fiscal year; totals, lines and numbers kept"),
  row(91, "finance.invoice_requests", "invoice_requests", 730, "delete", "Decided or cancelled invoice requests after 2 years"),
  row(92, "finance.billit_reconcile_runs", "billit_reconcile_runs", 400, "delete", "Billit reconciliation runs after 400 days"),
  row(93, "finance.finance_exports", "finance_exports", 90, "delete", "Accountant exports after 90 days"),
  row(94, "crm.declarations_superseded", "person_declarations", 1095, "delete", "Superseded declarations (not the latest per person and kind) after 3 years"),
  row(95, "automation.automation_runs", "automation_runs", 730, "delete", "Automation run history after 2 years"),
  row(96, "automation.automation_enrolments", "automation_enrolments", 1095, "delete", "Ended automation enrolments after 3 years"),
  row(97, "crm.duplicate_candidates_closed", "person_duplicate_candidates", 365, "delete", "Closed duplicate candidates after 1 year"),
  row(98, "crm.tasks_closed", "tasks", 730, "delete", "Closed tasks after 2 years"),
  row(99, "crm.inbox_resolved", "inbox_threads", 730, "delete", "Resolved inbox threads after 2 years"),
  row(100, "platform.audit_log", "audit_log", 1826, "delete", "Audit log after 5 years"),
  row(110, "platform.ai_requests", "ai_requests", 30, "delete", "AI prompts and outputs after 30 days"),
  row(120, "platform.webhook_events", "webhook_events", 90, "delete", "Provider webhook payloads after 90 days"),
  row(130, "platform.integration_calls", "integration_calls", 90, "delete", "Integration call logs after 90 days"),
  row(140, "platform.jobs", "jobs", 7, "delete", "Succeeded jobs after 7 days, dead jobs after 90 days"),
  row(150, "ops.import_rows", "import_rows", 30, "delete", "Migration import rows after 30 days"),
  row(160, "platform.files_export", "files", 7, "delete", "Export files after 7 days"),
  row(165, "platform.files_rendered_email", "files", 30, "delete", "Rendered email copies after 30 days"),
  row(170, "ops.nl_questions", "nl_questions", 30, "delete", "Questions asked to the AI after 30 days"),
  row(175, "ops.data_exports", "data_exports", 30, "delete", "Data export records after 30 days (expired first)"),
  row(176, "ops.retention_lists", "retention_lists", 730, "delete", "Weekly retention lists after 2 years"),
  row(180, "ops.privacy_requests", "privacy_requests", 1825, "delete", "Privacy requests (proof of handling) after 5 years"),
  row(190, "crm.suppressions", "suppressions", null, "keep", "Suppression fingerprints are kept indefinitely so an opt-out survives every import"),
  row(200, "crm.consent_records", "consent_records", null, "keep", "Consent history is kept while the person exists, as proof of consent"),
];

/** Inserts retention policy rows; existing keys are left untouched. */
export async function insertRetentionPolicies(db: DbOrTx, rows: readonly RetentionPolicySeed[]): Promise<void> {
  for (const p of rows) {
    await db
      .insert(retentionPolicies)
      .values({
        key: p.key,
        tableName: p.tableName,
        days: p.days,
        action: p.action,
        description: p.description,
        ...(p.runOrder !== undefined ? { runOrder: p.runOrder } : {}),
        ...(p.batchSize !== undefined ? { batchSize: p.batchSize } : {}),
      })
      .onConflictDoNothing({ target: retentionPolicies.key });
  }
}

/** The ops defaults; idempotent. */
export async function seedOpsDefaults(db: DbOrTx): Promise<void> {
  await db.insert(settings).values({ key: "retention_defaults", value: RETENTION_DEFAULTS }).onConflictDoNothing({ target: settings.key });
  await insertRetentionPolicies(db, OPS_RETENTION_POLICIES);
  await db
    .insert(dpiaRecords)
    .values(DPIA_KEYS.map((key) => ({ key })))
    .onConflictDoNothing({ target: dpiaRecords.key });
  await db
    .insert(cutoverChecklistItems)
    .values(CUTOVER_STEPS.map((key) => ({ key })))
    .onConflictDoNothing({ target: cutoverChecklistItems.key });
}

export const seed: DefaultSeed = {
  after: ["platform"],
  run: (db) => seedOpsDefaults(db),
};
