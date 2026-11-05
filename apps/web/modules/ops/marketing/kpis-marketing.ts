/**
 * The marketing KPIs (ops rule 75, R3, `/admin/reports/marketing`), for a range of Brussels
 * dates and the range of the same length just before it. Testers are excluded everywhere.
 *
 * - leads generated: people created in the range whose `acquisition.source` is not `import` and
 *   who had no paid order when created, split by first-touch source and campaign;
 * - registration rate: native webinar registrations in the range / delivered emails of `events`
 *   campaigns sent in the range (campaigns carry no session link, so the rate is over the range,
 *   not per webinar);
 * - attendance rate: webinar's `liveAttendanceRate` from `getWebinarKpis` (live watch time of at
 *   least the webinar's `attended_min_sec` over live-mode registrations) combined with imported
 *   history (`webinar_attendance` rows of mode `live` over `webinar_registration` rows); event
 *   attendance = attended / confirmed event bookings (confirmed, attended or no-show);
 * - lead-to-visit: leads of the range with a first visit within 90 days / leads;
 * - visit-to-purchase: first visits in the range followed by a first purchase within 30 days;
 * - assessment completion and conversion (first purchase within 60 days of completion);
 * - webinar conversion: registrations of the range followed by a booking or purchase within 7,
 *   30 or 90 days, split by the registrant's status at registration (lead, customer, member);
 * - reactivation revenue: orders paid in the range more than 90 days after the person's
 *   previous visit or purchase;
 * - abandoned-cart recovery: rule 40, from the abandoned checkouts report.
 */
import type { DbOrTx } from "@beam/db";
import { NotImplementedError } from "@beam/core/errors";
import { sql, type SQL } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { getWebinarKpis, type WebinarKpis } from "@/modules/webinar/api";
import { computeAbandonedReport } from "../reports/abandoned";
import { addDays, inRange, rangeEnd, type DateRange } from "../reports/no-shows";
import { rate, type Rate } from "./management";

export type KpiPair<T> = { current: T; previous: T };
export type LeadsBySource = { source: string; campaign: string | null; leads: number };
export const CONVERSION_WINDOWS = [7, 30, 90] as const;
export const REGISTRANT_SEGMENTS = ["lead", "customer", "member"] as const;
export type RegistrantSegment = (typeof REGISTRANT_SEGMENTS)[number];

export type AttendanceFigure = {
  /** The combined rate (native live attendance and imported history). */
  combined: Rate;
  /** `getWebinarKpis().liveAttendanceRate`; null while webinar's function is not available. */
  nativeRate: number | null;
  nativeLiveRegistrations: number;
  imported: Rate;
  events: Rate;
};

export type MarketingKpiSet = {
  leads: number;
  leadsBySource: LeadsBySource[];
  registrationRate: Rate;
  attendance: AttendanceFigure;
  leadToVisit: Rate;
  visitToPurchase: Rate;
  assessmentCompletion: Rate;
  assessmentConversion: Rate;
  webinarConversion: Record<RegistrantSegment, Record<`d${(typeof CONVERSION_WINDOWS)[number]}`, Rate>>;
  reactivationRevenueCents: number;
  reactivationOrders: number;
  abandoned: { abandoned: number; recovered: number; recoveryRate: number | null; recoveryRevenueCents: number };
};

export type MarketingKpis = { range: DateRange; previousRange: DateRange; current: MarketingKpiSet; previous: MarketingKpiSet };

const PAID = sql.raw(`('paid', 'partially_refunded', 'refunded')`);

/** First visits and first purchases of every real person (visits per rule 3; purchases with imported history). */
const FIRSTS = sql`(
  select pe.id as person_id, pe.created_at,
    (select min(x.at) from (
        select s.starts_at as at from bookings b join sessions s on s.id = b.session_id
          where b.person_id = pe.id and b.status = 'attended' and s.kind in ('day', 'night')
        union all select ih.occurred_at from imported_history ih where ih.person_id = pe.id and ih.kind = 'visit') x) as first_visit_at,
    (select min(x.at) from (
        select o.paid_at as at from orders o where o.person_id = pe.id and o.status in ${PAID} and o.paid_at is not null
        union all select ih.occurred_at from imported_history ih where ih.person_id = pe.id and ih.kind = 'purchase') x) as first_purchase_at
  from persons pe where pe.is_tester = false and pe.merged_into_person_id is null
)`;

