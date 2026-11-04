/**
 * crm's GDPR registration (crm spec section 9, cross-module D69). Facade read by
 * `pnpm gen:indexes`. crm-P1 registers every V1 crm table that references a person, the tables
 * without person data, the retention policies and their sweeps. `export` and `erase` are
 * implemented by crm-P7 (they run last in the erase order, over `resolvePersonIds`); until then
 * they report nothing, as in Wave 0.
 */
import type { Tx } from "@beam/db";
import type { PrivacyRegistration, RetentionPolicySeed } from "@beam/core/privacy";
import { sql, type DbOrTx } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";

const affected = async (tx: DbOrTx, q: ReturnType<typeof sql>) => rowsOf(await tx.execute(q)).length;

/** crm's retention keys (crm spec 9, cross-module D37); ops seeds them from `GDPR_REGISTRY`. */
export const retention: readonly RetentionPolicySeed[] = [
  { key: "crm.duplicate_candidates_closed", tableName: "person_duplicate_candidates", days: 365, action: "delete", description: "Reviewed (merged or dismissed) duplicate candidates" },
  { key: "crm.tasks_closed", tableName: "tasks", days: 730, action: "delete", description: "Done and cancelled tasks" },
  { key: "crm.declarations_superseded", tableName: "person_declarations", days: 1095, action: "delete", description: "Guardian consents that are not the latest per person and kind" },
  { key: "crm.suppressions", tableName: "suppressions", days: null, action: "keep", description: "Kept forever to honour the objection" },
  { key: "crm.consent_records", tableName: "consent_records", days: null, action: "keep", description: "Proof of consent, kept for the life of the profile" },
];

/** One handler per non-`keep` retention key: deletes rows older than `cutoff`, returns the count. */
export const sweep: Record<string, (tx: Tx, cutoff: Date) => Promise<number>> = {
  "crm.duplicate_candidates_closed": (tx, cutoff) =>
    affected(tx, sql`delete from person_duplicate_candidates where status <> 'open' and coalesce(reviewed_at, updated_at) < ${cutoff} returning id`),
  "crm.tasks_closed": (tx, cutoff) => affected(tx, sql`delete from tasks where status in ('done', 'cancelled') and updated_at < ${cutoff} returning id`),
  "crm.declarations_superseded": async (tx, cutoff) => {
    await tx.execute(sql`set local beam.allow_rewrite = 'on'`);
    return affected(
      tx,
      sql`delete from person_declarations d where d.accepted_at < ${cutoff}
        and exists (select 1 from person_declarations n where n.person_id = d.person_id and n.kind = d.kind
          and (n.accepted_at, n.id) > (d.accepted_at, d.id))
        returning d.id`,
    );
  },
};

export const privacy: PrivacyRegistration<Tx> = {
  tables: [
    "persons",
    "person_merges",
    "person_duplicate_candidates",
    "person_sensitive_fields",
    "person_declarations",
    "consent_records",
    "suppressions",
    "activity_events",
    "person_tags",
    "segment_members",
    "tasks",
    "company_contacts",
  ],
  export: () => Promise.resolve({}),
  erase: () => Promise.resolve([]),
  sweep,
  retention,
};

/** crm tables that hold no person data (crm spec 9). */
export const noPiiTables = ["consent_wordings", "tags", "segments"] as const;
