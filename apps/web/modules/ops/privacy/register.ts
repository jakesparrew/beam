/**
 * ops' own `export` and `erase` for its GDPR registration (ops spec section 9; ops-P5). Wired into
 * `../privacy.ts` (the facade `pnpm gen:indexes` reads).
 *
 * | Table | Export | Erase |
 * | `person_stats` | yes | deleted |
 * | `import_rows` | no | deleted |
 * | `imported_history` | yes | deleted (append table; the step runs under `beam.allow_rewrite`) |
 * | `import_external_ids` | no | deleted for the person and their remaining grants, bookings and memberships |
 * | `privacy_requests` | yes | kept (`retained_legal`, accountability); its export files deleted |
 * | `processing_restrictions` | yes | deleted |
 * | `retention_list_items` | yes | deleted |
 * | `attribution_credits` | no | deleted |
 * | `nl_questions` | no | not person-linked (purged after 30 days) |
 */
import type { Tx } from "@beam/db";
import type { EraseReportRow, PrivacyExport } from "@beam/core/privacy";
import { sql, type DbOrTx, type SQL } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { deleteExportFiles } from "./export-zip";

const rows = async <T = Record<string, unknown>>(tx: DbOrTx, q: SQL) => rowsOf<T>(await tx.execute(q));
const count = async (tx: DbOrTx, q: SQL) => Number(rowsOf<{ n: number }>(await tx.execute(sql`with gone as (${q}) select count(*)::int as n from gone`))[0]?.n ?? 0);

/** The subject's ops data (named columns; ids of other people never appear). */
export async function exportOpsPerson(tx: DbOrTx, personId: string): Promise<PrivacyExport> {
  const id = sql`${personId}::uuid`;
  return {
    person_stats: await rows(
      tx,
      sql`select revenue_cents, purchases, visits, visits_last_60d, events_attended, no_shows, late_cancellations, avg_order_cents,
        first_purchase_at, last_purchase_at, first_visit_at, last_visit_at, last_activity_at, next_booking_at, b2c_stage, computed_at
        from person_stats where person_id = ${id}`,
    ),
    imported_history: await rows(
      tx,
      sql`select source, kind, occurred_at, external_id, description, amount_cents, product_kind, data, created_at
        from imported_history where person_id = ${id} order by occurred_at`,
    ),
    privacy_requests: await rows(
      tx,
      sql`select id, kind, status, requested_by, due_on, verified_at, scheduled_for_at, rectify_fields, completed_at, created_at
        from privacy_requests where person_id = ${id} order by created_at`,
    ),
    processing_restrictions: await rows(tx, sql`select reason, created_at from processing_restrictions where person_id = ${id}`),
    retention_list_items: await rows(
      tx,
      sql`select l.week_start_on, i.rank, i.score, i.primary_reason, i.reasons, i.actioned_at, i.dismissed_at
        from retention_list_items i join retention_lists l on l.id = i.list_id where i.person_id = ${id} order by l.week_start_on`,
    ),
  };
}

/** Deletes or keeps ops' rows of the subject; counts and actions only. */
export async function eraseOpsPerson(tx: Tx, personId: string): Promise<EraseReportRow[]> {
  const id = sql`${personId}::uuid`;
  const out: EraseReportRow[] = [];
  out.push({ table: "person_stats", rows: await count(tx, sql`delete from person_stats where person_id = ${id} returning 1`), action: "deleted" });
  out.push({ table: "import_rows", rows: await count(tx, sql`delete from import_rows where person_id = ${id} returning 1`), action: "deleted" });
  out.push({ table: "imported_history", rows: await count(tx, sql`delete from imported_history where person_id = ${id} returning 1`), action: "deleted" });
  out.push({
    table: "import_external_ids",
    rows: await count(
      tx,
      sql`delete from import_external_ids x where (x.entity_type = 'person' and x.entity_id = ${id})
        or (x.entity_type = 'grant' and x.entity_id in (select g.id from credit_grants g where g.person_id = ${id}))
        or (x.entity_type = 'booking' and x.entity_id in (select b.id from bookings b where b.person_id = ${id}))
        or (x.entity_type = 'membership' and x.entity_id in (select m.id from memberships m where m.person_id = ${id}))
        returning 1`,
    ),
    action: "deleted",
  });
  out.push({ table: "processing_restrictions", rows: await count(tx, sql`delete from processing_restrictions where person_id = ${id} returning 1`), action: "deleted" });
  out.push({ table: "retention_list_items", rows: await count(tx, sql`delete from retention_list_items where person_id = ${id} returning 1`), action: "deleted" });
  out.push({ table: "attribution_credits", rows: await count(tx, sql`delete from attribution_credits where person_id = ${id} returning 1`), action: "deleted" });

  // privacy_requests stay as proof (accountability); their export zips go.
  const requests = await rows<{ id: string; file_ids: string[] | null }>(
    tx,
    sql`select id::text as id, array_remove(array_prepend(file_id, part_file_ids), null)::text[] as file_ids from privacy_requests where person_id = ${id}`,
  );
  const fileIds = requests.flatMap((r) => r.file_ids ?? []);
  if (fileIds.length) {
    await tx.execute(sql`update privacy_requests set file_id = null, part_file_ids = '{}', updated_at = now() where person_id = ${id}`);
    await deleteExportFiles(tx, fileIds);
  }
  out.push({ table: "privacy_requests", rows: requests.length, action: "kept" });
  return out;
}