const LEADS = (range: DateRange): SQL => sql`(
  select ft.person_id, ft.created_at, ft.source, ft.campaign from v_person_first_touch ft
  where ft.is_tester = false and ${inRange(sql`ft.created_at`, range)}
    and coalesce(ft.acquisition_source, '') <> 'import'
    and not exists (select 1 from orders o where o.person_id = ft.person_id and o.status in ${PAID} and o.paid_at <= ft.created_at)
)`;

async function first<T>(db: DbOrTx, q: SQL): Promise<T> {
  return rowsOf<T>(await db.execute(q))[0]!;
}
const n = (v: unknown) => Number(v ?? 0);
const isStub = (e: unknown) => e instanceof NotImplementedError || (e as { name?: string } | null)?.name === "NotImplementedError";

/** The range of the same number of days just before `range`. */
export function previousRange(range: DateRange): DateRange {
  const days = Math.round((Date.parse(`${range.to}T12:00:00Z`) - Date.parse(`${range.from}T12:00:00Z`)) / 86_400_000) + 1;
  return { from: addDays(range.from, -days), to: addDays(range.from, -1) };
}

/** Brussels midnight at the start of `range.from` and after `range.to`, as instants. */
async function bounds(db: DbOrTx, range: DateRange): Promise<{ from: Date; to: Date }> {
  const r = await first<{ f: string | Date; t: string | Date }>(db, sql`select (${range.from}::date::timestamp at time zone 'Europe/Brussels') as f, ${rangeEnd(range)} as t`);
  return { from: new Date(r.f), to: new Date(r.t) };
}

/** Rule 75's attendance rate: webinar's native live rate (when available), imported history and events. */
export async function attendanceFigure(db: DbOrTx, range: DateRange): Promise<AttendanceFigure> {
  const { from, to } = await bounds(db, range);
  const periodDays = Math.max(1, Math.round((to.getTime() - from.getTime()) / 86_400_000));
  let kpis: WebinarKpis | null = null;
  try {
    kpis = await getWebinarKpis(db, { from, to, periodDays });
  } catch (error) {
    if (!isStub(error)) throw error;
  }
  const r = await first<Record<string, unknown>>(
    db,
    sql`select
      (select count(*) from webinar_registrations wr join persons pe on pe.id = wr.person_id
         where pe.is_tester = false and wr.registered_mode = 'live' and wr.status <> 'cancelled' and ${inRange(sql`wr.created_at`, range)})::int as native_live,
      (select count(*) from imported_history ih join persons pe on pe.id = ih.person_id
         where pe.is_tester = false and ih.kind = 'webinar_registration' and ${inRange(sql`ih.occurred_at`, range)})::int as imp_reg,
      (select count(*) from imported_history ih join persons pe on pe.id = ih.person_id
         where pe.is_tester = false and ih.kind = 'webinar_attendance' and coalesce(ih.data->>'mode', 'live') = 'live' and ${inRange(sql`ih.occurred_at`, range)})::int as imp_att,
      (select count(*) filter (where b.status = 'attended') from bookings b join sessions s on s.id = b.session_id join persons pe on pe.id = b.person_id
         where pe.is_tester = false and s.kind = 'event' and b.status in ('confirmed', 'attended', 'no_show') and ${inRange(sql`s.starts_at`, range)})::int as ev_att,
      (select count(*) from bookings b join sessions s on s.id = b.session_id join persons pe on pe.id = b.person_id
         where pe.is_tester = false and s.kind = 'event' and b.status in ('confirmed', 'attended', 'no_show') and ${inRange(sql`s.starts_at`, range)})::int as ev_conf`,
  );
  const nativeLive = n(r.native_live);
  const nativeRate = kpis ? kpis.liveAttendanceRate : null;
  const nativeAttended = nativeRate === null ? 0 : Math.round(nativeRate * nativeLive);
  const imported = rate(n(r.imp_att), n(r.imp_reg));
  return {
    combined: rate(nativeAttended + imported.numerator, (nativeRate === null ? 0 : nativeLive) + imported.denominator),
    nativeRate,
    nativeLiveRegistrations: nativeLive,
    imported,
    events: rate(n(r.ev_att), n(r.ev_conf)),
  };
}

