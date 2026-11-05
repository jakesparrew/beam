/**
 * credits' GDPR registration (credits spec section 9, architecture section 11, ops rule 62;
 * credits-P5). Facade read by `pnpm gen:indexes`.
 *
 * - `export`: owned grants (all statuses) with their ledger entries (session title, guest as first
 *   name and initial, the reason texts), the person's uses on other owners' grants (owner as first
 *   name and initial), shares given and received, memberships with their periods. Staff notes are
 *   included (Art. 15); staff actors appear as "BEAM staff".
 * - `erase` (after commerce, before crm anonymises `persons`; runs under `beam.allow_rewrite`):
 *   prepaid grants (`purchase`, `voucher`, `import`, `membership`, `transfer`, and `manual` euro
 *   refund restores with `data.refund_id`) keep their rows for the accounting horizon: remaining
 *   units revoked (`revoke:erase:<grant_id>`, reason `erased`), status `revoked`, `note` and
 *   `label` nulled, entry reasons `redacted` and entry data stripped to the extension dates.
 *   Goodwill grants (`bonus`, other `manual`, `referral`) are deleted with their entries. Shares
 *   given or received are deleted and the sharing caches that named the person are rebuilt.
 *   Memberships are retained (`expired`, `end_reason = erased` when still live; `notes` nulled);
 *   their periods are retained. The person's uses on other owners' grants stay, pointing at the
 *   anonymised person, so the owner's history stays correct (edge case 26). R2 sharing reviews
 *   (credits-P8): the person is removed from every reviewed person set and the notes are nulled;
 *   a review about the person as guest, on a deleted grant, or left with an empty set is deleted.
 *   R3 (credits-P9): the person's referral codes and every attribution where they are the
 *   referred person or the referrer are deleted; partner commissions stay (`retained_legal`, no
 *   person column) with `attribution_id` nulled by the FK. The export lists the codes, the
 *   attribution as referred person and, as referrer, only counts.
 * - `sweep`: one handler per seeded retention key (cross-module D37), at most 5,000 rows per call;
 *   the two accounting-linked keys never touch a record younger than 3653 days (D34).
 */
import type { Tx } from "@beam/db";
import type { EraseReportRow, PrivacyExport, PrivacyRegistration, RetentionPolicySeed } from "@beam/core/privacy";
import { assertMembershipTransition, type MembershipStatus } from "@beam/core/credits";
import { CREDITS_RETENTION_POLICIES } from "@beam/db/seed/credits";
import { createCtx, sql, type Ctx, type DbOrTx } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { balanceOf, lockGrants, setGrantStatus, writeEntry } from "./server/ledger";

const BATCH = 5000;
const DAY = 86_400_000;
/** Belgian accounting horizon (cross-module D34): the floor of the two accounting-linked sweeps. */
export const ACCOUNTING_DAYS = 3653;

/** Grant sources whose rows are kept on erasure (prepaid value backs invoices), besides refund restores. */
export const RETAINED_SOURCES = ["purchase", "voucher", "import", "membership", "transfer"] as const;

const query = async <T>(tx: DbOrTx, q: ReturnType<typeof sql>): Promise<T[]> => rowsOf<T>(await tx.execute(q));
const affected = async (tx: DbOrTx, q: ReturnType<typeof sql>) => rowsOf(await tx.execute(q)).length;
const allowRewrite = (tx: DbOrTx) => tx.execute(sql`set local beam.allow_rewrite = 'on'`);
const uuidArray = (ids: readonly string[]) => sql`${`{${ids.join(",")}}`}::uuid[]`;
const isRetained = sql.raw(`(g.source in (${RETAINED_SOURCES.map((s) => `'${s}'`).join(", ")}) or (g.source = 'manual' and g.data ? 'refund_id'))`);
/** First name and last initial of `alias` (persons), as the owner sees a guest (rule 38). */
const shortName = (alias: string) =>
  sql.raw(`nullif(trim(coalesce(${alias}.first_name, '') || ' ' || coalesce(left(${alias}.last_name, 1) || '.', '')), '')`);
const actorLabel = sql.raw(
  `case e.actor->>'kind' when 'staff' then 'BEAM staff' when 'customer' then 'customer' else 'BEAM' end`,
);

