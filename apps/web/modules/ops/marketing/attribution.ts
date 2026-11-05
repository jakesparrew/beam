/**
 * Campaign attribution (ops rule 72, R3). `attribution_credits` is derived data, rebuilt by
 * `ops.compute_attribution`:
 *
 * - **first touch**: 100 % of every paid order to the person's acquisition campaign
 *   (`v_person_first_touch.campaign_key`, `direct|none` when the acquisition has no campaign);
 * - **linear**: each order split equally over the distinct campaign keys of the person's
 *   `v_marketing_touches` in the 90 days before `paid_at` (inclusive), falling back to the first
 *   touch when there are none.
 *
 * Weights are integer ten-thousandths (`numeric(5,4)`) that sum to exactly 1 per order and
 * model; the order's net revenue (total minus refunded amounts) is split the same way in whole
 * cents, so the credits of an order always add up to its revenue. Orders without a person
 * (company orders) are not attributed (`attribution_credits.person_id` is not null).
 */
import type { DbOrTx } from "@beam/db";
import { attributionCredits } from "@beam/db/schema";
import { sql } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { inRange, type DateRange } from "../reports/no-shows";
import { adsDataAsOf, spendByCampaignKey, type CampaignSpend } from "./ads";

/** One marketing touch of a person (a `v_marketing_touches` row). */
export type Touch = { campaignKey: string; touchedAt: Date; source?: string | null; medium?: string | null; campaign?: string | null };

export const ATTRIBUTION_WINDOW_DAYS = 90;
export const DIRECT_KEY = "direct|none";
const DAY_MS = 86_400_000;
const UNITS = 10_000;

/** Splits `UNITS` over `n` shares: the first `UNITS % n` get one more. */
function splitUnits(n: number): number[] {
  const base = Math.floor(UNITS / n);
  const extra = UNITS - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
}

/** The touches of the window `[paidAt - 90 days, paidAt]`, one per campaign key (the latest), oldest key first. */
function windowTouches(touches: readonly Touch[], paidAt: Date): Touch[] {
  const from = paidAt.getTime() - ATTRIBUTION_WINDOW_DAYS * DAY_MS;
  const to = paidAt.getTime();
  const firstSeen = new Map<string, number>();
  const latest = new Map<string, Touch>();
  for (const t of touches) {
    const at = t.touchedAt.getTime();
    if (!t.campaignKey || at < from || at > to) continue;
    firstSeen.set(t.campaignKey, Math.min(firstSeen.get(t.campaignKey) ?? at, at));
    const prev = latest.get(t.campaignKey);
    if (!prev || prev.touchedAt.getTime() <= at) latest.set(t.campaignKey, t);
  }
  return [...latest.values()].sort((a, b) => firstSeen.get(a.campaignKey)! - firstSeen.get(b.campaignKey)! || a.campaignKey.localeCompare(b.campaignKey));
}

/**
 * Rule 72, linear model (pure): the distinct campaign keys of the touches in the 90 days before
 * `paidAt`, each with an equal weight; the weights are multiples of 0.0001 and sum to exactly 1.
 * An empty result means "no touch": the caller falls back to the first touch.
 */
export function linearWeights(touches: Touch[], paidAt: Date): { campaignKey: string; weight: number }[] {
  const keys = windowTouches(touches, paidAt);
  if (!keys.length) return [];
  const units = splitUnits(Math.min(keys.length, UNITS));
  return keys.slice(0, units.length).map((t, i) => ({ campaignKey: t.campaignKey, weight: units[i]! / UNITS }));
}

/** Splits `cents` by integer `units` (summing to 10,000); the remainder goes to the first shares. */
export function splitCents(cents: number, units: readonly number[]): number[] {
  const shares = units.map((u) => Math.floor((cents * u) / UNITS));
  let left = cents - shares.reduce((a, b) => a + b, 0);
  for (let i = 0; left > 0 && i < shares.length; i++, left--) shares[i]! += 1;
  return shares;
}