/** Rule 75 for one range. */
export async function computeMarketingKpiSet(db: DbOrTx, range: DateRange): Promise<MarketingKpiSet> {
  const leadsBySource = rowsOf<{ source: string; campaign: string | null; leads: number }>(
    await db.execute(sql`select l.source, l.campaign, count(*)::int as leads from ${LEADS(range)} l group by l.source, l.campaign order by count(*) desc, l.source, l.campaign nulls first`),
  ).map((r) => ({ source: r.source, campaign: r.campaign, leads: n(r.leads) }));
  const leads = leadsBySource.reduce((a, r) => a + r.leads, 0);

  const r = await first<Record<string, unknown>>(
    db,
    sql`with f as ${FIRSTS}, l as ${LEADS(range)}
    select
      (select count(*) from webinar_registrations wr join persons pe on pe.id = wr.person_id
         where pe.is_tester = false and wr.status <> 'cancelled' and ${inRange(sql`wr.created_at`, range)})::int as registrations,
      (select count(*) from email_messages em join campaigns c on c.id = em.campaign_id
         where c.purpose = 'events' and em.delivered_at is not null and ${inRange(sql`em.sent_at`, range)})::int as delivered_invites,
      (select count(*) from l join f on f.person_id = l.person_id
         where f.first_visit_at is not null and f.first_visit_at <= l.created_at + interval '90 days')::int as leads_visited,
      (select count(*) from f where ${inRange(sql`f.first_visit_at`, range)})::int as first_visits,
      (select count(*) from f where ${inRange(sql`f.first_visit_at`, range)}
         and f.first_purchase_at >= f.first_visit_at and f.first_purchase_at <= f.first_visit_at + interval '30 days')::int as visits_purchased,
      (select count(*) from form_submissions fs join forms fo on fo.id = fs.form_id left join persons pe on pe.id = fs.person_id
         where fo.kind = 'assessment' and coalesce(pe.is_tester, false) = false and ${inRange(sql`fs.started_at`, range)})::int as assess_started,
      (select count(*) from form_submissions fs join forms fo on fo.id = fs.form_id left join persons pe on pe.id = fs.person_id
         where fo.kind = 'assessment' and coalesce(pe.is_tester, false) = false and fs.status = 'completed' and ${inRange(sql`fs.started_at`, range)})::int as assess_completed_of_started,
      (select count(*) from form_submissions fs join forms fo on fo.id = fs.form_id left join persons pe on pe.id = fs.person_id
         where fo.kind = 'assessment' and coalesce(pe.is_tester, false) = false and fs.status = 'completed' and ${inRange(sql`fs.completed_at`, range)})::int as assess_completed,
      (select count(*) from form_submissions fs join forms fo on fo.id = fs.form_id join f on f.person_id = fs.person_id
         where fo.kind = 'assessment' and fs.status = 'completed' and ${inRange(sql`fs.completed_at`, range)}
           and f.first_purchase_at >= fs.completed_at and f.first_purchase_at <= fs.completed_at + interval '60 days')::int as assess_converted,
      (select coalesce(sum(o.total_cents), 0) from orders o join persons pe on pe.id = o.person_id
         where pe.is_tester = false and o.status in ${PAID} and ${inRange(sql`o.paid_at`, range)}
           and (select max(x.at) from (
                 select s.starts_at as at from bookings b join sessions s on s.id = b.session_id
                   where b.person_id = o.person_id and b.status = 'attended' and s.kind in ('day', 'night') and s.starts_at < o.paid_at
                 union all select o2.paid_at from orders o2 where o2.person_id = o.person_id and o2.id <> o.id and o2.status in ${PAID} and o2.paid_at < o.paid_at
                 union all select ih.occurred_at from imported_history ih where ih.person_id = o.person_id and ih.kind in ('visit', 'purchase') and ih.occurred_at < o.paid_at) x)
               < o.paid_at - interval '90 days')::bigint as reactivation_cents,
      (select count(*) from orders o join persons pe on pe.id = o.person_id
         where pe.is_tester = false and o.status in ${PAID} and ${inRange(sql`o.paid_at`, range)}
           and (select max(x.at) from (
                 select s.starts_at as at from bookings b join sessions s on s.id = b.session_id
                   where b.person_id = o.person_id and b.status = 'attended' and s.kind in ('day', 'night') and s.starts_at < o.paid_at
                 union all select o2.paid_at from orders o2 where o2.person_id = o.person_id and o2.id <> o.id and o2.status in ${PAID} and o2.paid_at < o.paid_at
                 union all select ih.occurred_at from imported_history ih where ih.person_id = o.person_id and ih.kind in ('visit', 'purchase') and ih.occurred_at < o.paid_at) x)
               < o.paid_at - interval '90 days')::int as reactivation_orders`,
  );

  const conv = rowsOf<Record<string, unknown>>(
    await db.execute(sql`select wr.person_status::text as segment, count(*)::int as registrations,
        ${sql.join(
          CONVERSION_WINDOWS.map(
            (d) => sql`count(*) filter (where exists (
              select 1 from bookings b where b.person_id = wr.person_id and b.created_at > wr.created_at and b.created_at <= wr.created_at + ${sql.raw(`interval '${d} days'`)}
                and b.status not in ('cancelled')
              union all
              select 1 from orders o where o.person_id = wr.person_id and o.status in ${PAID} and o.paid_at > wr.created_at and o.paid_at <= wr.created_at + ${sql.raw(`interval '${d} days'`)}))::int as ${sql.raw(`d${d}`)}`,
          ),
          sql`, `,
        )}
      from webinar_registrations wr join persons pe on pe.id = wr.person_id
      where pe.is_tester = false and wr.status <> 'cancelled' and ${inRange(sql`wr.created_at`, range)}
      group by wr.person_status`),
  );
  const webinarConversion = Object.fromEntries(
    REGISTRANT_SEGMENTS.map((seg) => {
      const row = conv.find((c) => c.segment === seg);
      return [seg, Object.fromEntries(CONVERSION_WINDOWS.map((d) => [`d${d}`, rate(n(row?.[`d${d}`]), n(row?.registrations))]))];
    }),
  ) as MarketingKpiSet["webinarConversion"];

  const abandoned = await computeAbandonedReport(db, { range });
  return {
    leads,
    leadsBySource,
    registrationRate: rate(n(r.registrations), n(r.delivered_invites)),
    attendance: await attendanceFigure(db, range),
    leadToVisit: rate(n(r.leads_visited), leads),
    visitToPurchase: rate(n(r.visits_purchased), n(r.first_visits)),
    assessmentCompletion: rate(n(r.assess_completed_of_started), n(r.assess_started)),
    assessmentConversion: rate(n(r.assess_converted), n(r.assess_completed)),
    webinarConversion,
    reactivationRevenueCents: n(r.reactivation_cents),
    reactivationOrders: n(r.reactivation_orders),
    abandoned: { abandoned: abandoned.abandoned, recovered: abandoned.recovered, recoveryRate: abandoned.recoveryRate, recoveryRevenueCents: abandoned.recoveryRevenueCents },
  };
}

