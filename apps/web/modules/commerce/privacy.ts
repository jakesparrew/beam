/**
 * commerce's GDPR registration (commerce spec section 9, architecture section 11, ops rule 62).
 * Facade read by `pnpm gen:indexes`; ops runs export, erase and the retention sweeps.
 * commerce-P4b implements `export`, `erase`, `sweep` and `retention`.
 *
 * - `export`: `commerce/orders.json` (with lines and refunds), `commerce/payments.csv`,
 *   `commerce/vouchers.json`, `commerce/checkouts.json`, `commerce/mandates.json`,
 *   `commerce/person_prices.json`.
 * - `erase` (runs under `SET LOCAL beam.allow_rewrite = 'on'`, after credits and before finance):
 *   refused with `RetryableError('live_payment')` while an order has a live provider payment (it
 *   expires within 30 minutes); open drafts and unpaid orders (open bank transfers included) are
 *   cancelled first through `cancelOrder`; orders are `retained_legal` (person and note removed,
 *   `is_erased_subject`), payments keep a reduced `raw`, mandates are anonymised and `revoked`,
 *   provider customers, checkouts and person prices are deleted, redemptions and vouchers lose
 *   their person links. One `commerce.erase_provider_customer` job per provider customer revokes
 *   what is left at the provider and deletes the customer. Order lines and refunds hold no person
 *   data and stay unchanged.
 */
import type { Tx } from "@beam/db";
import {
  checkouts,
  mandates,
  orderLines,
  orders,
  payments,
  personPrices,
  products,
  promotionRedemptions,
  providerCustomers,
  refunds,
  vouchers,
} from "@beam/db/schema";
import { RetryableError } from "@beam/core/errors";
import type { EraseReportRow, PrivacyRegistration, RetentionPolicySeed } from "@beam/core/privacy";
import { and, asc, createCtx, eq, inArray, notInArray, or, sql, type DbOrTx } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { cancelOrder } from "./api";

const BATCH = 5000;
const allowRewrite = (tx: DbOrTx) => tx.execute(sql`set local beam.allow_rewrite = 'on'`);
const count = async (tx: DbOrTx, q: ReturnType<typeof sql>) => rowsOf(await tx.execute(q)).length;

/** The reduced provider payload kept for accounting (section 9: `{id, status, method, amount}`). */
const REDUCED_RAW = sql`jsonb_build_object('id', ${payments.id}, 'status', ${payments.status}, 'method', ${payments.method}, 'amount', ${payments.amountCents})`;
/** True when `raw` holds more than the reduced keys. */
const RAW_NOT_REDUCED = sql`${payments.raw} is not null and (${payments.raw} - 'id' - 'status' - 'method' - 'amount') <> '{}'::jsonb`;

export const retention: readonly RetentionPolicySeed[] = [
  { key: "commerce.checkouts", tableName: "checkouts", days: 395, action: "delete", description: "Checkouts after 13 months (a year of recovery comparisons)." },
  { key: "commerce.payments_raw", tableName: "payments", days: 90, action: "anonymise", description: "Provider payloads reduced to id, status, method and amount after 90 days." },
  {
    key: "commerce.orders",
    tableName: "orders",
    days: 3653,
    action: "anonymise",
    description: "Orders lose their person 10 years after 1 January following the fiscal year of payment (accounting law).",
  },
  { key: "commerce.person_prices", tableName: "person_prices", days: 730, action: "delete", description: "Person prices two years after they ended or were revoked." },
];