type OrderRow = {
  order_id: string;
  person_id: string;
  paid_at: string | Date;
  revenue_cents: number | string;
  source: string | null;
  medium: string | null;
  campaign: string | null;
  campaign_key: string;
};

type TouchRow = { person_id: string; touched_at: string | Date; campaign_key: string; source: string; medium: string | null; campaign: string };

type CreditInsert = typeof attributionCredits.$inferInsert;

const iso = (d: Date) => sql`${d.toISOString()}::timestamptz`;

/**
 * Rule 72: deletes the credits of orders paid at or after `fromPaidAt` (and before `toPaidAt`
 * when given) and rebuilds both models for those orders. Idempotent: a second run gives the same
 * rows apart from `computed_at`. Returns the number of rows written.
 */
export async function computeAttribution(tx: DbOrTx, opts: { fromPaidAt: Date; toPaidAt?: Date; now?: Date }): Promise<{ rows: number }> {
  const from = opts.fromPaidAt;
  const to = opts.toPaidAt;
  const computedAt = opts.now ?? new Date();
  const upper = to ? sql` and paid_at < ${iso(to)}` : sql``;
  await tx.execute(sql`delete from attribution_credits where paid_at >= ${iso(from)}${upper}`);

  const orders = rowsOf<OrderRow>(
    await tx.execute(sql`select o.id as order_id, o.person_id, o.paid_at,
        greatest(0, o.total_cents - coalesce((select sum(r.amount_cents) from refunds r where r.order_id = o.id and r.status = 'refunded'), 0))::int as revenue_cents,
        ft.source, ft.medium, ft.campaign, ft.campaign_key
      from orders o join v_person_first_touch ft on ft.person_id = o.person_id
      where o.status in ('paid', 'partially_refunded', 'refunded') and o.paid_at is not null
        and o.paid_at >= ${iso(from)}${to ? sql` and o.paid_at < ${iso(to)}` : sql``}
      order by o.paid_at, o.id`),
  );
  if (!orders.length) return { rows: 0 };

  const personIds = [...new Set(orders.map((o) => o.person_id))];
  const touchFrom = new Date(from.getTime() - ATTRIBUTION_WINDOW_DAYS * DAY_MS);
  const touchRows = rowsOf<TouchRow>(
    await tx.execute(sql`select person_id, touched_at, campaign_key, source, medium, campaign from v_marketing_touches
      where person_id in (select unnest(${`{${personIds.join(",")}}`}::uuid[])) and touched_at >= ${iso(touchFrom)}${to ? sql` and touched_at <= ${iso(to)}` : sql``}`),
  );
  const touchesOf = new Map<string, Touch[]>();
  for (const r of touchRows) {
    const list = touchesOf.get(r.person_id) ?? [];
    list.push({ campaignKey: r.campaign_key, touchedAt: new Date(r.touched_at), source: r.source, medium: r.medium, campaign: r.campaign });
    touchesOf.set(r.person_id, list);
  }

  const inserts: CreditInsert[] = [];
  for (const o of orders) {
    const paidAt = new Date(o.paid_at);
    const revenue = Number(o.revenue_cents);
    const base = { orderId: o.order_id, personId: o.person_id, paidAt, computedAt };
    const firstTouch = { campaignKey: o.campaign_key, source: o.source, medium: o.medium, campaign: o.campaign };
    inserts.push({ ...base, ...firstTouch, model: "first_touch", weight: "1.0000", revenueCents: revenue });

    const touches = windowTouches(touchesOf.get(o.person_id) ?? [], paidAt);
    if (!touches.length) {
      inserts.push({ ...base, ...firstTouch, model: "linear", weight: "1.0000", revenueCents: revenue });
      continue;
    }
    const units = splitUnits(touches.length);
    const cents = splitCents(revenue, units);
    touches.forEach((t, i) => {
      inserts.push({
        ...base,
        model: "linear",
        campaignKey: t.campaignKey,
        source: t.source ?? null,
        medium: t.medium ?? null,
        campaign: t.campaign ?? null,
        weight: (units[i]! / UNITS).toFixed(4),
        revenueCents: cents[i]!,
      });
    });
  }
  for (let i = 0; i < inserts.length; i += 500) await tx.insert(attributionCredits).values(inserts.slice(i, i + 500));
  return { rows: inserts.length };
}

