/**
 * ops' own retention handlers (ops spec 9, rules 68-69a, ops-P6): one function per `ops.*`
 * policy key, each `(tx, cutoff) => rows`, wired into ops' `privacy.ts` `sweep` map by ops-P5
 * (request ops-P1 -> ops-P5). Until then the sweep runner (`jobs.ts`) falls back to `OPS_SWEEP`
 * for `ops.*` keys, and a key registered in `privacy.ts` always wins.
 *
 * Every delete handler removes at most `OPS_SWEEP_BATCH` rows per call; the runner calls it again
 * while it returns a full batch. `ops.marketing_contact` and `ops.marketing_profile` erase whole
 * profiles through the privacy pipeline (`createPrivacyRequest`, kind `erase`, requested by
 * `system`, verified and scheduled at once) and share a cap of 200 requests per Brussels night,
 * contacts first (their policy runs first, run_order 10 before 11).
 */
import type { Tx } from "@beam/db";
import { createCtx, sql } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { listInactiveProfiles } from "@/modules/crm/api";
import { createPrivacyRequest } from "../privacy/api";

export const OPS_SWEEP_BATCH = 5000;
/** Rules 69 and 69a: system erase requests per night, both policies together. */
export const MARKETING_NIGHTLY_CAP = 200;

type Handler = (tx: Tx, cutoff: Date) => Promise<number>;

const iso = (d: Date) => d.toISOString();
const count = async (tx: Tx, query: ReturnType<typeof sql>): Promise<number> => Number(rowsOf<{ n: number }>(await tx.execute(query))[0]?.n ?? 0);

/** `delete ... where ctid in (select ctid ... limit batch)`, returning the count. */
function batchedDelete(table: string, where: (cutoff: Date) => ReturnType<typeof sql>): Handler {
  const t = sql.raw(`"${table}"`);
  return (tx, cutoff) =>
    count(tx, sql`with gone as (delete from ${t} where ctid in (select ctid from ${t} where ${where(cutoff)} limit ${OPS_SWEEP_BATCH}) returning 1) select count(*)::int as n from gone`);
}

/** `ops.import_rows` (30 days). */
export const sweepImportRows: Handler = batchedDelete("import_rows", (c) => sql`created_at < ${iso(c)}::timestamptz`);

/** `ops.nl_questions` (30 days, R4 table; empty until then). */
export const sweepNlQuestions: Handler = batchedDelete("nl_questions", (c) => sql`created_at < ${iso(c)}::timestamptz`);

/** `ops.privacy_requests` (5 years): finished requests only; a restriction keeps its row and loses the link. */
export const sweepPrivacyRequests: Handler = async (tx, cutoff) => {
  const old = sql`select id from privacy_requests where status in ('done', 'failed', 'cancelled') and created_at < ${iso(cutoff)}::timestamptz order by created_at limit ${OPS_SWEEP_BATCH}`;
  await tx.execute(sql`update processing_restrictions set privacy_request_id = null where privacy_request_id in (${old})`);
  return count(tx, sql`with gone as (delete from privacy_requests where id in (${old}) returning 1) select count(*)::int as n from gone`);
};

/**
 * `ops.data_exports` (30 days): first marks `done` exports past `expires_at` as `expired`
 * (state machine of `data_exports`), then deletes records older than the cutoff.
 */
export const sweepDataExports: Handler = async (tx, cutoff) => {
  const expired = await count(
    tx,
    sql`with moved as (update data_exports set status = 'expired', updated_at = now() where status = 'done' and expires_at is not null and expires_at <= now() returning 1) select count(*)::int as n from moved`,
  );
  const deleted = await batchedDelete("data_exports", (c) => sql`created_at < ${iso(c)}::timestamptz and status in ('expired', 'failed')`)(tx, cutoff);
  return expired + deleted;
};

/** `ops.retention_lists` (R2, 2 years): lists of weeks before the cutoff; items cascade. */
export const sweepRetentionLists: Handler = batchedDelete("retention_lists", (c) => sql`week_start_on < (${iso(c)}::timestamptz at time zone 'Europe/Brussels')::date`);

