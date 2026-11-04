/**
 * The generic retention handler (ops rule 68, ops-P6): deletes rows older than the cutoff from an
 * allow-listed table, `batch_size` rows per call, by `created_at`.
 *
 * Decision (02-data-model DM-8 vs the ops-P6 package): every module now owns a `sweep[key]`
 * handler, site's three keys included, and the sweep always prefers it. The generic handler is
 * only the fallback for a policy whose owner registers no handler and whose table is listed in
 * `GENERIC_SWEEP_TABLES` (site's three tables, the case rule 68 names). Nothing else is ever
 * deleted generically. The caller runs it under `SET LOCAL beam.allow_rewrite = 'on'`, without
 * which the append-only trigger refuses the delete on `cookie_consents` and `terms_acceptances`.
 */
import type { Tx } from "@beam/db";
import { sql } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";

/** Tables the generic handler may delete from, with the column the age is measured on. */
export const GENERIC_SWEEP_TABLES: Readonly<Record<string, { dateColumn: "created_at" }>> = {
  cookie_consents: { dateColumn: "created_at" },
  terms_acceptances: { dateColumn: "created_at" },
  page_edit_requests: { dateColumn: "created_at" },
};

export function isGenericSweepTable(table: string): boolean {
  return Object.prototype.hasOwnProperty.call(GENERIC_SWEEP_TABLES, table);
}

/** Deletes at most `batchSize` rows of `table` created before `cutoff`; returns the count. */
export async function genericSweep(tx: Tx, table: string, cutoff: Date, batchSize: number): Promise<number> {
  if (!isGenericSweepTable(table)) throw new Error(`generic sweep not allowed for table ${table}`);
  const t = sql.raw(`"${table}"`);
  const col = sql.raw(`"${GENERIC_SWEEP_TABLES[table]!.dateColumn}"`);
  const limit = Math.max(1, Math.floor(batchSize));
  const rows = rowsOf<{ n: number }>(
    await tx.execute(sql`with gone as (
        delete from ${t} where ctid in (select ctid from ${t} where ${col} < ${cutoff.toISOString()}::timestamptz limit ${limit}) returning 1
      ) select count(*)::int as n from gone`),
  );
  return Number(rows[0]?.n ?? 0);
}
