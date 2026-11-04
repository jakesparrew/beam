/**
 * Retention sweep handlers (forms spec section 9, SE5, cross-module D37). ops'
 * `privacy.retention_sweep` calls `sweep[key](tx, cutoff)` for each `retention_policies` row by
 * `run_order`; each handler touches at most `SWEEP_BATCH` rows under
 * `SET LOCAL beam.allow_rewrite = 'on'` and returns the count (ops continues while it equals the
 * batch size). Keys are `forms.<table>[_<qualifier>]`.
 */
import type { Tx } from "@beam/db";
import { sql, type DbOrTx } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";

export const SWEEP_BATCH = 5000;

const allowRewrite = (tx: DbOrTx) => tx.execute(sql`set local beam.allow_rewrite = 'on'`);
const count = async (tx: DbOrTx, q: ReturnType<typeof sql>): Promise<number> => rowsOf(await tx.execute(q)).length;
const at = (d: Date): string => d.toISOString();

/** Sensitive answers of submissions older than the cutoff (answers go first, blueprint 63). */
async function sweepSensitiveAnswers(tx: Tx, cutoff: Date): Promise<number> {
  await allowRewrite(tx);
  return count(
    tx,
    sql`delete from form_sensitive_answers where id in (
      select a.id from form_sensitive_answers a join form_submissions s on s.id = a.submission_id
      where coalesce(s.completed_at, s.abandoned_at, s.started_at) < ${at(cutoff)}::timestamptz limit ${SWEEP_BATCH}) returning id`,
  );
}

/** Submissions older than the cutoff (sensitive rows cascade; import events are unlinked by their FK). */
async function sweepSubmissions(tx: Tx, cutoff: Date): Promise<number> {
  await allowRewrite(tx);
  return count(
    tx,
    sql`delete from form_submissions where id in (
      select id from form_submissions where coalesce(completed_at, abandoned_at, started_at) < ${at(cutoff)}::timestamptz limit ${SWEEP_BATCH}) returning id`,
  );
}

/** SE5: anonymous abandoned submissions after 30 days. */
async function sweepAnonymousAbandoned(tx: Tx, cutoff: Date): Promise<number> {
  await allowRewrite(tx);
  return count(
    tx,
    sql`delete from form_submissions where id in (
      select id from form_submissions where status = 'abandoned' and person_id is null and abandoned_at < ${at(cutoff)}::timestamptz limit ${SWEEP_BATCH}) returning id`,
  );
}

/** Unlinked sensitive answers of submissions that never completed. */
async function sweepSensitiveUnlinked(tx: Tx, cutoff: Date): Promise<number> {
  await allowRewrite(tx);
  return count(
    tx,
    sql`delete from form_sensitive_answers where id in (
      select a.id from form_sensitive_answers a join form_submissions s on s.id = a.submission_id
      where a.person_id is null and s.status <> 'completed' and a.created_at < ${at(cutoff)}::timestamptz limit ${SWEEP_BATCH}) returning id`,
  );
}

/** Decision 29: the IP hash is cleared after 30 days. */
async function sweepIpHash(tx: Tx, cutoff: Date): Promise<number> {
  await allowRewrite(tx);
  return count(
    tx,
    sql`update form_submissions set ip_hash = null, updated_at = now() where id in (
      select id from form_submissions where ip_hash is not null and started_at < ${at(cutoff)}::timestamptz limit ${SWEEP_BATCH}) returning id`,
  );
}

/** Raw import payloads after 90 days. */
async function sweepImportEvents(tx: Tx, cutoff: Date): Promise<number> {
  await allowRewrite(tx);
  await tx.execute(sql`update form_submissions set import_event_id = null where import_event_id in (
    select id from form_import_events where received_at < ${at(cutoff)}::timestamptz limit ${SWEEP_BATCH})`);
  return count(
    tx,
    sql`delete from form_import_events where id in (
      select id from form_import_events where received_at < ${at(cutoff)}::timestamptz limit ${SWEEP_BATCH}) returning id`,
  );
}

/** Funnel aggregates after 3 years (no personal data). */
async function sweepViewsDaily(tx: Tx, cutoff: Date): Promise<number> {
  return count(
    tx,
    sql`delete from form_views_daily where id in (
      select id from form_views_daily where day_on < (${at(cutoff)}::timestamptz at time zone 'Europe/Brussels')::date limit ${SWEEP_BATCH}) returning id`,
  );
}

/** The `sweep` map of `formsPrivacy`, keyed by retention policy key. */
export const sweep = {
  "forms.form_submissions": sweepSubmissions,
  "forms.form_sensitive_answers": sweepSensitiveAnswers,
  "forms.form_submissions_anonymous_abandoned": sweepAnonymousAbandoned,
  "forms.form_sensitive_answers_unlinked": sweepSensitiveUnlinked,
  "forms.form_submissions_ip_hash": sweepIpHash,
  "forms.form_import_events": sweepImportEvents,
  "forms.form_views_daily": sweepViewsDaily,
} satisfies Record<string, (tx: Tx, cutoff: Date) => Promise<number>>;