/** System erase requests created since the start of the Brussels day (the shared nightly cap). */
async function erasedTonight(tx: Tx): Promise<number> {
  return count(
    tx,
    sql`select count(*)::int as n from privacy_requests where requested_by = 'system' and kind = 'erase'
      and created_at >= (date_trunc('day', now() at time zone 'Europe/Brussels') at time zone 'Europe/Brussels')`,
  );
}

/**
 * Candidates of rules 69 and 69a: crm's inactive profiles (leads only for contacts), without a
 * future booking or an open privacy request; profiles also without an order, booking or login
 * since the cutoff, an active grant or membership, or an open invoice.
 */
async function marketingCandidates(tx: Tx, cutoff: Date, limit: number, leadsOnly: boolean): Promise<string[]> {
  if (limit <= 0) return [];
  const ids = await listInactiveProfiles(tx, cutoff, limit * 5 + 100, { leadsOnly });
  if (!ids.length) return [];
  const c = iso(cutoff);
  const profileOnly = leadsOnly
    ? sql``
    : sql` and not exists (select 1 from orders o where o.person_id = p.id and o.created_at >= ${c}::timestamptz)
        and not exists (select 1 from bookings b where b.person_id = p.id and b.created_at >= ${c}::timestamptz)
        and not exists (select 1 from users u where u.person_id = p.id and u.last_login_at >= ${c}::timestamptz)
        and not exists (select 1 from credit_grants g where g.person_id = p.id and g.status = 'active')
        and not exists (select 1 from memberships m where m.person_id = p.id and m.status in ('pending', 'active', 'past_due'))
        and not exists (select 1 from invoices i where i.person_id = p.id and i.status in ('issued', 'open'))`;
  const idArray = sql`${`{${ids.join(",")}}`}::uuid[]`;
  const rows = rowsOf<{ id: string }>(
    await tx.execute(sql`select p.id::text as id from persons p
      where p.id = any(${idArray}) and p.erased_at is null
        and not exists (select 1 from bookings b join sessions s on s.id = b.session_id
                        where b.person_id = p.id and b.status in ('reserved', 'confirmed') and s.starts_at > now())
        and not exists (select 1 from privacy_requests r where r.person_id = p.id and r.status in ('received', 'verified', 'running'))${profileOnly}
      order by array_position(${idArray}, p.id) limit ${limit}`),
  );
  return rows.map((r) => r.id);
}

function marketingHandler(key: "ops.marketing_contact" | "ops.marketing_profile", leadsOnly: boolean): Handler {
  return async (tx, cutoff) => {
    const remaining = MARKETING_NIGHTLY_CAP - (await erasedTonight(tx));
    const people = await marketingCandidates(tx, cutoff, remaining, leadsOnly);
    if (!people.length) return 0;
    const ctx = createCtx({ tx, actor: { kind: "system", jobId: "privacy.retention_sweep" }, requestId: `retention:${key}` });
    for (const personId of people) {
      await createPrivacyRequest(ctx, { personId, kind: "erase", requestedBy: "system", verificationNote: `retention policy ${key}` });
    }
    return people.length;
  };
}

/** Rule 69a: leads who never bought, booked, were invoiced or held a grant (730 days). */
export const sweepMarketingContact: Handler = marketingHandler("ops.marketing_contact", true);
/** Rule 69: customer profiles without activity (1095 days). */
export const sweepMarketingProfile: Handler = marketingHandler("ops.marketing_profile", false);

/** ops' handlers by policy key (spec section 9). */
export const OPS_SWEEP: Readonly<Record<string, Handler>> = {
  "ops.import_rows": sweepImportRows,
  "ops.nl_questions": sweepNlQuestions,
  "ops.privacy_requests": sweepPrivacyRequests,
  "ops.data_exports": sweepDataExports,
  "ops.retention_lists": sweepRetentionLists,
  "ops.marketing_profile": sweepMarketingProfile,
  "ops.marketing_contact": sweepMarketingContact,
};
