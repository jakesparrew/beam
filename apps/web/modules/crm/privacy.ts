/**
 * crm's GDPR registration (crm spec section 9, cross-module D69). Facade read by
 * `pnpm gen:indexes`. crm-P1 registers every V1 crm table that references a person, the tables
 * without person data, the retention policies and their sweeps. crm-P7 implements `export` and
 * `erase` (they run last in the erase order, over `resolvePersonIds`).
 */
import type { Tx } from "@beam/db";
import { SENSITIVE_FIELD_KEYS, type EraseReportRow, type PrivacyExport, type PrivacyRegistration, type RetentionPolicySeed } from "@beam/core/privacy";
import { createCtx, sql, type Actor, type DbOrTx, type SQL } from "@/lib/ctx";
import { readSensitive, rowsOf } from "@/lib/sensitive";
import { addSuppression } from "./consent/api";
import { resolvePersonIds } from "./persons/api";

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

// ---------------------------------------------------------------------------
// export and erase (crm spec 9), crm-P7
// ---------------------------------------------------------------------------

const SYSTEM: Actor = { kind: "system", jobId: "" };
const idList = (ids: readonly string[]) => sql`(${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})`;
const rows = async <T = Record<string, unknown>>(tx: DbOrTx, q: SQL) => rowsOf<T>(await tx.execute(q));

async function tableExists(tx: DbOrTx, table: string): Promise<boolean> {
  const [r] = await rows<{ ok: boolean }>(tx, sql`select to_regclass(${`public.${table}`}) is not null as ok`);
  return !!r?.ok;
}