export const sweep: Record<string, (tx: Tx, cutoff: Date) => Promise<number>> = {
  "commerce.checkouts": async (tx, cutoff) => {
    const due = (await tx.select({ id: checkouts.id }).from(checkouts).where(sql`${checkouts.createdAt} < ${cutoff}`).limit(BATCH)).map((r) => r.id);
    if (!due.length) return 0;
    await tx.update(orders).set({ checkoutId: null }).where(inArray(orders.checkoutId, due));
    return (await tx.delete(checkouts).where(inArray(checkouts.id, due)).returning({ id: checkouts.id })).length;
  },
  "commerce.payments_raw": (tx, cutoff) =>
    count(
      tx,
      sql`update payments set raw = jsonb_build_object('id', id, 'status', status, 'method', method, 'amount', amount_cents), updated_at = now()
          where id in (select id from payments where created_at < ${cutoff} and raw is not null
                       and (raw - 'id' - 'status' - 'method' - 'amount') <> '{}'::jsonb limit ${BATCH})
          returning id`,
    ),
  "commerce.orders": (tx, cutoff) =>
    count(
      tx,
      sql`update orders set person_id = null, note = null, is_erased_subject = true, updated_at = now()
          where id in (select id from orders where person_id is not null
                       and date_trunc('year', coalesce(paid_at, created_at) at time zone 'Europe/Brussels') + interval '1 year' < (${cutoff}::timestamptz at time zone 'Europe/Brussels')
                       limit ${BATCH})
          returning id`,
    ),
  "commerce.person_prices": (tx, cutoff) =>
    count(
      tx,
      sql`delete from person_prices where id in (select id from person_prices
          where coalesce(revoked_at, valid_to_at) is not null and coalesce(revoked_at, valid_to_at) < ${cutoff} limit ${BATCH}) returning id`,
    ),
};

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function exportPerson(tx: Tx, personId: string): Promise<Record<string, unknown>> {
  const orderRows = await tx.select().from(orders).where(eq(orders.personId, personId)).orderBy(asc(orders.createdAt));
  const orderIds = orderRows.map((o) => o.id);
  const lineRows = orderIds.length ? await tx.select().from(orderLines).where(inArray(orderLines.orderId, orderIds)).orderBy(asc(orderLines.lineNo)) : [];
  const refundRows = orderIds.length ? await tx.select().from(refunds).where(inArray(refunds.orderId, orderIds)).orderBy(asc(refunds.createdAt)) : [];
  const paymentRows = orderIds.length ? await tx.select().from(payments).where(inArray(payments.orderId, orderIds)).orderBy(asc(payments.createdAt)) : [];
  const referenceOf = new Map(orderRows.map((o) => [o.id, o.reference]));

  const ordersJson = orderRows.map((o) => ({
    reference: o.reference,
    created_at: iso(o.createdAt),
    paid_at: iso(o.paidAt),
    cancelled_at: iso(o.cancelledAt),
    channel: o.channel,
    status: o.status,
    locale: o.locale,
    subtotal_cents: o.subtotalCents,
    discount_cents: o.discountCents,
    vat_cents: o.vatCents,
    total_cents: o.totalCents,
    note: o.note,
    lines: lineRows
      .filter((l) => l.orderId === o.id)
      .map((l) => ({
        description: l.description,
        product_kind: l.productKind,
        quantity: l.quantity,
        unit_amount_cents: l.unitAmountCents,
        discount_cents: l.discountCents,
        discount_reason: l.discountCents > 0 ? ((l.pricingTrace as { winner?: string } | null)?.winner ?? null) : null,
        line_total_cents: l.lineTotalCents,
        vat_rate_pct: Number(l.vatRatePct),
        vat_cents: l.vatCents,
      })),
    refunds: refundRows
      .filter((r) => r.orderId === o.id)
      .map((r) => ({ amount_cents: r.amountCents, reason: r.reason, status: r.status, created_at: iso(r.createdAt) })),
  }));

  const header = ["order_reference", "provider", "method", "amount_cents", "refunded_cents", "status", "created_at", "paid_at"];
  const csv = [
    header.join(","),
    ...paymentRows.map((p) =>
      [referenceOf.get(p.orderId), p.provider, p.method, p.amountCents, p.refundedCents, p.status, iso(p.createdAt), iso(p.paidAt)].map(csvCell).join(","),
    ),
  ].join("\n");

  const voucherRows = await tx
    .select()
    .from(vouchers)
    .where(or(eq(vouchers.purchaserPersonId, personId), eq(vouchers.redeemedByPersonId, personId)))
    .orderBy(asc(vouchers.createdAt));
  const vouchersJson = {
    bought: voucherRows
      .filter((v) => v.purchaserPersonId === personId)
      .map((v) => ({
        code_last4: v.codeLast4,
        amount_cents: v.amountCents,
        status: v.status,
        recipient_name: v.recipientName,
        recipient_email: v.recipientEmail,
        message: v.message,
        deliver_on: v.deliverOn,
        expires_at: iso(v.expiresAt),
      })),
    redeemed: voucherRows
      .filter((v) => v.redeemedByPersonId === personId)
      .map((v) => ({ code_last4: v.codeLast4, amount_cents: v.amountCents, redeemed_at: iso(v.redeemedAt) })),
  };

  const checkoutRows = await tx.select().from(checkouts).where(eq(checkouts.personId, personId)).orderBy(asc(checkouts.createdAt));
  const mandateRows = await tx.select().from(mandates).where(eq(mandates.personId, personId)).orderBy(asc(mandates.createdAt));
  const priceRows = await tx
    .select({ pp: personPrices, sku: products.sku, name: products.name })
    .from(personPrices)
    .innerJoin(products, eq(products.id, personPrices.productId))
    .where(eq(personPrices.personId, personId))
    .orderBy(asc(personPrices.createdAt));

  return {
    "commerce/orders.json": ordersJson,
    "commerce/payments.csv": csv,
    "commerce/vouchers.json": vouchersJson,
    "commerce/checkouts.json": checkoutRows.map((c) => ({
      channel: c.channel,
      status: c.status,
      items: c.items,
      email: c.email,
      created_at: iso(c.createdAt),
      abandoned_at: iso(c.abandonedAt),
      completed_at: iso(c.completedAt),
    })),
    "commerce/mandates.json": mandateRows.map((m) => ({ method: m.method, summary: m.detailsSummary, status: m.status, created_at: iso(m.createdAt), revoked_at: iso(m.revokedAt) })),
    "commerce/person_prices.json": priceRows.map(({ pp, sku, name }) => ({
      product_sku: sku,
      product_name: name,
      amount_cents: pp.amountCents,
      valid_from_at: iso(pp.validFromAt),
      valid_to_at: iso(pp.validToAt),
      revoked_at: iso(pp.revokedAt),
      reason: pp.reason,
    })),
  };
}