// ---------------------------------------------------------------------------------------------
// The attribution report (rule 73, `/admin/reports/attribution`)
// ---------------------------------------------------------------------------------------------

export type AttributionModel = "first_touch" | "linear";

export type AttributionReportRow = {
  campaignKey: string;
  source: string | null;
  medium: string | null;
  campaign: string | null;
  /** The ad campaign name when the key joins `ad_spend_daily`. */
  adName: string | null;
  leads: number;
  firstPurchases: number;
  revenueFirstTouchCents: number;
  revenueLinearCents: number;
  ltvCents: number | null;
  spendCents: number;
  cplCents: number | null;
  cacCents: number | null;
  /** Linear revenue / spend; null without spend (edge case 19). */
  roas: number | null;
};

export type AttributionReport = { range: DateRange; model: AttributionModel; rows: AttributionReportRow[]; withoutSpend: AttributionReportRow[]; dataAsOf: string | null };

type ReportRaw = {
  campaign_key: string;
  source: string | null;
  medium: string | null;
  campaign: string | null;
  leads: number | string;
  first_purchases: number | string;
  rev_first: number | string;
  rev_linear: number | string;
  ltv: number | string | null;
};

/**
 * Rule 73 over `range`: per campaign key, leads (people first-touched by it and created in the
 * range), first purchases (their first purchase in the range), first-touch and linear revenue
 * (credits paid in the range), LTV (average `person_stats.revenue_cents` of everyone it
 * first-touched), spend, cost per lead, CAC and ROAS (linear revenue / spend). Rows are sorted
 * by the chosen model's revenue; keys with revenue or leads but no spend are also listed apart.
 */
