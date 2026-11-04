/**
 * Forms health for ops' daily digest and alerts (forms spec section 6 "Monitoring"):
 * completions and starts of one Brussels day, import failures and skips received that day,
 * dead `forms.*` jobs that died that day, and published forms whose CTA targets broke.
 */
import type { DbOrTx } from "@beam/db";
import { sql } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";

export type FormsHealth = { completions: number; started: number; importFailed: number; importSkipped: number; deadJobs: number; formsWithBrokenCtas: number };

/** `day` is `YYYY-MM-DD` in Europe/Brussels. */
export async function getFormsHealth(db: DbOrTx, input: { day: string }): Promise<FormsHealth> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.day)) throw new RangeError(`not an ISO date: ${input.day}`);
  const onDay = (col: string) => sql.raw(`(${col} at time zone 'Europe/Brussels')::date`);
  const [row] = rowsOf<Record<keyof FormsHealth, number>>(
    await db.execute(sql`
      select
        (select count(*)::int from form_submissions where status = 'completed' and ${onDay("completed_at")} = ${input.day}::date) as completions,
        (select count(*)::int from form_submissions where ${onDay("started_at")} = ${input.day}::date) as started,
        (select count(*)::int from form_import_events where status = 'failed' and ${onDay("received_at")} = ${input.day}::date) as "importFailed",
        (select count(*)::int from form_import_events where status = 'skipped' and ${onDay("received_at")} = ${input.day}::date) as "importSkipped",
        (select count(*)::int from jobs where status = 'dead' and kind like 'forms.%' and ${onDay("updated_at")} = ${input.day}::date) as "deadJobs",
        (select count(*)::int from forms where status = 'published' and jsonb_array_length(cta_warnings) > 0) as "formsWithBrokenCtas"`),
  );
  return {
    completions: Number(row?.completions ?? 0),
    started: Number(row?.started ?? 0),
    importFailed: Number(row?.importFailed ?? 0),
    importSkipped: Number(row?.importSkipped ?? 0),
    deadJobs: Number(row?.deadJobs ?? 0),
    formsWithBrokenCtas: Number(row?.formsWithBrokenCtas ?? 0),
  };
}
