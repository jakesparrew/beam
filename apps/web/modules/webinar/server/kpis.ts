/**
 * Webinars in the campaign funnel and the marketing dashboard (webinar spec section 1 "Release 3",
 * 4.7 `getWebinarKpis`, 12 webinar-P7; blueprint 33 and 34).
 *
 * The registration set of a range: native registrations made in `[from, to)` (`registered_at`),
 * not cancelled, of real persons (testers left out, like ops' marketing KPIs), one per resolved
 * person and webinar (`v_webinar_registration_facts` folds a merged loser's registration into the
 * winner's row).
 *
 * - `liveAttendanceRate` = registrations with live `attended` ÷ registrations with
 *   `registered_mode = 'live'` (registration is never attendance, rule 17); 0 without any.
 * - `replayViewRate` = registrations with replay watch time ÷ registrations that could watch a
 *   replay (`registered_mode` `live` or `replay`); 0 without any.
 * - "attended" in the segment, campaign and funnel rows is attendance in any mode.
 * - "converted" = a first booking or a paid order after `anchor_at` within `periodDays` (rule 40,
 *   `v_webinar_conversions`), the report's definition; `conversionRate` = converted ÷
 *   registrations. `revenueCents` = paid orders of the registrants within their windows, each
 *   order counted once even when its person registered for two webinars.
 * - The campaign is `lower(trim(utm.campaign))` (null when empty). Spend, clicks: ops'
 *   `ad_spend_daily` of the same campaign on the Brussels days of the range, matched on
 *   `campaign_name`, or on `campaign_external_id` when BEAM's UTM convention put the ad campaign
 *   id in `utm_campaign` (the matching of forms' `v_form_campaign_attribution`; an ad row whose
 *   id is itself a campaign key never also counts under its name). A campaign without ad rows has
 *   null spend, so null cost per registration and click-to-registration rate (never 0).
 * - Click-to-registration rate = registrations ÷ `ad_spend_daily.clicks` (null without clicks);
 *   ops keeps blueprint 34's invitation-based "registration rate" (ops rule 75).
 * - Funnel `firstVisit` and `firstPurchase`: registrations whose person's first ever visit
 *   (attended day or night booking, or imported visit) or first ever purchase (paid order or
 *   imported purchase) falls after `anchor_at` within `periodDays` (ops' "first" definitions).
 */
import { sql, type DbOrTx, type SQL } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";

export type WebinarKpiSegment = "lead" | "customer" | "member";
export const KPI_SEGMENTS = ["lead", "customer", "member"] as const satisfies readonly WebinarKpiSegment[];

export type KpiCounts = { registrations: number; attended: number; converted: number };

export type WebinarKpisResult = {
  webinars: number;
  registrations: number;
  liveAttendanceRate: number;
  replayViewRate: number;
  conversionRate: number;
  revenueCents: number;
  bySegment: Record<WebinarKpiSegment, KpiCounts>;
  byUtmCampaign: Array<{ campaign: string | null } & KpiCounts>;
};

export type CampaignFunnelRow = {
  campaign: string | null;
  registrations: number;
  attended: number;
  firstVisit: number;
  firstPurchase: number;
  spendCents: number | null;
  costPerRegistrationCents: number | null;
  clickToRegistrationRate: number | null;
};

export type KpiInput = { from: Date; to: Date; periodDays: number };

/** Paid statuses of a first purchase (ops' definition: a later refund does not undo it). */
const PAID = sql.raw(`('paid', 'partially_refunded', 'refunded')`);

const num = (v: unknown) => Number(v ?? 0);
const ratio = (a: number, b: number) => (b > 0 ? a / b : 0);
/** A JS instant as a `timestamptz` parameter. */
const instant = (d: Date): SQL => sql`${d.toISOString()}::timestamptz`;
const days = (n: number) => Math.max(1, Math.min(365, Math.trunc(Number.isFinite(n) ? n : 1)));

/** The normalised campaign key of a UTM value (trimmed, lower-cased, null when empty). */
export const campaignKey = (expr: SQL): SQL => sql`nullif(lower(trim(${expr})), '')`;

