/**
 * The person stats engine (ops spec 2.2 `person_stats`, rules 1-18). `computeStatsSql` gathers
 * every input of a chunk of persons in one set-based query, derives the B2C stage with the pure
 * `computeB2cStage`, writes the chunk with one `insert ... on conflict (person_id) do update`
 * and returns the stage changes and inactivity hits; `emitStatsEvents` turns them into
 * `ops.stage_changed` and `person.inactive_days` activity events (deduped by their keys).
 *
 * Running it twice gives identical rows apart from `computed_at` and `updated_at`: the stage
 * change time only moves when the stage changes. The R4 prediction columns are never touched.
 */
import type { DbOrTx, Tx } from "@beam/db";
import { personStats, type ActorJson } from "@beam/db/schema";
import {
  RETENTION_DEFAULTS,
  brusselsDate,
  computeB2cStage,
  inactivityDedupeKey,
  inactivityEventsFor,
  stageAnchor,
  stageChangedDedupeKey,
  type B2cStage,
  type InactivityThreshold,
  type RetentionDefaults,
} from "@beam/core/ops";
import { sql } from "@/lib/ctx";
import { recordEvent } from "@/lib/events";
import { rowsOf } from "@/lib/sensitive";
import { getSetting } from "@/lib/settings";

/** Rule 6: the activity kinds that make `ops.refresh_recent_stats` recompute a person. */
export const STATS_KINDS = [
  "order.paid",
  "order.refunded",
  "booking.confirmed",
  "booking.cancelled",
  "booking.late_cancelled",
  "booking.attended",
  "booking.no_show",
  "booking.check_in_undone",
  "form.completed",
  "email.clicked",
  "webinar.attended",
  "ops.history_imported",
] as const;
/** Kind prefixes of rule 6 (`credits.*`, `membership.*`). */
export const STATS_KIND_PREFIXES = ["credits.", "membership."] as const;

export type StageChange = { personId: string; from: B2cStage; to: B2cStage; at: Date };
export type InactivityHit = { personId: string; days: InactivityThreshold; anchorAt: Date; hasFutureBooking: boolean };

export type ComputeStatsOptions = {
  personIds?: string[];
  afterId?: string;
  limit: number;
  /** The instant the stats are computed for (default: now). */
  now?: Date;
  /** `settings.retention_defaults`; read from the settings when absent. */
  cfg?: RetentionDefaults;
};