export async function computeAttributionReport(db: DbOrTx, input: { range: DateRange; model?: AttributionModel }): Promise<AttributionReport> {
  const model = input.model ?? "linear";
  const raw = rowsOf<ReportRaw>(
    await db.execute(sql`with ft as (select * from v_person_first_touch where is_tester = false),
      firsts as (
        select ft.person_id, ft.campaign_key, ft.created_at,
          (select min(x.at) from (
              select o.paid_at as at from orders o where o.person_id = ft.person_id and o.status in ('paid', 'partially_refunded', 'refunded') and o.paid_at is not null
              union all select ih.occurred_at from imported_history ih where ih.person_id = ft.person_id and ih.kind = 'purchase') x) as first_purchase_at
        from ft),
      leads as (select campaign_key, count(*) filter (where ${inRange(sql`created_at`, input.range)}) as leads,
                       count(*) filter (where ${inRange(sql`first_purchase_at`, input.range)}) as first_purchases from firsts group by campaign_key),
      ltv as (select ft.campaign_key, avg(coalesce(ps.revenue_cents, 0)) as ltv from ft left join person_stats ps on ps.person_id = ft.person_id group by ft.campaign_key),
      credits as (select ac.campaign_key,
                         sum(ac.revenue_cents) filter (where ac.model = 'first_touch') as rev_first,
                         sum(ac.revenue_cents) filter (where ac.model = 'linear') as rev_linear,
                         max(ac.source) as source, max(ac.medium) as medium, max(ac.campaign) as campaign
                  from attribution_credits ac join persons pe on pe.id = ac.person_id
                  where pe.is_tester = false and ${inRange(sql`ac.paid_at`, input.range)} group by ac.campaign_key),
      names as (select campaign_key, max(source) as source, max(medium) as medium, max(campaign) as campaign from ft group by campaign_key)
      select k.campaign_key, coalesce(n.source, c.source) as source, coalesce(n.medium, c.medium) as medium, coalesce(n.campaign, c.campaign) as campaign,
        coalesce(l.leads, 0)::int as leads, coalesce(l.first_purchases, 0)::int as first_purchases,
        coalesce(c.rev_first, 0)::bigint as rev_first, coalesce(c.rev_linear, 0)::bigint as rev_linear, lt.ltv
      from (select campaign_key from leads where leads > 0 or first_purchases > 0 union select campaign_key from credits) k
      left join leads l on l.campaign_key = k.campaign_key left join credits c on c.campaign_key = k.campaign_key
      left join ltv lt on lt.campaign_key = k.campaign_key left join names n on n.campaign_key = k.campaign_key`),
  );
  const known = new Set(raw.map((r) => r.campaign_key));
  const spend = await spendByCampaignKey(db, input.range, known);
  const rows: AttributionReportRow[] = raw.map((r) => {
    const s = spend.get(r.campaign_key);
    spend.delete(r.campaign_key);
    return toRow(r, s);
  });
  for (const s of spend.values()) {
    const [source, campaign] = s.campaignKey.split("|");
    rows.push(toRow({ campaign_key: s.campaignKey, source: source ?? null, medium: null, campaign: campaign ?? null, leads: 0, first_purchases: 0, rev_first: 0, rev_linear: 0, ltv: null }, s));
  }
  const revenueOf = (r: AttributionReportRow) => (model === "linear" ? r.revenueLinearCents : r.revenueFirstTouchCents);
  rows.sort((a, b) => revenueOf(b) - revenueOf(a) || b.spendCents - a.spendCents || b.leads - a.leads || a.campaignKey.localeCompare(b.campaignKey));
  return { range: input.range, model, rows, withoutSpend: rows.filter((r) => r.spendCents === 0 && (r.revenueLinearCents > 0 || r.revenueFirstTouchCents > 0 || r.leads > 0)), dataAsOf: await adsDataAsOf(db) };
}

function toRow(r: ReportRaw, s: CampaignSpend | undefined): AttributionReportRow {
  const leads = Number(r.leads);
  const firstPurchases = Number(r.first_purchases);
  const revLinear = Number(r.rev_linear);
  const spendCents = s?.spendCents ?? 0;
  return {
    campaignKey: r.campaign_key,
    source: r.source,
    medium: r.medium,
    campaign: r.campaign,
    adName: s?.name ?? null,
    leads,
    firstPurchases,
    revenueFirstTouchCents: Number(r.rev_first),
    revenueLinearCents: revLinear,
    ltvCents: r.ltv === null ? null : Math.round(Number(r.ltv)),
    spendCents,
    cplCents: spendCents > 0 && leads > 0 ? Math.round(spendCents / leads) : null,
    cacCents: spendCents > 0 && firstPurchases > 0 ? Math.round(spendCents / firstPurchases) : null,
    roas: spendCents > 0 ? Math.round((revLinear / spendCents) * 100) / 100 : null,
  };
}

export const ATTRIBUTION_CSV_COLUMNS = [
  "campaign_key",
  "source",
  "medium",
  "campaign",
  "leads",
  "first_purchases",
  "revenue_first_touch_cents",
  "revenue_linear_cents",
  "ltv_cents",
  "spend_cents",
  "cpl_cents",
  "cac_cents",
  "roas",
] as const;

export function attributionCsvRowOf(r: AttributionReportRow): unknown[] {
  return [r.campaignKey, r.source ?? "", r.medium ?? "", r.campaign ?? "", r.leads, r.firstPurchases, r.revenueFirstTouchCents, r.revenueLinearCents, r.ltvCents ?? "", r.spendCents, r.cplCents ?? "", r.cacCents ?? "", r.roas ?? ""];
}