/** The module's retention rows (the same list the credits defaults seed inserts); ops seeds them from `GDPR_REGISTRY`. */
export const retention: readonly RetentionPolicySeed[] = CREDITS_RETENTION_POLICIES.map((p) => ({ ...p }));

/** The older of `cutoff` and the accounting floor (now - 3653 days). */
const accountingCutoff = (cutoff: Date) => new Date(Math.min(cutoff.getTime(), Date.now() - ACCOUNTING_DAYS * DAY));

export const sweep: Record<string, (tx: Tx, cutoff: Date) => Promise<number>> = {
  /** Closed grants (not `active`) whose last status change is older than the cutoff, with their entries and shares. */
  "credits.ledger": async (tx, cutoff) => {
    await allowRewrite(tx);
    const due = (
      await query<{ id: string }>(
        tx,
        sql`select g.id from credit_grants g
            where g.status <> 'active' and g.status_changed_at < ${accountingCutoff(cutoff).toISOString()}::timestamptz
              and not exists (select 1 from vouchers v where v.credit_grant_id = g.id)
            order by g.id limit ${BATCH}`,
      )
    ).map((r) => r.id);
    if (!due.length) return 0;
    await tx.execute(sql`delete from package_shares where grant_id = any(${uuidArray(due)})`);
    await tx.execute(sql`delete from credit_entries where grant_id = any(${uuidArray(due)})`);
    return affected(tx, sql`delete from credit_grants where id = any(${uuidArray(due)}) returning id`);
  },
  /**
   * Ended memberships (`cancelled`, `expired`) older than the cutoff whose grants are already gone,
   * with their periods. A renewal order that links to one keeps its row: commerce's relaxed
   * `orders_renewal_chk` (`renewal_membership_id is null or renewal_period_end_on is not null`)
   * lets the FK's `ON DELETE SET NULL` clear the link and keep `renewal_period_end_on`.
   */
  "credits.memberships": async (tx, cutoff) => {
    await allowRewrite(tx);
    const due = (
      await query<{ id: string }>(
        tx,
        sql`select m.id from memberships m
            where m.status in ('cancelled', 'expired') and m.ended_at < ${accountingCutoff(cutoff).toISOString()}::timestamptz
              and not exists (select 1 from credit_grants g where g.membership_id = m.id)
            order by m.id limit ${BATCH}`,
      )
    ).map((r) => r.id);
    if (!due.length) return 0;
    await tx.execute(sql`delete from membership_periods where membership_id = any(${uuidArray(due)})`);
    return affected(tx, sql`delete from memberships where id = any(${uuidArray(due)}) returning id`);
  },
  /** R2 (credits-P8): review decisions older than the cutoff (2 years by default). */
  "credits.sharing_reviews": async (tx, cutoff) => {
    return affected(
      tx,
      sql`delete from credit_sharing_reviews where id in (
            select id from credit_sharing_reviews where created_at < ${cutoff.toISOString()}::timestamptz limit ${BATCH}) returning id`,
    );
  },
  "credits.reconciliation_runs": (tx, cutoff) =>
    affected(
      tx,
      sql`delete from credit_reconciliation_runs where id in (
            select id from credit_reconciliation_runs where started_at < ${cutoff.toISOString()}::timestamptz limit ${BATCH}) returning id`,
    ),
  /** R3 (credits-P9): attributions older than the cutoff (3 years) that no partner commission links to. */
  "credits.referral_attributions": (tx, cutoff) =>
    affected(
      tx,
      sql`delete from referral_attributions where id in (
            select a.id from referral_attributions a
            where a.attributed_at < ${cutoff.toISOString()}::timestamptz
              and not exists (select 1 from partner_commissions c where c.attribution_id = a.id)
            order by a.id limit ${BATCH}) returning id`,
    ),
};

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