export type ComputeStatsResult = { upserted: number; lastId: string | null; stageChanges: StageChange[]; inactivity: InactivityHit[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 86_400_000;

type Raw = Record<string, unknown>;
const toDate = (v: unknown): Date | null => (v === null || v === undefined ? null : v instanceof Date ? v : new Date(v as string | number));
const toInt = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const latest = (...dates: (Date | null)[]): Date | null =>
  dates.reduce<Date | null>((a, d) => (d && (!a || d.getTime() > a.getTime()) ? d : a), null);
const earliest = (...dates: (Date | null)[]): Date | null =>
  dates.reduce<Date | null>((a, d) => (d && (!a || d.getTime() < a.getTime()) ? d : a), null);

/** The stage thresholds and other keys of `settings.retention_defaults` (seeded default when absent). */
export async function loadRetentionDefaults(db: DbOrTx): Promise<RetentionDefaults> {
  try {
    const value = (await getSetting(db, "retention_defaults" as never)) as Partial<RetentionDefaults> | null;
    return { ...RETENTION_DEFAULTS, ...(value ?? {}) };
  } catch {
    return RETENTION_DEFAULTS;
  }
}

/** Every input of rules 1-13 for the target persons, one row per person ordered by id. */
function inputsQuery(opts: ComputeStatsOptions, now: Date) {
  const at = sql`${now.toISOString()}::timestamptz`;
  const ids = opts.personIds?.filter((id) => UUID.test(id));
  const byIds = ids ? sql`and p.id = any(${`{${ids.join(",")}}`}::uuid[])` : sql``;
  const after = opts.afterId && UUID.test(opts.afterId) ? sql`and p.id > ${opts.afterId}::uuid` : sql``;
  const paid = sql`o.company_id is null and o.paid_at is not null and o.status in ('paid', 'partially_refunded', 'refunded')`;
  const visit = sql`b.status = 'attended' and s.kind in ('day', 'night')`;
  return sql`with target as (
      select p.id from persons p
      where p.erased_at is null and p.merged_into_person_id is null ${byIds} ${after}
      order by p.id limit ${opts.limit}),
    ord as (
      select o.person_id, count(*)::int as n, sum(o.total_cents)::bigint as gross, min(o.paid_at) as first_at, max(o.paid_at) as last_at
      from orders o join target t on t.id = o.person_id where ${paid} group by o.person_id),
    ref as (
      select o.person_id, sum(r.amount_cents)::bigint as refunded
      from refunds r join orders o on o.id = r.order_id join target t on t.id = o.person_id
      where r.status = 'refunded' and ${paid} group by o.person_id),
    hist as (
      select h.person_id,
             count(*) filter (where h.kind = 'purchase')::int as purchases,
             coalesce(sum(h.amount_cents) filter (where h.kind = 'purchase'), 0)::bigint as revenue,
             min(h.occurred_at) filter (where h.kind = 'purchase') as first_purchase_at,
             max(h.occurred_at) filter (where h.kind = 'purchase') as last_purchase_at,
             count(*) filter (where h.kind = 'visit')::int as visits,
             min(h.occurred_at) filter (where h.kind = 'visit') as first_visit_at,
             max(h.occurred_at) filter (where h.kind = 'visit') as last_visit_at,
             count(*) filter (where h.kind = 'visit' and h.occurred_at >= ${at} - interval '60 days')::int as visits_60,
             count(*) filter (where h.kind = 'visit' and h.occurred_at >= ${at} - interval '240 days'
                                and h.occurred_at < ${at} - interval '60 days')::int as visits_prev,
             count(*) filter (where h.kind = 'event_attendance')::int as events,
             count(*) filter (where h.kind = 'no_show')::int as no_shows,
             max(h.occurred_at) filter (where h.kind = 'webinar_attendance') as webinar_at,
             max(h.occurred_at) filter (where h.kind = 'webinar_registration') as webinar_reg_at
      from imported_history h join target t on t.id = h.person_id group by h.person_id),
    bk as (
      select b.person_id,
             count(*) filter (where ${visit})::int as visits,
             min(s.starts_at) filter (where ${visit}) as first_visit_at,
             max(s.starts_at) filter (where ${visit}) as last_visit_at,
             count(*) filter (where ${visit} and s.starts_at >= ${at} - interval '60 days')::int as visits_60,
             count(*) filter (where ${visit} and s.starts_at >= ${at} - interval '240 days'
                                and s.starts_at < ${at} - interval '60 days')::int as visits_prev,
             count(*) filter (where b.status = 'attended' and s.kind = 'event')::int as events,
             count(*) filter (where b.status = 'no_show')::int as no_shows,
             count(*) filter (where b.status = 'late_cancelled')::int as late,
             max(b.created_at) as last_booked_at,
             min(s.starts_at) filter (where b.status in ('reserved', 'confirmed') and s.starts_at > ${at}) as next_at
      from bookings b join sessions s on s.id = b.session_id join target t on t.id = b.person_id group by b.person_id),
    fm as (
      select fs.person_id, max(fs.completed_at) as at from form_submissions fs join target t on t.id = fs.person_id
      where fs.status = 'completed' group by fs.person_id),
    em as (
      select m.person_id, max(m.clicked_at) as at from email_messages m join target t on t.id = m.person_id
      where m.clicked_at is not null group by m.person_id),
    ev as (
      select a.person_id, max(a.occurred_at) filter (where a.kind = 'webinar.attended') as webinar_at,
             max(a.occurred_at) filter (where a.kind = 'webinar.registered') as webinar_reg_at
      from activity_events a join target t on t.id = a.person_id
      where a.kind in ('webinar.attended', 'webinar.registered') group by a.person_id)
    select t.id as person_id,
           coalesce(ord.n, 0) as order_count, coalesce(ord.gross, 0) as order_gross, coalesce(ref.refunded, 0) as refunded,
           ord.first_at as order_first_at, ord.last_at as order_last_at,
           coalesce(hist.purchases, 0) as hist_purchases, coalesce(hist.revenue, 0) as hist_revenue,
           hist.first_purchase_at as hist_first_purchase_at, hist.last_purchase_at as hist_last_purchase_at,
           coalesce(hist.visits, 0) as hist_visits, hist.first_visit_at as hist_first_visit_at, hist.last_visit_at as hist_last_visit_at,
           coalesce(hist.visits_60, 0) as hist_visits_60, coalesce(hist.visits_prev, 0) as hist_visits_prev,
           coalesce(hist.events, 0) as hist_events, coalesce(hist.no_shows, 0) as hist_no_shows,
           hist.webinar_at as hist_webinar_at, hist.webinar_reg_at as hist_webinar_reg_at,
           coalesce(bk.visits, 0) as bk_visits, bk.first_visit_at as bk_first_visit_at, bk.last_visit_at as bk_last_visit_at,
           coalesce(bk.visits_60, 0) as bk_visits_60, coalesce(bk.visits_prev, 0) as bk_visits_prev,
           coalesce(bk.events, 0) as bk_events, coalesce(bk.no_shows, 0) as bk_no_shows, coalesce(bk.late, 0) as bk_late,
           bk.last_booked_at, bk.next_at,
           fm.at as form_at, em.at as click_at, ev.webinar_at as ev_webinar_at, ev.webinar_reg_at as ev_webinar_reg_at,
           coalesce(st.status, 'lead') as status,
           old.person_id is not null as has_row, old.b2c_stage as old_stage, old.b2c_stage_changed_at as old_changed_at
    from target t
    left join ord on ord.person_id = t.id left join ref on ref.person_id = t.id left join hist on hist.person_id = t.id
    left join bk on bk.person_id = t.id left join fm on fm.person_id = t.id left join em on em.person_id = t.id
    left join ev on ev.person_id = t.id
    left join v_person_status st on st.person_id = t.id
    left join person_stats old on old.person_id = t.id
    order by t.id`;
}

type Computed = {
  row: typeof personStats.$inferInsert;
  stageChange: StageChange | null;
  inactivity: InactivityHit | null;
};

/** Rules 1-17 for one input row (pure apart from the clock). */
function derive(r: Raw, now: Date, cfg: RetentionDefaults, today: string): Computed {
  const personId = String(r.person_id);
  const purchases = toInt(r.order_count) + toInt(r.hist_purchases);
  const revenueCents = toInt(r.order_gross) - toInt(r.refunded) + toInt(r.hist_revenue);
  const visits = toInt(r.bk_visits) + toInt(r.hist_visits);
  const eventsAttended = toInt(r.bk_events) + toInt(r.hist_events);
  const firstPurchaseAt = earliest(toDate(r.order_first_at), toDate(r.hist_first_purchase_at));
  const lastPurchaseAt = latest(toDate(r.order_last_at), toDate(r.hist_last_purchase_at));
  const firstVisitAt = earliest(toDate(r.bk_first_visit_at), toDate(r.hist_first_visit_at));
  const lastVisitAt = latest(toDate(r.bk_last_visit_at), toDate(r.hist_last_visit_at));
  const lastBookedAt = toDate(r.last_booked_at);
  const formAt = toDate(r.form_at);
  const clickAt = toDate(r.click_at);
  const webinarAt = latest(toDate(r.hist_webinar_at), toDate(r.ev_webinar_at));
  const webinarRegAt = latest(toDate(r.hist_webinar_reg_at), toDate(r.ev_webinar_reg_at));
  const nextBookingAt = toDate(r.next_at);
  const hasFutureBooking = nextBookingAt !== null;
  const status = (String(r.status) as "lead" | "customer" | "member") ?? "lead";

  const stage = computeB2cStage({
    status,
    purchases,
    visits,
    noShows: toInt(r.bk_no_shows) + toInt(r.hist_no_shows),
    lastVisitAt,
    lastPurchaseAt,
    hasFutureBooking,
    attendedEventOrWebinar: eventsAttended > 0 || webinarAt !== null,
    lastEngagementAt: latest(formAt, clickAt, webinarRegAt, lastBookedAt),
    now,
    thresholds: cfg,
  });
  const oldStage = (r.old_stage ?? null) as B2cStage | null;
  const hasRow = r.has_row === true || r.has_row === "t";
  const changed = hasRow && oldStage !== null && oldStage !== stage;
  // A first computation sets the stage silently (no burst of events after the cut-over).
  const changedAt = changed || (!hasRow && stage !== "lead") ? now : toDate(r.old_changed_at);

  let inactivity: InactivityHit | null = null;
  if (purchases >= 1 || visits >= 1) {
    const anchorAt = stageAnchor({ lastVisitAt, lastPurchaseAt });
    const hit = inactivityEventsFor({ anchorAt, today });
    if (hit && anchorAt) inactivity = { personId, days: hit.days, anchorAt, hasFutureBooking };
  }

  return {
    row: {
      personId,
      revenueCents,
      purchases,
      visits,
      visitsLast60d: toInt(r.bk_visits_60) + toInt(r.hist_visits_60),
      visitsPrev180d: toInt(r.bk_visits_prev) + toInt(r.hist_visits_prev),
      eventsAttended,
      noShows: toInt(r.bk_no_shows) + toInt(r.hist_no_shows),
      lateCancellations: toInt(r.bk_late),
      // Rule 2: half up, 0 without purchases.
      avgOrderCents: purchases > 0 ? Math.floor(revenueCents / purchases + 0.5) : 0,
      firstPurchaseAt,
      lastPurchaseAt,
      firstVisitAt,
      lastVisitAt,
      lastActivityAt: latest(lastVisitAt, lastPurchaseAt, lastBookedAt, formAt, clickAt, webinarAt),
      nextBookingAt,
      b2cStage: stage,
      b2cStageChangedAt: changedAt,
      computedAt: now,
    },
    stageChange: changed ? { personId, from: oldStage, to: stage, at: now } : null,
    inactivity,
  };
}

const excluded = (column: string) => sql.raw(`excluded.${column}`);

/**
 * Recomputes a chunk of persons: the given `personIds`, or the next `limit` persons after
 * `afterId` in id order (rule 5). Erased and merged persons are skipped.
 */
export async function computeStatsSql(tx: Tx, opts: ComputeStatsOptions): Promise<ComputeStatsResult> {
  const now = opts.now ?? new Date();
  if (opts.personIds && opts.personIds.length === 0) return { upserted: 0, lastId: null, stageChanges: [], inactivity: [] };
  const cfg = opts.cfg ?? (await loadRetentionDefaults(tx));
  const today = brusselsDate(now);
  const raw = rowsOf<Raw>(await tx.execute(inputsQuery(opts, now)));
  if (raw.length === 0) return { upserted: 0, lastId: null, stageChanges: [], inactivity: [] };
  const computed = raw.map((r) => derive(r, now, cfg, today));

  await tx
    .insert(personStats)
    .values(computed.map((c) => c.row))
    .onConflictDoUpdate({
      target: personStats.personId,
      set: {
        revenueCents: excluded("revenue_cents"),
        purchases: excluded("purchases"),
        visits: excluded("visits"),
        visitsLast60d: excluded("visits_last_60d"),
        visitsPrev180d: excluded("visits_prev_180d"),
        eventsAttended: excluded("events_attended"),
        noShows: excluded("no_shows"),
        lateCancellations: excluded("late_cancellations"),
        avgOrderCents: excluded("avg_order_cents"),
        firstPurchaseAt: excluded("first_purchase_at"),
        lastPurchaseAt: excluded("last_purchase_at"),
        firstVisitAt: excluded("first_visit_at"),
        lastVisitAt: excluded("last_visit_at"),
        lastActivityAt: excluded("last_activity_at"),
        nextBookingAt: excluded("next_booking_at"),
        b2cStage: excluded("b2c_stage"),
        b2cStageChangedAt: excluded("b2c_stage_changed_at"),
        computedAt: excluded("computed_at"),
        updatedAt: sql`now()`,
      },
    });

  return {
    upserted: computed.length,
    lastId: computed[computed.length - 1]!.row.personId,
    stageChanges: computed.flatMap((c) => (c.stageChange ? [c.stageChange] : [])),
    inactivity: computed.flatMap((c) => (c.inactivity ? [c.inactivity] : [])),
  };
}

const SYSTEM_ACTOR: ActorJson = { kind: "system", id: null };

/**
 * Rule 14 and 16: writes `ops.stage_changed` (`stage:<person_id>:<to>:<YYYY-MM-DD>`) and, when
 * `inactivity` is true (the nightly run), `person.inactive_days`
 * (`person:<id>:inactive:<days>:<anchor date>`). Duplicates are dropped by the dedupe keys.
 */
export async function emitStatsEvents(
  tx: DbOrTx,
  result: Pick<ComputeStatsResult, "stageChanges" | "inactivity">,
  opts: { actor?: ActorJson; inactivity: boolean },
): Promise<{ stageEvents: number; inactivityEvents: number }> {
  const actor = opts.actor ?? SYSTEM_ACTOR;
  let stageEvents = 0;
  let inactivityEvents = 0;
  for (const c of result.stageChanges) {
    const { id } = await recordEvent(tx, actor, {
      kind: "ops.stage_changed",
      personId: c.personId,
      occurredAt: c.at,
      data: { from: c.from, to: c.to },
      dedupeKey: stageChangedDedupeKey(c.personId, c.to, brusselsDate(c.at)),
    });
    if (id !== null) stageEvents++;
  }
  if (opts.inactivity) {
    for (const hit of result.inactivity) {
      const { id } = await recordEvent(tx, actor, {
        kind: "person.inactive_days",
        personId: hit.personId,
        data: { days: hit.days, anchor_at: hit.anchorAt.toISOString(), has_future_booking: hit.hasFutureBooking },
        dedupeKey: inactivityDedupeKey(hit.personId, hit.days, hit.anchorAt),
      });
      if (id !== null) inactivityEvents++;
    }
  }
  return { stageEvents, inactivityEvents };
}

/** Edge case 2: removes the stats rows of erased and merged persons. */
export async function deleteStaleStats(tx: DbOrTx): Promise<number> {
  const rows = rowsOf<{ id: string }>(
    await tx.execute(sql`delete from person_stats ps using persons p
      where p.id = ps.person_id and (p.erased_at is not null or p.merged_into_person_id is not null) returning ps.id`),
  );
  return rows.length;
}

/** Days between two instants (for tests and the digest). */
export const daysBetween = (a: Date, b: Date) => Math.floor((b.getTime() - a.getTime()) / DAY_MS);
