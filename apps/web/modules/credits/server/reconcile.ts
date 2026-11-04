/**
 * Nightly ledger reconciliation (credits spec section 4 "Jobs" `ledger.reconcile`, edge cases 20
 * to 22; credits-P5). One `credit_reconciliation_runs` row per run with the findings of every
 * check (ids only, never names or reasons) and the status drift it corrected. Reconcile never
 * writes a ledger entry: it reports, and staff fix with an adjustment after investigation. The
 * only corrections are derived bookkeeping: a grant status that does not follow its balance
 * (edge case 22) and the R2 `sharing.allowed_person_ids` cache (`share_cache_drift`), each under
 * the grant row lock. Bookings with `source = 'import'` are skipped by every booking check
 * (booking R65: imported credit bookings carry no consume entry). Findings raise one high Slack
 * alert per run through platform's `notifySlack` (fingerprint `ledger:<run_id>`).
 */
import type { DbOrTx } from "@beam/db";
import { creditReconciliationRuns, type ReconciliationFindingJson } from "@beam/db/schema";
import { brusselsDateKey } from "@beam/core/credits";
import { and, desc, eq, sql, type Ctx } from "@/lib/ctx";
import { notifySlack } from "@/lib/alerts";
import { rowsOf } from "@/lib/sensitive";
import { balanceOf, lockGrants, setGrantStatus } from "./ledger";

export type ReconcileFinding = ReconciliationFindingJson;

/** The checks of one run, in run order (edge case 21). */
export const RECONCILE_CHECKS = [
  "booking_without_consume",
  "orphan_consume",
  "missing_release",
  "negative_balance",
  "stale_membership_period",
  "missing_inclusion_grant",
  "expiry_overdue",
  "euro_order_mismatch",
  "status_drift",
  "share_cache_drift",
] as const;
export type ReconcileCheck = (typeof RECONCILE_CHECKS)[number];

/** Findings kept per check and run; the alert text gives the full count. */
export const FINDINGS_PER_CHECK = 500;
/** An `active` membership whose period ended longer ago than this is stale (the scan did not run). */
export const STALE_PERIOD_DAYS = 11;
/** An `active` grant that expired longer ago than this was missed by the expiry job. */
export const EXPIRY_OVERDUE_HOURS = 26;

const HOUR = 3_600_000;
const iso = (d: Date) => d.toISOString();
const ts = (d: Date) => sql`${iso(d)}::timestamptz`;
const dateOut = (v: Date | string | null) => (v instanceof Date ? v.toISOString() : v == null ? null : new Date(v).toISOString());

/** Consume entries of `refType` without their release. */
const unreleased = (refType: "booking" | "order") => sql`
  select e.id, e.grant_id, e.ref_id, (-e.quantity)::int as units
  from credit_entries e
  where e.kind = 'consume' and e.ref_type = ${refType}
    and not exists (select 1 from credit_entries r where r.reverses_entry_id = e.id and r.kind = 'release')`;

type CheckResult = { findings: ReconcileFinding[]; fixed: ReconcileFinding[] };
type CheckFn = (tx: DbOrTx, ctx: Ctx) => Promise<CheckResult>;
const found = (findings: ReconcileFinding[]): CheckResult => ({ findings, fixed: [] });

async function query<T>(tx: DbOrTx, q: ReturnType<typeof sql>): Promise<T[]> {
  return rowsOf<T>(await tx.execute(q));
}

/** A credit-paid live booking (reserved, confirmed, attended) whose session costs units but has no unreleased consume. */
const bookingWithoutConsume: CheckFn = async (tx) => {
  const rows = await query<{ booking_id: string; expected: number }>(
    tx,
    sql`
      select b.id as booking_id, s.credit_cost::int as expected
      from bookings b join sessions s on s.id = b.session_id
      where b.paid_with in ('credit', 'guest') and b.source <> 'import'
        and b.status in ('reserved', 'confirmed', 'attended')
        and s.credit_kind is not null and s.credit_cost > 0
        and not exists (select 1 from (${unreleased("booking")}) u where u.ref_id = b.id)
      order by b.id limit ${FINDINGS_PER_CHECK}`,
  );
  return found(rows.map((r) => ({ check: "booking_without_consume", booking_id: r.booking_id, expected: Number(r.expected), actual: 0 })));
};

/** An unreleased booking consume whose booking does not exist or is not paid with credit. */
const orphanConsume: CheckFn = async (tx) => {
  const rows = await query<{ grant_id: string; booking_id: string; units: number; paid_with: string | null }>(
    tx,
    sql`
      select u.grant_id, u.ref_id as booking_id, u.units, b.paid_with::text as paid_with
      from (${unreleased("booking")}) u left join bookings b on b.id = u.ref_id
      where (b.id is null or b.paid_with not in ('credit', 'guest')) and coalesce(b.source::text, '') <> 'import'
      order by u.id limit ${FINDINGS_PER_CHECK}`,
  );
  return found(
    rows.map((r) => ({ check: "orphan_consume", grant_id: r.grant_id, booking_id: r.booking_id, expected: r.paid_with ?? "booking", actual: Number(r.units) })),
  );
};

