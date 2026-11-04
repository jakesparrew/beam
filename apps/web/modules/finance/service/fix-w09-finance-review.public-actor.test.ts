/**
 * fix-w09-finance-review finding 1: commerce runs guest checkout with a `{ kind: "public" }`
 * actor, so `setOrderBillingDetails` and `issueInvoice` (zero and positive totals) accept it.
 * A customer actor still only reaches their own orders.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { orderBillingDetails } from "@beam/db/schema";
import { eq, type Actor } from "@/lib/ctx";
import { issueInvoice, setOrderBillingDetails } from "../api";
import { asTx, ctxAt, invoiceRow, makePerson, paidOrder, payment, setupDb } from "./__tests__/fixtures";

vi.mock("@/registry/jobs.generated", async (importOriginal) => {
  const { withFinanceJobStubs } = await import("./__tests__/fixtures");
  return withFinanceJobStubs(await importOriginal<{ JOB_BY_KIND: Record<string, unknown> }>());
});

let h: DbHandle;
beforeAll(async () => {
  h = await setupDb();
});
afterAll(() => h.close());

const PUBLIC: Actor = { kind: "public" };
const company = {
  isCompany: true,
  legalName: "Acme Wellness BV",
  vatNumber: "BE0123456749",
  address: { line1: "Kerkstraat 1", postal_code: "9000", city: "Gent", country: "BE" },
  billingEmail: "billing@example.com",
};

describe("finance facades with a public (guest checkout) actor", () => {
  it("setOrderBillingDetails stores the company details of a guest order", async () => {
    const { order } = await paidOrder(h.db);
    await setOrderBillingDetails(asTx(h.db), ctxAt(h.db, undefined, PUBLIC), { orderId: order.id, details: company });
    const [row] = await h.db.select().from(orderBillingDetails).where(eq(orderBillingDetails.orderId, order.id));
    expect(row).toMatchObject({ isCompany: true, legalName: "Acme Wellness BV", vatNumber: "BE0123456749" });
  });

  it("issueInvoice skips a guest's zero-total order instead of throwing not_found", async () => {
    const { order } = await paidOrder(h.db, [{ unitAmountCents: 0 }]);
    await expect(issueInvoice(asTx(h.db), ctxAt(h.db, undefined, PUBLIC), { orderId: order.id })).resolves.toEqual({
      status: "skipped",
      reason: "zero_total",
    });
  });

  it("issueInvoice issues a guest's paid order with company billing details", async () => {
    const { order } = await paidOrder(h.db);
    const pay = await payment(h.db, order.id, { amountCents: order.totalCents });
    const ctx = ctxAt(h.db, undefined, PUBLIC);
    await setOrderBillingDetails(asTx(h.db), ctx, { orderId: order.id, details: company });
    const result = await issueInvoice(asTx(h.db), ctx, { orderId: order.id, paymentId: pay.id });
    if (result.status !== "issued") throw new Error(`not issued: ${result.status}`);
    expect(await invoiceRow(h.db, result.invoiceId)).toMatchObject({ isCompany: true, totalCents: order.totalCents });
  });

  it("still answers not_found to a customer actor on someone else's order", async () => {
    const { order } = await paidOrder(h.db);
    const other = await makePerson(h.db);
    const customer: Actor = { kind: "customer", userId: "00000000-0000-4000-8000-000000000000", personId: other.id };
    await expect(
      setOrderBillingDetails(asTx(h.db), ctxAt(h.db, undefined, customer), { orderId: order.id, details: company }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
