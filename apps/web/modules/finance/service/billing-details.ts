/**
 * Billing identity of an order (finance section 2.4, rule 17): chosen in commerce's checkout
 * "company invoice" box, at the POS counter or by staff before payment, read once when the
 * invoice is issued. One row per order, upserted. Values pass `BillingDetailsInput` again here
 * (the VAT number is stored normalised, the Peppol id derived from a Belgian VAT number).
 */
import type { DbOrTx, Tx } from "@beam/db";
import { orderBillingDetails, orders } from "@beam/db/schema";
import { BillingDetailsInput, billingPeppolId, type BillingDetails } from "@beam/core/finance";
import { eq, NotFoundError, sql, ValidationError, type Ctx } from "@/lib/ctx";
import { assertCustomerOwns } from "./invoice-state";

/** Upserts the billing details of `orderId`. Customers may only set them on their own orders. */
export async function setOrderBillingDetails(tx: Tx, ctx: Ctx, input: { orderId: string; details: BillingDetails }): Promise<void> {
  const parsed = BillingDetailsInput.safeParse(input.details);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) fields[issue.path.join(".") || "details"] = issue.message;
    throw new ValidationError("finance.errors.billing_invalid", fields);
  }
  const details = parsed.data;
  const [order] = await tx.select({ id: orders.id, personId: orders.personId }).from(orders).where(eq(orders.id, input.orderId));
  if (!order) throw new NotFoundError("finance.errors.order_not_found");
  assertCustomerOwns(ctx, order.personId);

  const values = {
    isCompany: details.isCompany,
    legalName: details.legalName,
    vatNumber: details.vatNumber ?? null,
    address: details.address,
    billingEmail: details.billingEmail ?? null,
    purchaseOrderRef: details.purchaseOrderRef ?? null,
    peppolId: billingPeppolId(details),
  };
  await tx
    .insert(orderBillingDetails)
    .values({ orderId: input.orderId, ...values })
    .onConflictDoUpdate({ target: orderBillingDetails.orderId, set: { ...values, updatedAt: sql`now()` } });
}

/** The billing details of an order, as `BillingDetails`, or `null`. */
export async function getOrderBillingDetails(db: DbOrTx, orderId: string): Promise<BillingDetails | null> {
  const [row] = await db.select().from(orderBillingDetails).where(eq(orderBillingDetails.orderId, orderId));
  if (!row) return null;
  return {
    isCompany: row.isCompany,
    legalName: row.legalName,
    ...(row.vatNumber ? { vatNumber: row.vatNumber } : {}),
    address: row.address,
    ...(row.billingEmail ? { billingEmail: row.billingEmail } : {}),
    ...(row.purchaseOrderRef ? { purchaseOrderRef: row.purchaseOrderRef } : {}),
    ...(row.peppolId ? { peppolId: row.peppolId } : {}),
  };
}