/** An unreleased consume of a `cancelled` booking. */
const missingRelease: CheckFn = async (tx) => {
  const rows = await query<{ grant_id: string; booking_id: string; units: number }>(
    tx,
    sql`
      select u.grant_id, u.ref_id as booking_id, u.units
      from (${unreleased("booking")}) u join bookings b on b.id = u.ref_id
      where b.status = 'cancelled' and b.source <> 'import'
      order by u.id limit ${FINDINGS_PER_CHECK}`,
  );
  return found(rows.map((r) => ({ check: "missing_release", grant_id: r.grant_id, booking_id: r.booking_id, expected: 0, actual: Number(r.units) })));
};

/** A grant whose ledger sums below zero (edge case 20: reported, never corrected). */
const negativeBalance: CheckFn = async (tx) => {
  const rows = await query<{ grant_id: string; balance: number }>(
    tx,
    sql`
      select e.grant_id, sum(e.quantity)::int as balance from credit_entries e
      group by e.grant_id having sum(e.quantity) < 0
      order by e.grant_id limit ${FINDINGS_PER_CHECK}`,
  );
  return found(rows.map((r) => ({ check: "negative_balance", grant_id: r.grant_id, expected: 0, actual: Number(r.balance) })));
};

/** An `active` membership whose period ended more than 11 days ago. */
const staleMembershipPeriod: CheckFn = async (tx, ctx) => {
  const rows = await query<{ membership_id: string; period_end_at: Date | string | null }>(
    tx,
    sql`
      select m.id as membership_id, m.current_period_end_at as period_end_at from memberships m
      where m.status = 'active' and m.current_period_end_at < ${ts(new Date(ctx.now.getTime() - STALE_PERIOD_DAYS * 24 * HOUR))}
      order by m.id limit ${FINDINGS_PER_CHECK}`,
  );
  return found(
    rows.map((r) => ({ check: "stale_membership_period", membership_id: r.membership_id, expected: "renewed_or_ended", actual: dateOut(r.period_end_at) })),
  );
};

/** An `active` membership in a running period without the inclusion grant of each plan inclusion (rule 46). */
const missingInclusionGrant: CheckFn = async (tx, ctx) => {
  const now = ts(ctx.now);
  const rows = await query<{ membership_id: string; credit_kind: string; units: number }>(
    tx,
    sql`
      with inc as (
        select p.id as product_id, p.included_credit_kind::text as credit_kind, p.included_credit_units::int as units
        from products p
        where p.kind = 'membership' and p.included_credit_kind is not null and p.included_credit_kind::text <> 'euro'
          and coalesce(p.included_credit_units, 0) > 0
        union
        select i.product_id, i.credit_kind::text, i.units_per_period::int from membership_plan_inclusions i
        where i.is_active and i.credit_kind::text <> 'euro')
      select m.id as membership_id, inc.credit_kind, min(inc.units)::int as units
      from memberships m join inc on inc.product_id = m.product_id
      where m.status = 'active' and m.current_period_start_at <= ${now} and m.current_period_end_at > ${now}
        and not exists (
          select 1 from credit_grants g
          where g.membership_id = m.id and g.source = 'membership' and g.credit_kind::text = inc.credit_kind
            and g.starts_at = m.current_period_start_at)
      group by m.id, inc.credit_kind
      order by m.id, inc.credit_kind limit ${FINDINGS_PER_CHECK}`,
  );
  return found(
    rows.map((r) => ({
      check: "missing_inclusion_grant",
      membership_id: r.membership_id,
      expected: { credit_kind: r.credit_kind, units: Number(r.units) },
      actual: null,
    })),
  );
};

/** An `active` grant that expired more than 26 hours ago (the expiry job did not run). */
const expiryOverdue: CheckFn = async (tx, ctx) => {
  const rows = await query<{ grant_id: string; expires_at: Date | string | null }>(
    tx,
    sql`
      select g.id as grant_id, g.expires_at from credit_grants g
      where g.status = 'active' and g.expires_at < ${ts(new Date(ctx.now.getTime() - EXPIRY_OVERDUE_HOURS * HOUR))}
      order by g.id limit ${FINDINGS_PER_CHECK}`,
  );
  return found(rows.map((r) => ({ check: "expiry_overdue", grant_id: r.grant_id, expected: "expired", actual: dateOut(r.expires_at) })));
};

