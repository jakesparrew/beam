/**
 * The payment attention feed (commerce spec rules 33 to 35, 2.3 `v_payment_attention`, edge cases
 * 14 and 26; commerce-P6). Five kinds: `payment_failed` (7 days, unless the order was paid
 * later), `payment_pending_15m` (a provider payment open more than 15 minutes),
 * `bank_transfer_overdue`, `refund_failed` and `chargeback` (30 days). The view decides what is on
 * the feed; an item disappears as soon as its cause is gone (the payment settles, the refund is
 * retried, the transfer is paid or cancelled). `listPaymentAttention` is the api ops' action
 * dashboard reads; `getAttentionFeed` adds what `/admin/orders/attention` shows.
 */
import { orders, persons, vPaymentAttention } from "@beam/db/schema";
import type { PaymentAttentionItem } from "@beam/core/commerce";
import { asc, desc, eq, type DbOrTx } from "@/lib/ctx";

export const ATTENTION_KINDS = ["payment_failed", "payment_pending_15m", "bank_transfer_overdue", "refund_failed", "chargeback"] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

export type AttentionRow = PaymentAttentionItem & {
  kind: AttentionKind;
  paymentId: string;
  personName: string | null;
  personEmail: string | null;
  channel: string;
};

function clampLimit(limit: number): number {
  return Math.max(1, Math.min(500, Math.floor(limit) || 1));
}

/** The feed with order and person details, oldest problem first within each kind. */
export async function getAttentionFeed(db: DbOrTx, opts: { limit: number }): Promise<AttentionRow[]> {
  const rows = await db
    .select({
      kind: vPaymentAttention.kind,
      paymentId: vPaymentAttention.paymentId,
      orderId: vPaymentAttention.orderId,
      amountCents: vPaymentAttention.amountCents,
      since: vPaymentAttention.sinceAt,
      reference: orders.reference,
      status: orders.status,
      channel: orders.channel,
      personId: orders.personId,
      firstName: persons.firstName,
      lastName: persons.lastName,
      email: persons.email,
    })
    .from(vPaymentAttention)
    .innerJoin(orders, eq(orders.id, vPaymentAttention.orderId))
    .leftJoin(persons, eq(persons.id, orders.personId))
    .orderBy(asc(vPaymentAttention.kind), desc(vPaymentAttention.sinceAt))
    .limit(clampLimit(opts.limit));
  return rows.map((r) => ({
    kind: r.kind,
    paymentId: r.paymentId,
    orderId: r.orderId,
    reference: r.reference,
    personId: r.personId,
    status: r.status,
    reason: r.kind,
    amountCents: Number(r.amountCents),
    since: r.since ? new Date(r.since) : new Date(0),
    personName: r.personId ? [r.firstName, r.lastName].filter(Boolean).join(" ") || r.email : null,
    personEmail: r.email ?? null,
    channel: r.channel,
  }));
}

/** api `listPaymentAttention` (ops' action dashboard): `reason` is the feed kind. */
export async function listPaymentAttention(db: DbOrTx, opts: { limit: number }): Promise<PaymentAttentionItem[]> {
  const rows = await getAttentionFeed(db, opts);
  return rows.map(({ orderId, reference, personId, status, reason, amountCents, since }) => ({ orderId, reference, personId, status, reason, amountCents, since }));
}

/** The feed grouped by kind (the admin screen), every kind present. */
export function groupAttention(rows: readonly AttentionRow[]): Record<AttentionKind, AttentionRow[]> {
  const out = Object.fromEntries(ATTENTION_KINDS.map((k) => [k, [] as AttentionRow[]])) as Record<AttentionKind, AttentionRow[]>;
  for (const r of rows) (out[r.kind] ??= []).push(r);
  return out;
}