async function exportPerson(tx: Tx, personId: string): Promise<PrivacyExport> {
  const pid = sql`${personId}::uuid`;
  const grants = await query<Record<string, unknown>>(
    tx,
    sql`select g.id, g.source, g.credit_kind, g.units_granted, coalesce(b.remaining_units, 0) as remaining_units,
               coalesce(b.used_units, 0) as used_units, g.status, g.starts_at, g.expires_at, g.label, p.name as product_name, g.note
        from credit_grants g
        left join products p on p.id = g.product_id
        left join v_credit_grant_balances b on b.grant_id = g.id
        where g.person_id = ${pid} order by g.starts_at, g.id`,
  );
  const entries = await query<Record<string, unknown>>(
    tx,
    sql`select e.grant_id, e.kind, e.quantity, e.created_at, s.title as session_title,
               case when e.beneficiary_person_id is not null and e.beneficiary_person_id <> ${pid} then ${shortName("bp")} end as guest,
               e.reason, ${actorLabel} as by
        from credit_entries e
        join credit_grants g on g.id = e.grant_id
        left join bookings bk on e.ref_type = 'booking' and bk.id = e.ref_id
        left join sessions s on s.id = bk.session_id
        left join persons bp on bp.id = e.beneficiary_person_id
        where g.person_id = ${pid} order by e.created_at, e.id`,
  );
  const usesOnOtherGrants = await query<Record<string, unknown>>(
    tx,
    sql`select e.kind, e.quantity, e.created_at, g.credit_kind, s.title as session_title, ${shortName("op")} as owner
        from credit_entries e
        join credit_grants g on g.id = e.grant_id
        left join persons op on op.id = g.person_id
        left join bookings bk on e.ref_type = 'booking' and bk.id = e.ref_id
        left join sessions s on s.id = bk.session_id
        where e.beneficiary_person_id = ${pid} and g.person_id <> ${pid} order by e.created_at, e.id`,
  );
  const sharesGiven = await query<Record<string, unknown>>(
    tx,
    sql`select s.grant_id, ${shortName("sp")} as shared_with, s.max_units, s.status, s.created_at, s.revoked_at
        from package_shares s join credit_grants g on g.id = s.grant_id left join persons sp on sp.id = s.shared_with_person_id
        where g.person_id = ${pid} order by s.created_at`,
  );
  const sharesReceived = await query<Record<string, unknown>>(
    tx,
    sql`select s.grant_id, ${shortName("op")} as owner, s.max_units, s.status, s.created_at, s.revoked_at
        from package_shares s join credit_grants g on g.id = s.grant_id left join persons op on op.id = g.person_id
        where s.shared_with_person_id = ${pid} order by s.created_at`,
  );
  const memberships = await query<Record<string, unknown>>(
    tx,
    sql`select m.id, p.name as plan_name, m.status, m.interval, m.source, m.started_at, m.current_period_start_at,
               m.current_period_end_at, m.cancel_at, m.ended_at, m.end_reason, m.discount_pct, m.notes,
               coalesce((select jsonb_agg(jsonb_build_object('period_start_at', mp.period_start_at, 'period_end_at', mp.period_end_at,
                                                              'source', mp.source, 'amount_cents', mp.amount_cents) order by mp.period_start_at)
                         from membership_periods mp where mp.membership_id = m.id), '[]'::jsonb) as periods
        from memberships m left join products p on p.id = m.product_id
        where m.person_id = ${pid} order by m.started_at, m.id`,
  );
  // R3: own codes, attributions where the person was referred, and as referrer only a count.
  const referralCodes = await query<Record<string, unknown>>(
    tx,
    sql`select c.code, c.is_active, c.created_at from referral_codes c where c.person_id = ${pid} order by c.created_at`,
  );
  const referredBy = await query<Record<string, unknown>>(
    tx,
    sql`select a.source, a.status, a.attributed_at, a.first_paid_at, a.qualifies_at, a.rejected_reason,
               ${shortName("rp")} as referrer, co.name as partner
        from referral_attributions a left join persons rp on rp.id = a.referrer_person_id left join companies co on co.id = a.partner_company_id
        where a.referred_person_id = ${pid}`,
  );
  const [asReferrer] = await query<{ referred: number; rewarded: number }>(
    tx,
    sql`select count(*)::int as referred, count(*) filter (where status = 'rewarded')::int as rewarded
        from referral_attributions where referrer_person_id = ${pid}`,
  );
  const referrals = { codes: referralCodes, referredBy, asReferrer: { referredFriends: Number(asReferrer?.referred ?? 0), rewarded: Number(asReferrer?.rewarded ?? 0) } };
  return { grants, entries, usesOnOtherGrants, sharesGiven, sharesReceived, memberships, referrals };
}