/** The registrations of the range with their facts (see the header). */
function registrationsOf(input: KpiInput): SQL {
  const end = sql`f.anchor_at + make_interval(days => ${days(input.periodDays)}::int)`;
  return sql`(
    select f.registration_id, f.webinar_id, f.person_id, f.person_status::text as person_status,
           f.registered_mode::text as registered_mode, f.anchor_at, ${end} as window_end,
           f.live_attended, f.replay_watched_sec > 0 as replay_viewed,
           (f.live_attended or f.replay_attended or f.od_attended) as attended,
           (c.first_booking_at <= ${end} or c.first_paid_order_at <= ${end}) as converted,
           ${campaignKey(sql`r.utm->>'campaign'`)} as campaign
    from v_webinar_registration_facts f
    join webinar_registrations r on r.id = f.registration_id
    join persons pe on pe.id = f.person_id
    join v_webinar_conversions c on c.registration_id = f.registration_id
    where f.status <> 'cancelled' and pe.is_tester = false
      and f.registered_at >= ${instant(input.from)} and f.registered_at < ${instant(input.to)})`;
}

/** The Brussels days `[from, to)` covers, as SQL dates (`to` exclusive; a partial last day counts). */
export function dayBounds(from: Date | SQL, to: Date | SQL): { first: SQL; last: SQL } {
  const f = from instanceof Date ? instant(from) : from;
  const t = to instanceof Date ? instant(to) : to;
  return {
    first: sql`((${f}) at time zone 'Europe/Brussels')::date`,
    last: sql`(((${t}) - interval '1 microsecond') at time zone 'Europe/Brussels')::date`,
  };
}

export type CampaignSpend = { spendCents: number; clicks: number };

/**
 * `ad_spend_daily` per campaign key for `keys` on the Brussels days `firstDay..lastDay` (SQL
 * dates). A key without ad rows is absent from the map.
 */
export async function campaignSpend(db: DbOrTx, keys: readonly string[], firstDay: SQL, lastDay: SQL): Promise<Map<string, CampaignSpend>> {
  const wanted = [...new Set(keys.filter(Boolean))];
  if (!wanted.length) return new Map();
  const list = sql.join(
    wanted.map((k) => sql`(${k}::text)`),
    sql`, `,
  );
  const rows = rowsOf<{ campaign: string; spend_cents: number; clicks: number }>(
    await db.execute(sql`with k(campaign) as (values ${list})
      select k.campaign, sum(a.spend_cents)::bigint as spend_cents, sum(a.clicks)::bigint as clicks
      from ad_spend_daily a
      join k on k.campaign = lower(trim(a.campaign_external_id))
        or (k.campaign = lower(trim(a.campaign_name))
            and not exists (select 1 from k k2 where k2.campaign = lower(trim(a.campaign_external_id))))
      where a.day_on >= ${firstDay} and a.day_on <= ${lastDay}
      group by 1`),
  );
  return new Map(rows.map((r) => [r.campaign, { spendCents: num(r.spend_cents), clicks: num(r.clicks) }]));
}

/** Cost per registration and click-to-registration rate of one campaign (null without spend, clicks or registrations). */
export function spendFigures(spend: CampaignSpend | undefined, registrations: number) {
  return {
    spendCents: spend ? spend.spendCents : null,
    costPerRegistrationCents: spend && registrations > 0 ? Math.round(spend.spendCents / registrations) : null,
    clickToRegistrationRate: spend && spend.clicks > 0 ? registrations / spend.clicks : null,
  };
}