/** Rule 75 for `range` and the range before it. */
export async function computeMarketingKpis(db: DbOrTx, range: DateRange): Promise<MarketingKpis> {
  const prev = previousRange(range);
  return { range, previousRange: prev, current: await computeMarketingKpiSet(db, range), previous: await computeMarketingKpiSet(db, prev) };
}

export type KpiTileRow = { key: string; current: number | null; previous: number | null; unit: "count" | "pct" | "cents" };

/** The headline KPIs as flat rows (page tiles and CSV). */
export function kpiRowsOf(k: MarketingKpis): KpiTileRow[] {
  const pct = (key: string, f: (s: MarketingKpiSet) => Rate): KpiTileRow => ({ key, current: f(k.current).rate, previous: f(k.previous).rate, unit: "pct" });
  return [
    { key: "leads", current: k.current.leads, previous: k.previous.leads, unit: "count" },
    pct("registration_rate", (s) => s.registrationRate),
    pct("attendance_rate", (s) => s.attendance.combined),
    pct("event_attendance_rate", (s) => s.attendance.events),
    pct("lead_to_visit", (s) => s.leadToVisit),
    pct("visit_to_purchase", (s) => s.visitToPurchase),
    pct("assessment_completion", (s) => s.assessmentCompletion),
    pct("assessment_conversion", (s) => s.assessmentConversion),
    { key: "reactivation_revenue", current: k.current.reactivationRevenueCents, previous: k.previous.reactivationRevenueCents, unit: "cents" },
    { key: "abandoned_recovery_rate", current: k.current.abandoned.recoveryRate, previous: k.previous.abandoned.recoveryRate, unit: "pct" },
    { key: "abandoned_recovery_revenue", current: k.current.abandoned.recoveryRevenueCents, previous: k.previous.abandoned.recoveryRevenueCents, unit: "cents" },
  ];
}