/** An unreleased euro consume of an order that expired or was cancelled (rule 20: commerce releases it). */
const euroOrderMismatch: CheckFn = async (tx) => {
  const rows = await query<{ grant_id: string; order_id: string; units: number; status: string }>(
    tx,
    sql`
      select u.grant_id, u.ref_id as order_id, u.units, o.status::text as status
      from (${unreleased("order")}) u
      join credit_grants g on g.id = u.grant_id
      join orders o on o.id = u.ref_id
      where g.credit_kind = 'euro' and o.status in ('expired', 'cancelled')
      order by u.id limit ${FINDINGS_PER_CHECK}`,
  );
  return found(
    rows.map((r) => ({ check: "euro_order_mismatch", grant_id: r.grant_id, expected: { order_id: r.order_id, status: r.status, units: 0 }, actual: Number(r.units) })),
  );
};

/**
 * Status drift (edge case 22): `active` with balance 0 (not yet expired) becomes `exhausted`;
 * `exhausted` with a positive balance before its expiry becomes `active`. Re-checked under the
 * grant lock and corrected; an `exhausted` grant with units left after its expiry cannot be
 * corrected without an `expire` entry, so it is reported instead.
 */
const statusDrift: CheckFn = async (tx, ctx) => {
  const now = ts(ctx.now);
  const candidates = await query<{ grant_id: string }>(
    tx,
    sql`
      select g.id as grant_id from credit_grants g
      left join lateral (select coalesce(sum(e.quantity), 0)::int as balance from credit_entries e where e.grant_id = g.id) b on true
      where (g.status = 'active' and b.balance = 0 and (g.expires_at is null or g.expires_at > ${now}))
         or (g.status = 'exhausted' and b.balance > 0)
      order by g.id limit ${FINDINGS_PER_CHECK}`,
  );
  const findings: ReconcileFinding[] = [];
  const fixed: ReconcileFinding[] = [];
  for (const grant of await lockGrants(tx, candidates.map((c) => c.grant_id))) {
    const balance = await balanceOf(tx, grant.id);
    const expired = !!grant.expiresAt && grant.expiresAt.getTime() <= ctx.now.getTime();
    if (grant.status === "active" && balance === 0 && !expired) {
      await setGrantStatus(tx, ctx, grant, "exhausted");
      fixed.push({ check: "status_drift", grant_id: grant.id, expected: "exhausted", actual: "active" });
    } else if (grant.status === "exhausted" && balance > 0 && !expired) {
      await setGrantStatus(tx, ctx, grant, "active");
      fixed.push({ check: "status_drift", grant_id: grant.id, expected: "active", actual: "exhausted" });
    } else if (grant.status === "exhausted" && balance > 0) {
      findings.push({ check: "status_drift", grant_id: grant.id, expected: "expired", actual: "exhausted" });
    }
  }
  return { findings, fixed };
};

/** R2 cache: `sharing.allowed_person_ids` equals the active `package_shares` of the grant; corrected like status drift. */
const shareCacheDrift: CheckFn = async (tx, ctx) => {
  const rows = await query<{ grant_id: string }>(
    tx,
    sql`
      with cache as (
        select g.id, coalesce((select array_agg(distinct x order by x) from jsonb_array_elements_text(coalesce(g.sharing->'allowed_person_ids', '[]'::jsonb)) x), '{}') as ids
        from credit_grants g),
      shares as (
        select s.grant_id as id, array_agg(distinct s.shared_with_person_id::text order by s.shared_with_person_id::text) as ids
        from package_shares s where s.status = 'active' group by s.grant_id)
      select c.id as grant_id from cache c left join shares s on s.id = c.id
      where c.ids <> coalesce(s.ids, '{}')
      order by c.id limit ${FINDINGS_PER_CHECK}`,
  );
  const fixed: ReconcileFinding[] = [];
  for (const grant of await lockGrants(tx, rows.map((r) => r.grant_id))) {
    const active = await query<{ id: string }>(
      tx,
      sql`select distinct shared_with_person_id::text as id from package_shares where grant_id = ${grant.id}::uuid and status = 'active' order by 1`,
    );
    const ids = active.map((r) => r.id);
    const before = [...new Set(grant.sharing.allowed_person_ids ?? [])].sort();
    if (before.join(",") === ids.join(",")) continue;
    await tx.execute(sql`
      update credit_grants set sharing = jsonb_set(sharing, '{allowed_person_ids}', ${JSON.stringify(ids)}::jsonb), updated_at = ${ts(ctx.now)}
      where id = ${grant.id}::uuid`);
    fixed.push({ check: "share_cache_drift", grant_id: grant.id, expected: ids.length, actual: before.length });
  }
  return { findings: [], fixed };
};

