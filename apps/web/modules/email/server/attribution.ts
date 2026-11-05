/**
 * Campaign attribution (email spec section 2 `v_email_attribution`, decision 45), email-P9.
 *
 * Last click within 7 days before payment, campaigns and automations alike; fully refunded
 * orders are excluded, partially refunded ones count with their paid total.
 *
 * - `getCampaignAttribution(db, { from, to })`: ops' marketing dashboards. One row per campaign
 *   (`campaignId`, `automationId` null) and one per automation (`campaignId` null) with an
 *   attributed order paid in `[from, to)`; sorted by revenue, then name.
 * - `campaignAttributionTotals(db, campaignId)`: the campaign report's `attribution` block.
 */
import type { DbOrTx } from "@beam/db";
import { sql } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";

export const ATTRIBUTION_WINDOW_DAYS = 7;

export type AttributionTotals = { orders: number; revenueCents: number; firstPurchases: number };

export type CampaignAttributionRow = {
  campaignId: string | null;
  automationId: string | null;
  name: string;
  orders: number;
  revenueCents: number;
  firstPurchases: number;
};

type Raw = {
  campaign_id: string | null;
  automation_id: string | null;
  name: string | null;
  orders: number | string;
  revenue_cents: number | string | null;
  first_purchases: number | string;
};

const n = (v: unknown): number => (v === null || v === undefined || v === "" ? 0 : Number(v));

export async function getCampaignAttribution(db: DbOrTx, input: { from: Date; to: Date }): Promise<CampaignAttributionRow[]> {
  if (!(input.from instanceof Date) || !(input.to instanceof Date) || Number.isNaN(input.from.getTime()) || Number.isNaN(input.to.getTime())) return [];
  if (input.to.getTime() <= input.from.getTime()) return [];
  const rows = rowsOf<Raw>(
    await db.execute(sql`
      with a as (
        select va.campaign_id, case when va.campaign_id is null then va.automation_id end as automation_id,
          va.order_id, va.total_cents, va.is_first_purchase
        from v_email_attribution va
        where va.paid_at >= ${input.from.toISOString()}::timestamptz and va.paid_at < ${input.to.toISOString()}::timestamptz
          and (va.campaign_id is not null or va.automation_id is not null)
      )
      select a.campaign_id, a.automation_id, coalesce(c.name, au.name) as name,
        count(*)::int as orders,
        coalesce(sum(a.total_cents), 0)::bigint as revenue_cents,
        count(*) filter (where a.is_first_purchase)::int as first_purchases
      from a
      left join campaigns c on c.id = a.campaign_id
      left join automations au on au.id = a.automation_id
      group by a.campaign_id, a.automation_id, c.name, au.name
      order by revenue_cents desc, name asc nulls last`),
  );
  return rows.map((r) => ({
    campaignId: r.campaign_id,
    automationId: r.automation_id,
    name: r.name ?? "",
    orders: n(r.orders),
    revenueCents: n(r.revenue_cents),
    firstPurchases: n(r.first_purchases),
  }));
}

/** All orders attributed to one campaign, whenever they were paid. */
export async function campaignAttributionTotals(db: DbOrTx, campaignId: string): Promise<AttributionTotals> {
  const [row] = rowsOf<{ orders: number | string; revenue_cents: number | string | null; first_purchases: number | string }>(
    await db.execute(sql`
      select count(*)::int as orders,
        coalesce(sum(total_cents), 0)::bigint as revenue_cents,
        count(*) filter (where is_first_purchase)::int as first_purchases
      from v_email_attribution where campaign_id = ${campaignId}::uuid`),
  );
  return { orders: n(row?.orders), revenueCents: n(row?.revenue_cents), firstPurchases: n(row?.first_purchases) };
}
