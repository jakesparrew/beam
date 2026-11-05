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
