/**
 * The campaign funnel (ops rule 73a, blueprint 33, query `getCampaignFunnel`). For the people
 * first-touched by a campaign key (`v_person_first_touch`) and created in the range, the count
 * and share reaching each step, each person counted at most once per step, with the median days
 * from lead to the step:
 *
 * - `lead`: created (day 0);
 * - `webinar`: a native webinar registration or an imported `webinar_registration`;
 * - `first_visit`: `person_stats.first_visit_at` set;
 * - `package`: a paid order line of product kind `package`;
 * - `repeat`: `person_stats.purchases >= 2` (days to the second purchase, paid orders and
 *   imported purchases);
 * - `member`: a membership that was ever active (any status but `pending`).
 *
 * Plus lifetime value (sum and average `person_stats.revenue_cents`), first purchases (people
 * with `first_purchase_at`) and lead cost (the key's spend in the range / leads). Testers are
 * excluded; erased people keep their aggregate place.
 */
import type { DbOrTx } from "@beam/db";
import { sql, type SQL } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { inRange, type DateRange } from "../reports/no-shows";
import { spendByCampaignKey } from "./ads";

export const FUNNEL_STEPS = ["lead", "webinar", "first_visit", "package", "repeat", "member"] as const;
export type FunnelStep = (typeof FUNNEL_STEPS)[number];

export type FunnelStepFigure = { step: FunnelStep; count: number; share: number | null; medianDays: number | null };

export type CampaignFunnelRow = {
  campaignKey: string;
  source: string;
  medium: string | null;
  campaign: string | null;
  steps: FunnelStepFigure[];
  firstPurchases: number;
  revenueCents: number;
  ltvCents: number | null;
  spendCents: number;
  leadCostCents: number | null;
};

type Raw = {
  campaign_key: string;
  source: string;
  medium: string | null;
  campaign: string | null;
  first_purchases: number | string;
  revenue_cents: number | string;
} & Record<`${FunnelStep}_n` | `${FunnelStep}_median`, number | string | null>;

const stepCols = (step: FunnelStep): SQL => {
  const at = sql.raw(`${step}_at`);
  return sql`count(*) filter (where ${at} is not null)::int as ${sql.raw(`${step}_n`)},
    percentile_cont(0.5) within group (order by greatest(0, extract(epoch from (${at} - created_at)) / 86400.0)) filter (where ${at} is not null) as ${sql.raw(`${step}_median`)}`;
};

/** Rule 73a over `range`, every campaign key or one (`campaignKey`). Sorted by leads, then key. */
export async function computeCampaignFunnel(db: DbOrTx, input: { range: DateRange; campaignKey?: string }): Promise<CampaignFunnelRow[]> {
  const one = input.campaignKey ? sql` and ft.campaign_key = ${input.campaignKey}` : sql``;
  const raw = rowsOf<Raw>(
    await db.execute(sql`with people as (
        select ft.person_id, ft.created_at, ft.campaign_key, ft.source, ft.medium, ft.campaign
        from v_person_first_touch ft
        where ft.is_tester = false and ${inRange(sql`ft.created_at`, input.range)}${one}
      ), buys as (
        select o.person_id, o.paid_at as at from orders o join people p on p.person_id = o.person_id
          where o.status in ('paid', 'partially_refunded', 'refunded') and o.paid_at is not null
        union all
        select ih.person_id, ih.occurred_at from imported_history ih join people p on p.person_id = ih.person_id where ih.kind = 'purchase'
      ), steps as (
        select p.*, p.created_at as lead_at,
          (select min(x.at) from (
              select wr.created_at as at from webinar_registrations wr where wr.person_id = p.person_id
              union all
              select ih.occurred_at from imported_history ih where ih.person_id = p.person_id and ih.kind = 'webinar_registration') x) as webinar_at,
          ps.first_visit_at as first_visit_at,
          (select min(o.paid_at) from orders o join order_lines ol on ol.order_id = o.id
             where o.person_id = p.person_id and o.status in ('paid', 'partially_refunded', 'refunded') and ol.product_kind = 'package') as package_at,
          case when coalesce(ps.purchases, 0) >= 2
               then coalesce((select b.at from buys b where b.person_id = p.person_id order by b.at offset 1 limit 1), ps.last_purchase_at) end as repeat_at,
          (select min(m.started_at) from memberships m where m.person_id = p.person_id and m.status <> 'pending') as member_at,
          ps.first_purchase_at, coalesce(ps.revenue_cents, 0) as revenue_cents
        from people p left join person_stats ps on ps.person_id = p.person_id
      )
      select campaign_key, max(source) as source, max(medium) as medium, max(campaign) as campaign,
        ${sql.join(FUNNEL_STEPS.map(stepCols), sql`, `)},
        count(*) filter (where first_purchase_at is not null)::int as first_purchases,
        coalesce(sum(revenue_cents), 0)::bigint as revenue_cents
      from steps group by campaign_key order by count(*) desc, campaign_key`),
  );
  const spend = await spendByCampaignKey(db, input.range, new Set(raw.map((r) => r.campaign_key)));
  return raw.map((r) => {
    const leads = Number(r.lead_n);
    const revenueCents = Number(r.revenue_cents);
    const spendCents = spend.get(r.campaign_key)?.spendCents ?? 0;
    return {
      campaignKey: r.campaign_key,
      source: r.source,
      medium: r.medium,
      campaign: r.campaign,
      steps: FUNNEL_STEPS.map((step) => {
        const count = Number(r[`${step}_n`]);
        const median = r[`${step}_median`];
        return { step, count, share: leads > 0 ? count / leads : null, medianDays: count > 0 && median !== null ? Math.round(Number(median) * 10) / 10 : null };
      }),
      firstPurchases: Number(r.first_purchases),
      revenueCents,
      ltvCents: leads > 0 ? Math.round(revenueCents / leads) : null,
      spendCents,
      leadCostCents: leads > 0 && spendCents > 0 ? Math.round(spendCents / leads) : null,
    };
  });
}

export const FUNNEL_CSV_COLUMNS = [
  "campaign_key",
  "source",
  "medium",
  "campaign",
  ...FUNNEL_STEPS.flatMap((s) => [`${s}_count`, `${s}_median_days`]),
  "first_purchases",
  "revenue_cents",
  "ltv_cents",
  "spend_cents",
  "lead_cost_cents",
] as const;

export function funnelCsvRowOf(r: CampaignFunnelRow): unknown[] {
  return [
    r.campaignKey,
    r.source,
    r.medium ?? "",
    r.campaign ?? "",
    ...r.steps.flatMap((s) => [s.count, s.medianDays ?? ""]),
    r.firstPurchases,
    r.revenueCents,
    r.ltvCents ?? "",
    r.spendCents,
    r.leadCostCents ?? "",
  ];
}