const csvCell = (v: unknown): string => {
  const s = v === null || v === undefined ? "" : typeof v === "string" ? v : v instanceof Date ? v.toISOString() : JSON.stringify(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * The subject's crm data for ops' privacy export (GDPR articles 15 and 20), over every id of
 * `resolvePersonIds`: one entry per table of section 9 (keyed by table name) plus
 * `timeline_csv` for `crm-timeline.csv`. Sensitive fields and sensitive notes are decrypted
 * through `readSensitive(ctx, id, 'privacy_export')` with the system actor (one `sensitive.read`
 * audit row per person id); everything else is read as stored. Duplicate candidates are internal
 * working data and are not exported.
 */
export async function exportPerson(tx: Tx, personId: string): Promise<PrivacyExport> {
  const ids = await resolvePersonIds(tx, personId);
  const inIds = idList(ids);
  const ctx = createCtx({ tx, actor: SYSTEM, requestId: `privacy_export:crm:${ids[0]}` });

  const personsRows = await rows(
    tx,
    sql`select id, customer_number, email, phone, phone_e164, first_name, last_name, locale, address, birth_on, preferred_channel, linkedin_url,
          emergency_contact, status_override, status_override_reason, status_override_at, acquisition, partner_company_id, external_ids,
          is_tester, processing_restricted_at, merged_into_person_id, erased_at, created_at, updated_at
        from persons where id in ${inIds} order by created_at, id`,
  );

  const sensitiveFields: Array<{ person_id: string; key: string; value: string }> = [];
  const notes = new Map<string, string>();
  for (const id of ids) {
    const eventIds = (await rows<{ id: string }>(tx, sql`select id::text as id from activity_events where person_id = ${id}::uuid and is_sensitive order by activity_events.id`)).map((r) => r.id);
    const bundle = await readSensitive(ctx, id, "privacy_export", { keys: [...SENSITIVE_FIELD_KEYS], ...(eventIds.length ? { eventIds } : {}) });
    for (const [key, value] of Object.entries(bundle.fields)) if (value !== undefined) sensitiveFields.push({ person_id: id, key, value });
    for (const n of bundle.notes) notes.set(n.eventId, n.body);
  }

  const events = await rows<{ id: string; person_id: string | null; company_id: string | null; kind: string; occurred_at: Date | string; mode: string | null; is_sensitive: boolean; data: unknown; ref_type: string | null; ref_id: string | null }>(
    tx,
    sql`select id::text as id, person_id, company_id, kind, occurred_at, mode::text as mode, is_sensitive, data, ref_type, ref_id
        from activity_events where person_id in ${inIds} order by occurred_at, activity_events.id`,
  );
  const activity = events.map((e) => ({ ...e, data: e.is_sensitive ? { body: notes.get(e.id) ?? null } : e.data }));

  const out: PrivacyExport = {
    persons: personsRows,
    person_sensitive_fields: sensitiveFields,
    person_merges: await rows(tx, sql`select id, winner_person_id, loser_person_id, loser_snapshot, field_choices, created_at from person_merges where winner_person_id in ${inIds} or loser_person_id in ${inIds} order by created_at, id`),
    person_declarations: await rows(tx, sql`select kind, document_version, status, method, accepted_at, expires_at from person_declarations where person_id in ${inIds} order by accepted_at, id`),
    consent_records: await rows(
      tx,
      sql`select purpose, status, lawful_basis, source, method, wording_version, ip::text as ip, user_agent, recorded_at from consent_records where person_id in ${inIds} order by recorded_at, created_at, id`,
    ),
    suppressions: await rows(
      tx,
      sql`select scope, reason, source, email, created_at from suppressions
          where person_id in ${inIds} or email_hash in (select email_hash from persons where id in ${inIds} and email_hash is not null) order by created_at, id`,
    ),
    activity_events: activity,
    person_tags: await rows(tx, sql`select t.key as tag_key, pt.source, pt.created_at from person_tags pt join tags t on t.id = pt.tag_id where pt.person_id in ${inIds} order by t.key`),
    segment_members: await rows(tx, sql`select s.name as segment_name, sm.source, sm.computed_at from segment_members sm join segments s on s.id = sm.segment_id where sm.person_id in ${inIds} order by s.name`),
    tasks: await rows(tx, sql`select title, kind, due_at, status, notes, created_at from tasks where person_id in ${inIds} order by created_at, id`),
    company_contacts: await rows(
      tx,
      sql`select c.name as company_name, cc.position, cc.decision_role, cc.relationship, cc.is_primary, cc.ended_on from company_contacts cc join companies c on c.id = cc.company_id where cc.person_id in ${inIds} order by c.name`,
    ),
  };
  if (await tableExists(tx, "opportunities")) out.opportunities = await rows(tx, sql`select * from opportunities where primary_contact_person_id in ${inIds}`);
  if (await tableExists(tx, "inbox_threads")) {
    out.inbox_threads = await rows(tx, sql`select * from inbox_threads where person_id in ${inIds}`);
    out.inbox_messages = await rows(tx, sql`select m.* from inbox_messages m join inbox_threads t on t.id = m.thread_id where t.person_id in ${inIds}`);
  }
  const header = ["occurred_at", "kind", "mode", "data"];
  out.timeline_csv = [header.join(","), ...activity.map((e) => [e.occurred_at, e.kind, e.mode, e.data].map(csvCell).join(","))].join("\n");
  return out;
}

/**
 * crm's erase step (crm spec 9), last in the erase order, for every id of `resolvePersonIds`
 * (erasing a merged winner erases its losers too), under `SET LOCAL beam.allow_rewrite = 'on'`.
 * Each address first gets a hash-only `all`/`erased` suppression through `addSuppression`; then
 * every crm row referencing the person is deleted, except `persons` (anonymised), `suppressions`
 * (email and person id nulled) and R3 `opportunities` (contact nulled). A guardian-consent row
 * the person signed for a minor is deleted (its guardian column cannot be null), so the minor's
 * guardian consent shows as missing. The report has counts and actions only.
 */
export async function erasePerson(tx: Tx, personId: string): Promise<EraseReportRow[]> {
  const ids = await resolvePersonIds(tx, personId);
  const inIds = idList(ids);
  await tx.execute(sql`set local beam.allow_rewrite = 'on'`);
  const ctx = createCtx({ tx, actor: SYSTEM, requestId: `privacy_erase:crm:${ids[0]}` });
  const report: EraseReportRow[] = [];
  const run = async (table: string, action: EraseReportRow["action"], q: SQL) => {
    report.push({ table, rows: await affected(tx, q), action });
  };

  const emails = await rows<{ id: string; email: string }>(tx, sql`select id, email from persons where id in ${inIds} and email is not null`);
  let suppressed = 0;
  for (const p of emails) {
    const { created } = await addSuppression(tx, ctx, { email: p.email, scope: "all", reason: "erased", source: "privacy_erasure", personId: p.id });
    if (created) suppressed++;
  }

  await run("person_sensitive_fields", "deleted", sql`delete from person_sensitive_fields where person_id in ${inIds} returning id`);
  await run("person_merges", "deleted", sql`delete from person_merges where winner_person_id in ${inIds} or loser_person_id in ${inIds} returning id`);
  await run("person_duplicate_candidates", "deleted", sql`delete from person_duplicate_candidates where person_a_id in ${inIds} or person_b_id in ${inIds} returning id`);
  await run("person_declarations", "deleted", sql`delete from person_declarations where person_id in ${inIds} or guardian_person_id in ${inIds} returning id`);
  await run("consent_records", "deleted", sql`delete from consent_records where person_id in ${inIds} returning id`);
  await run(
    "suppressions",
    "anonymised",
    sql`update suppressions set email = null, person_id = null
        where person_id in ${inIds} or email_hash in (select email_hash from persons where id in ${inIds} and email_hash is not null) returning id`,
  );
  report.push({ table: "suppressions", rows: suppressed, action: "inserted_erased" });
  await run("person_tags", "deleted", sql`delete from person_tags where person_id in ${inIds} returning id`);
  await run("segment_members", "deleted", sql`delete from segment_members where person_id in ${inIds} returning person_id`);
  await run("tasks", "deleted", sql`delete from tasks where person_id in ${inIds} returning id`);
  await run("company_contacts", "deleted", sql`delete from company_contacts where person_id in ${inIds} returning id`);
  if (await tableExists(tx, "opportunities")) {
    await run("opportunities", "anonymised", sql`update opportunities set primary_contact_person_id = null where primary_contact_person_id in ${inIds} returning id`);
  }
  if (await tableExists(tx, "inbox_threads")) {
    await run("inbox_threads", "deleted", sql`delete from inbox_threads where person_id in ${inIds} returning id`);
  }
  // Last: addSuppression above may have recorded `suppression.added` on the person.
  await run("activity_events", "deleted", sql`delete from activity_events where person_id in ${inIds} returning id`);
  await run(
    "persons",
    "anonymised",
    sql`update persons set first_name = 'Deleted', last_name = 'person', email = null, email_hash = null, phone = null, phone_e164 = null,
          address = null, birth_on = null, linkedin_url = null, emergency_contact = null,
          status_override = null, status_override_reason = null, status_override_by_user_id = null, status_override_at = null,
          external_ids = '{}'::jsonb,
          acquisition = jsonb_strip_nulls(jsonb_build_object('source', acquisition->'source', 'campaign', acquisition->'campaign', 'medium', acquisition->'medium')),
          erased_at = coalesce(erased_at, now()), updated_at = now(), version = version + 1
        where id in ${inIds} returning id`,
  );
  return report;
}

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
    "opportunities",
  ],
  export: exportPerson,
  erase: erasePerson,
  sweep,
  retention,
};

/** crm tables that hold no person data (crm spec 9). */
export const noPiiTables = ["consent_wordings", "tags", "segments", "playbook_stages"] as const;