// ---------------------------------------------------------------------------
// Erase
// ---------------------------------------------------------------------------

/** The system actor of the erase step (02-data-model DM-6: no third argument, no request id). */
const eraseCtx = (tx: Tx): Ctx => createCtx({ tx, actor: { kind: "system", jobId: "" } });

async function eraseMemberships(tx: Tx, ctx: Ctx, personId: string): Promise<number> {
  const rows = await query<{ id: string; status: MembershipStatus; version: number }>(
    tx,
    sql`select id, status, version from memberships where person_id = ${personId}::uuid order by id for update`,
  );
  for (const m of rows) {
    const live = m.status === "pending" || m.status === "active" || m.status === "past_due";
    if (live) assertMembershipTransition(m.status, "expired", { endReason: "erased" });
    await tx.execute(sql`
      update memberships set notes = null, version = ${Number(m.version) + 1}, updated_at = ${ctx.now.toISOString()}::timestamptz
        ${live ? sql`, status = 'expired', end_reason = 'erased', ended_at = ${ctx.now.toISOString()}::timestamptz, next_charge_at = null` : sql``}
      where id = ${m.id}::uuid`);
  }
  return rows.length;
}

async function erasePerson(tx: Tx, personId: string): Promise<EraseReportRow[]> {
  await allowRewrite(tx);
  const ctx = eraseCtx(tx);
  const pid = sql`${personId}::uuid`;
  const owned = await query<{ id: string; retained: boolean }>(
    tx,
    sql`select g.id, ${isRetained} as retained from credit_grants g where g.person_id = ${pid} order by g.id`,
  );
  const retained = owned.filter((g) => g.retained).map((g) => g.id);
  const goodwill = owned.filter((g) => !g.retained).map((g) => g.id);
  const locked = await lockGrants(tx, owned.map((g) => g.id));

  // Shares given or received, then the sharing caches that named the person or a deleted share.
  const touched = (
    await query<{ id: string }>(
      tx,
      sql`select distinct grant_id as id from package_shares
          where shared_with_person_id = ${pid} or created_by_person_id = ${pid} or grant_id = any(${uuidArray(owned.map((g) => g.id))})
          union select id from credit_grants where sharing->'allowed_person_ids' ? ${personId}`,
    )
  ).map((r) => r.id);
  const shares = await affected(
    tx,
    sql`delete from package_shares
        where shared_with_person_id = ${pid} or created_by_person_id = ${pid} or grant_id = any(${uuidArray(owned.map((g) => g.id))})
        returning id`,
  );
  if (touched.length) {
    await tx.execute(sql`
      update credit_grants g set sharing = jsonb_set(g.sharing, '{allowed_person_ids}',
          coalesce((select jsonb_agg(distinct s.shared_with_person_id) from package_shares s where s.grant_id = g.id and s.status = 'active'), '[]'::jsonb)),
        updated_at = ${ctx.now.toISOString()}::timestamptz
      where g.id = any(${uuidArray(touched)})`);
  }

  // R2 sharing reviews: the person leaves every person set; a guest_hopping review about them and
  // a review left with an empty set are deleted; the notes of the rest are nulled.
  const reviewsDeleted = await affected(
    tx,
    sql`delete from credit_sharing_reviews
        where guest_person_id = ${pid} or grant_id = any(${uuidArray(goodwill)})
           or (guest_person_ids @> array[${pid}] and cardinality(guest_person_ids) = 1)
        returning id`,
  );
  const reviewsRedacted = await affected(
    tx,
    sql`update credit_sharing_reviews set guest_person_ids = array_remove(guest_person_ids, ${pid}), note = null
        where guest_person_ids @> array[${pid}] or grant_id = any(${uuidArray(owned.map((g) => g.id))})
        returning id`,
  );

  // Goodwill grants: no legal basis to keep them.
  let goodwillEntries = 0;
  let goodwillGrants = 0;
  if (goodwill.length) {
    goodwillEntries = await affected(tx, sql`delete from credit_entries where grant_id = any(${uuidArray(goodwill)}) returning id`);
    goodwillGrants = await affected(tx, sql`delete from credit_grants where id = any(${uuidArray(goodwill)}) returning id`);
  }

  // Prepaid grants: redact the entries, revoke what is left, clear the free texts.
  let redacted = 0;
  if (retained.length) {
    redacted = await affected(
      tx,
      sql`update credit_entries set reason = case when reason is null then null else 'redacted' end,
            data = coalesce((select jsonb_object_agg(k, v) from jsonb_each(data) as x(k, v) where k in ('old_expires_at', 'new_expires_at')), '{}'::jsonb)
          where grant_id = any(${uuidArray(retained)}) returning id`,
    );
    for (const grant of locked.filter((g) => retained.includes(g.id))) {
      const balance = await balanceOf(tx, grant.id);
      if (balance > 0 && grant.status !== "revoked") {
        await writeEntry(tx, ctx, { grantId: grant.id, personId: grant.personId, kind: "revoke", quantity: -balance, reason: "erased", key: `revoke:erase:${grant.id}` });
      }
      await setGrantStatus(tx, ctx, grant, "revoked");
    }
    await tx.execute(sql`update credit_grants set note = null, label = null, updated_at = ${ctx.now.toISOString()}::timestamptz where id = any(${uuidArray(retained)})`);
  }

  const [beneficiary] = await query<{ n: number }>(
    tx,
    sql`select count(*)::int as n from credit_entries e join credit_grants g on g.id = e.grant_id
        where e.beneficiary_person_id = ${pid} and g.person_id <> ${pid}`,
  );
  const memberships = await eraseMemberships(tx, ctx, personId);
  const [periods] = await query<{ n: number }>(tx, sql`select count(*)::int as n from membership_periods where person_id = ${pid}`);

  // R3: attributions as referred or referrer and own codes are deleted; the FKs null
  // `partner_commissions.attribution_id` and `credit_grants.referral_attribution_id` (commissions are
  // the partner's financial record and stay).
  const [linked] = await query<{ n: number }>(
    tx,
    sql`select count(*)::int as n from partner_commissions c join referral_attributions a on a.id = c.attribution_id
        where a.referred_person_id = ${pid} or a.referrer_person_id = ${pid}`,
  );
  const attributions = await affected(
    tx,
    sql`delete from referral_attributions where referred_person_id = ${pid} or referrer_person_id = ${pid} returning id`,
  );
  const codes = await affected(tx, sql`delete from referral_codes where person_id = ${pid} returning id`);

  return [
    { table: "credit_grants", rows: retained.length, action: "retained_legal" },
    { table: "credit_grants", rows: goodwillGrants, action: "deleted" },
    { table: "credit_entries", rows: redacted, action: "anonymised" },
    { table: "credit_entries", rows: goodwillEntries, action: "deleted" },
    { table: "credit_entries", rows: Number(beneficiary?.n ?? 0), action: "kept" },
    { table: "package_shares", rows: shares, action: "deleted" },
    { table: "credit_sharing_reviews", rows: reviewsDeleted, action: "deleted" },
    { table: "credit_sharing_reviews", rows: reviewsRedacted, action: "anonymised" },
    { table: "memberships", rows: memberships, action: "retained_legal" },
    { table: "membership_periods", rows: Number(periods?.n ?? 0), action: "retained_legal" },
    { table: "referral_codes", rows: codes, action: "deleted" },
    { table: "referral_attributions", rows: attributions, action: "deleted" },
    { table: "partner_commissions", rows: Number(linked?.n ?? 0), action: "retained_legal" },
  ];
}

export const privacy: PrivacyRegistration<Tx> = {
  tables: [
    "credit_grants",
    "credit_entries",
    "memberships",
    "membership_periods",
    "package_shares",
    "credit_sharing_reviews",
    "referral_codes",
    "referral_attributions",
    "partner_commissions",
  ],
  export: (tx, personId) => exportPerson(tx, personId),
  erase: (tx, personId) => erasePerson(tx, personId),
  sweep,
  retention,
};

/** No column referencing `persons.id` (credits spec section 9). */
export const noPiiTables = ["membership_plan_inclusions", "membership_plan_benefits", "credit_bulk_extensions", "credit_reconciliation_runs"] as const;