/** The webinar KPIs of the ops marketing dashboard (section 4.7, R3). */
export async function webinarKpis(db: DbOrTx, input: KpiInput): Promise<WebinarKpisResult> {
  const reg = registrationsOf(input);
  const [totals] = rowsOf<Record<string, unknown>>(
    await db.execute(sql`with reg as ${reg}
      select count(distinct webinar_id)::int as webinars, count(*)::int as registrations,
        count(*) filter (where registered_mode = 'live')::int as live_registered,
        count(*) filter (where registered_mode = 'live' and live_attended)::int as live_attended,
        count(*) filter (where registered_mode in ('live', 'replay'))::int as replay_eligible,
        count(*) filter (where registered_mode in ('live', 'replay') and replay_viewed)::int as replay_viewed,
        count(*) filter (where converted)::int as converted,
        (select coalesce(sum(o.total_cents), 0)::bigint from orders o
          where o.status = 'paid' and o.paid_at is not null
            and exists (select 1 from reg x where x.person_id = o.person_id and o.paid_at > x.anchor_at and o.paid_at <= x.window_end)) as revenue_cents
      from reg`),
  );
  const groups = rowsOf<{ dim: "segment" | "campaign"; key: string | null; registrations: number; attended: number; converted: number }>(
    await db.execute(sql`with reg as ${reg}
      select 'segment' as dim, person_status as key, count(*)::int as registrations,
             count(*) filter (where attended)::int as attended, count(*) filter (where converted)::int as converted
      from reg group by 2
      union all
      select 'campaign', campaign, count(*)::int, count(*) filter (where attended)::int, count(*) filter (where converted)::int
      from reg group by 2`),
  );
  const counts = (r: (typeof groups)[number] | undefined): KpiCounts => ({ registrations: num(r?.registrations), attended: num(r?.attended), converted: num(r?.converted) });
  const registrations = num(totals?.registrations);
  return {
    webinars: num(totals?.webinars),
    registrations,
    liveAttendanceRate: ratio(num(totals?.live_attended), num(totals?.live_registered)),
    replayViewRate: ratio(num(totals?.replay_viewed), num(totals?.replay_eligible)),
    conversionRate: ratio(num(totals?.converted), registrations),
    revenueCents: num(totals?.revenue_cents),
    bySegment: Object.fromEntries(KPI_SEGMENTS.map((s) => [s, counts(groups.find((g) => g.dim === "segment" && g.key === s))])) as Record<WebinarKpiSegment, KpiCounts>,
    byUtmCampaign: groups
      .filter((g) => g.dim === "campaign")
      .map((g) => ({ campaign: g.key, ...counts(g) }))
      .sort(byRegistrationsThenCampaign),
  };
}

function byRegistrationsThenCampaign(a: { campaign: string | null; registrations: number }, b: { campaign: string | null; registrations: number }) {
  if (b.registrations !== a.registrations) return b.registrations - a.registrations;
  if (a.campaign === b.campaign) return 0;
  if (a.campaign === null) return 1;
  if (b.campaign === null) return -1;
  return a.campaign < b.campaign ? -1 : 1;
}

/** The campaign funnel: campaign -> registration -> attendance -> first visit -> first purchase, with spend (blueprint 33). */
export async function funnelByCampaign(db: DbOrTx, input: KpiInput): Promise<CampaignFunnelRow[]> {
  const rows = rowsOf<{ campaign: string | null; registrations: number; attended: number; first_visit: number; first_purchase: number }>(
    await db.execute(sql`with reg as ${registrationsOf(input)},
      firsts as (
        select x.person_id,
          (select min(v.at) from (
              select s.starts_at as at from bookings b join sessions s on s.id = b.session_id
                where b.person_id = x.person_id and b.status = 'attended' and s.kind in ('day', 'night')
              union all select ih.occurred_at from imported_history ih where ih.person_id = x.person_id and ih.kind = 'visit') v) as first_visit_at,
          (select min(v.at) from (
              select o.paid_at as at from orders o where o.person_id = x.person_id and o.status in ${PAID} and o.paid_at is not null
              union all select ih.occurred_at from imported_history ih where ih.person_id = x.person_id and ih.kind = 'purchase') v) as first_purchase_at
        from (select distinct person_id from reg) x)
      select reg.campaign, count(*)::int as registrations, count(*) filter (where reg.attended)::int as attended,
        count(*) filter (where fi.first_visit_at > reg.anchor_at and fi.first_visit_at <= reg.window_end)::int as first_visit,
        count(*) filter (where fi.first_purchase_at > reg.anchor_at and fi.first_purchase_at <= reg.window_end)::int as first_purchase
      from reg join firsts fi on fi.person_id = reg.person_id
      group by 1`),
  );
  const { first, last } = dayBounds(input.from, input.to);
  const spend = await campaignSpend(
    db,
    rows.flatMap((r) => (r.campaign ? [r.campaign] : [])),
    first,
    last,
  );
  return rows
    .map((r) => {
      const registrations = num(r.registrations);
      return {
        campaign: r.campaign,
        registrations,
        attended: num(r.attended),
        firstVisit: num(r.first_visit),
        firstPurchase: num(r.first_purchase),
        ...spendFigures(r.campaign ? spend.get(r.campaign) : undefined, registrations),
      };
    })
    .sort(byRegistrationsThenCampaign);
}