async function erasePerson(tx: Tx, personId: string): Promise<EraseReportRow[]> {
  const [live] = await tx
    .select({ id: payments.id })
    .from(payments)
    .innerJoin(orders, eq(orders.id, payments.orderId))
    .where(
      and(
        eq(orders.personId, personId),
        eq(orders.status, "pending_payment"),
        inArray(payments.status, ["open", "pending", "authorized"]),
        notInArray(payments.provider, ["cash", "bank_transfer", "credit_balance"]),
      ),
    )
    .limit(1);
  if (live) throw new RetryableError("live_payment");

  await allowRewrite(tx);
  const ctx = createCtx({ tx, actor: { kind: "system", jobId: "" }, requestId: `privacy:erase:commerce` });

  // Drafts and unpaid orders (open bank transfers included) are cancelled with their releases.
  const open = await tx
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.personId, personId), inArray(orders.status, ["draft", "pending_payment"])));
  for (const o of open) await cancelOrder(tx, ctx, { orderId: o.id, reason: "privacy_erasure" });

  // Provider customers: one job per customer revokes what is left there and deletes it.
  const customerRows = await tx.select().from(providerCustomers).where(eq(providerCustomers.personId, personId));
  const mandateRows = await tx.select().from(mandates).where(eq(mandates.personId, personId));
  const customers = new Map<string, Set<string>>();
  for (const c of customerRows) customers.set(c.providerCustomerId, new Set());
  for (const m of mandateRows) {
    const set = customers.get(m.providerCustomerId) ?? new Set<string>();
    if (m.status === "valid" || m.status === "revoked" || m.status === "pending") set.add(m.providerMandateId);
    customers.set(m.providerCustomerId, set);
  }
  for (const [providerCustomerId, ids] of customers) {
    await ctx.enqueue({
      kind: "commerce.erase_provider_customer",
      payload: { providerCustomerId, mandateIds: [...ids].sort() },
      key: `mollie_customer:${providerCustomerId}:delete`,
    });
  }

  const orderIds = (await tx.select({ id: orders.id }).from(orders).where(eq(orders.personId, personId))).map((o) => o.id);
  const scrubbed = orderIds.length
    ? await tx
        .update(payments)
        .set({ raw: REDUCED_RAW, updatedAt: sql`now()` })
        .where(and(inArray(payments.orderId, orderIds), RAW_NOT_REDUCED))
        .returning({ id: payments.id })
    : [];
  const anonymisedOrders = await tx
    .update(orders)
    .set({ personId: null, note: null, isErasedSubject: true, updatedAt: sql`now()` })
    .where(eq(orders.personId, personId))
    .returning({ id: orders.id });
  const anonymisedMandates = await tx
    .update(mandates)
    .set({ personId: null, detailsSummary: null, status: "revoked", revokedAt: sql`coalesce(${mandates.revokedAt}, now())`, updatedAt: sql`now()` })
    .where(eq(mandates.personId, personId))
    .returning({ id: mandates.id });
  const deletedCustomers = await tx.delete(providerCustomers).where(eq(providerCustomers.personId, personId)).returning({ id: providerCustomers.id });

  const checkoutIds = (await tx.select({ id: checkouts.id }).from(checkouts).where(eq(checkouts.personId, personId))).map((c) => c.id);
  if (checkoutIds.length) await tx.update(orders).set({ checkoutId: null }).where(inArray(orders.checkoutId, checkoutIds));
  const deletedCheckouts = checkoutIds.length ? await tx.delete(checkouts).where(inArray(checkouts.id, checkoutIds)).returning({ id: checkouts.id }) : [];
  const deletedPrices = await tx.delete(personPrices).where(eq(personPrices.personId, personId)).returning({ id: personPrices.id });
  const redemptions = await tx
    .update(promotionRedemptions)
    .set({ personId: null, updatedAt: sql`now()` })
    .where(eq(promotionRedemptions.personId, personId))
    .returning({ id: promotionRedemptions.id });
  const bought = await tx
    .update(vouchers)
    .set({ purchaserPersonId: null, recipientName: null, recipientEmail: null, message: null, updatedAt: sql`now()` })
    .where(eq(vouchers.purchaserPersonId, personId))
    .returning({ id: vouchers.id });
  const redeemed = await tx
    .update(vouchers)
    .set({ redeemedByPersonId: null, updatedAt: sql`now()` })
    .where(eq(vouchers.redeemedByPersonId, personId))
    .returning({ id: vouchers.id });

  return [
    { table: "orders", rows: anonymisedOrders.length, action: "retained_legal" },
    { table: "order_lines", rows: 0, action: "retained_legal" },
    { table: "payments", rows: scrubbed.length, action: "retained_legal" },
    { table: "refunds", rows: 0, action: "retained_legal" },
    { table: "mandates", rows: anonymisedMandates.length, action: "anonymised" },
    { table: "provider_customers", rows: deletedCustomers.length, action: "deleted" },
    { table: "checkouts", rows: deletedCheckouts.length, action: "deleted" },
    { table: "person_prices", rows: deletedPrices.length, action: "deleted" },
    { table: "promotion_redemptions", rows: redemptions.length, action: "anonymised" },
    { table: "vouchers", rows: new Set([...bought, ...redeemed].map((v) => v.id)).size, action: "anonymised" },
  ];
}

export const privacy: PrivacyRegistration<Tx> = {
  tables: [
    "orders",
    "order_lines",
    "payments",
    "refunds",
    "person_prices",
    "promotion_redemptions",
    "checkouts",
    "mandates",
    "provider_customers",
    "vouchers",
  ],
  export: (tx, personId) => exportPerson(tx, personId),
  erase: (tx, personId) => erasePerson(tx, personId),
  sweep,
  retention,
};

/** The spec's name for the registration (section 9). */
export const commercePrivacy = privacy;

/** Commerce tables without person data (listed in platform's `NO_PII_TABLES`). */
export const noPiiTables = ["pos_day_closes"];