const CHECKS: Record<ReconcileCheck, CheckFn> = {
  booking_without_consume: bookingWithoutConsume,
  orphan_consume: orphanConsume,
  missing_release: missingRelease,
  negative_balance: negativeBalance,
  stale_membership_period: staleMembershipPeriod,
  missing_inclusion_grant: missingInclusionGrant,
  expiry_overdue: expiryOverdue,
  euro_order_mismatch: euroOrderMismatch,
  status_drift: statusDrift,
  share_cache_drift: shareCacheDrift,
};

export type ReconcileResult = {
  runId: string;
  status: "ok" | "mismatch" | "error";
  findings: number;
  fixed: number;
  checkedGrants: number;
  checkedBookings: number;
  /** True when an earlier run already covered this job or this Brussels day; nothing was written. */
  skipped: boolean;
  alerted: boolean;
};

type RunRow = typeof creditReconciliationRuns.$inferSelect;

function resultOf(run: RunRow, skipped: boolean, alerted: boolean): ReconcileResult {
  return {
    runId: run.id,
    status: run.status ?? "error",
    findings: run.findings.length,
    fixed: run.fixed.length,
    checkedGrants: run.checkedGrants,
    checkedBookings: run.checkedBookings,
    skipped,
    alerted,
  };
}

/**
 * The earlier finished run this one repeats: the run of the same job (a retry or a double
 * delivery), or, for a scheduled run, any run that finished on the same Brussels day.
 */
async function priorRun(tx: DbOrTx, ctx: Ctx, input: { jobId: string | null; manual: boolean }): Promise<RunRow | undefined> {
  if (input.jobId) {
    const [byJob] = await tx.select().from(creditReconciliationRuns).where(eq(creditReconciliationRuns.jobId, input.jobId)).limit(1);
    if (byJob) return byJob;
  }
  if (input.manual) return undefined;
  const [sameDay] = await tx
    .select()
    .from(creditReconciliationRuns)
    .where(
      and(
        sql`${creditReconciliationRuns.finishedAt} is not null`,
        sql`(${creditReconciliationRuns.startedAt} at time zone 'Europe/Brussels')::date = ${brusselsDateKey(ctx.now)}::date`,
      ),
    )
    .orderBy(desc(creditReconciliationRuns.startedAt))
    .limit(1);
  return sameDay;
}

/**
 * Runs every check and writes one `credit_reconciliation_runs` row (`ok`, `mismatch` when a
 * check found something, `error` when a check failed: its savepoint rolls back and the others
 * still run). A scheduled run on a Brussels day that already has a finished run, or a second
 * execution of the same job, returns that run and writes nothing (double run: one run, one alert).
 */
export async function reconcileLedger(tx: DbOrTx, ctx: Ctx, input: { jobId: string | null; manual?: boolean }): Promise<ReconcileResult> {
  const manual = !!input.manual;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('credits:ledger_reconcile'))`);
  const prior = await priorRun(tx, ctx, { jobId: input.jobId, manual });
  if (prior) return resultOf(prior, true, false);

  const [run] = await tx.insert(creditReconciliationRuns).values({ jobId: input.jobId, startedAt: ctx.now }).returning();
  const findings: ReconcileFinding[] = [];
  const fixed: ReconcileFinding[] = [];
  let failed = false;
  for (const check of RECONCILE_CHECKS) {
    try {
      const r = await tx.transaction((sp) => CHECKS[check](sp, ctx));
      findings.push(...r.findings);
      fixed.push(...r.fixed);
    } catch {
      failed = true;
      findings.push({ check, expected: "completed", actual: "error" });
    }
  }
  const [counts] = await query<{ grants: number; bookings: number }>(
    tx,
    sql`select (select count(*) from credit_grants)::int as grants,
               (select count(*) from bookings where paid_with in ('credit', 'guest') and source <> 'import')::int as bookings`,
  );
  const status: ReconcileResult["status"] = failed ? "error" : findings.length ? "mismatch" : "ok";
  const [done] = await tx
    .update(creditReconciliationRuns)
    .set({
      finishedAt: ctx.now,
      status,
      checkedGrants: Number(counts?.grants ?? 0),
      checkedBookings: Number(counts?.bookings ?? 0),
      findings,
      fixed,
    })
    .where(eq(creditReconciliationRuns.id, run!.id))
    .returning();

  let alerted = false;
  if (status !== "ok") {
    const byCheck = new Map<string, number>();
    for (const f of findings) byCheck.set(f.check, (byCheck.get(f.check) ?? 0) + 1);
    const summary = [...byCheck].map(([c, n]) => `${c}: ${n}`).join(", ");
    await notifySlack(ctx, {
      fingerprint: `ledger:${run!.id}`,
      severity: "high",
      text: `Credits ledger reconciliation ${status}: ${findings.length} finding(s) (${summary}). Review /admin/credits/reconciliation`,
    });
    alerted = true;
  }
  return resultOf(done!, false, alerted);
}
