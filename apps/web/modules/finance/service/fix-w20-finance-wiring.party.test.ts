/**
 * fix-w20-finance-wiring (request of finance-P2): `chk_invoices_party` accepts a POS company
 * invoice whose buyer exists only as billing details (snapshot kind `company` with a VAT number,
 * `person_id` and `company_id` null; its Billit party is `vat:<number>`). A company snapshot
 * without a VAT number and without a person or CRM company is still refused.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { invoices } from "@beam/db/schema";
import type { BillingDetails, FullCustomerSnapshot } from "@beam/core/finance";
import { issueInvoice, setOrderBillingDetails } from "../api";
import { asTx, ctxAt, invoiceRow, makeOrder, makeOrderLine, setupDb } from "./__tests__/fixtures";

vi.mock("@/registry/jobs.generated", async (importOriginal) => {
  const { withFinanceJobStubs } = await import("./__tests__/fixtures");
  return withFinanceJobStubs(await importOriginal<{ JOB_BY_KIND: Record<string, unknown> }>());
});

let h: DbHandle;
beforeAll(async () => {
  h = await setupDb();
});
afterAll(() => h.close());

const COMPANY: BillingDetails = {
  isCompany: true,
  legalName: "Walk-in Wellness BV",
  vatNumber: "BE0123456749",
  address: { line1: "Kerkstraat 1", postal_code: "9000", city: "Gent", country: "BE" },
  billingEmail: "billing@example.com",
};

async function posOrderWithCompanyBilling() {
  const order = await makeOrder(h.db, { channel: "pos", status: "paid", subtotalCents: 4_500, totalCents: 4_500 });
  expect(order.personId).toBeNull();
  expect(order.companyId).toBeNull();
  await makeOrderLine(h.db, { orderId: order.id });
  await setOrderBillingDetails(asTx(h.db), ctxAt(h.db), { orderId: order.id, details: COMPANY });
  return order;
}

async function pgError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (error) {
    const e = error as { message?: string; cause?: { message?: string; constraint?: string } };
    return [e.message, e.cause?.message, e.cause?.constraint].filter(Boolean).join(" ");
  }
  return "no error";
}

describe("chk_invoices_party: POS company invoices", () => {
  it("issues a company invoice for a POS order with billing details and no person or CRM company", async () => {
    const order = await posOrderWithCompanyBilling();
    const result = await issueInvoice(asTx(h.db), ctxAt(h.db), { orderId: order.id });
    expect(result).toMatchObject({ status: "issued" });
    if (result.status !== "issued") throw new Error("not issued");
    const inv = await invoiceRow(h.db, result.invoiceId);
    expect(inv).toMatchObject({ personId: null, companyId: null, isCompany: true });
    expect(inv.customerSnapshot).toMatchObject({ kind: "company", name: COMPANY.legalName, vat_number: "BE0123456749", person_id: null, company_id: null });
  });

  it("still refuses a company snapshot without a VAT number and without a party", async () => {
    const order = await posOrderWithCompanyBilling();
    const issued = await issueInvoice(asTx(h.db), ctxAt(h.db), { orderId: order.id });
    if (issued.status !== "issued") throw new Error("not issued");
    const { id: _id, createdAt: _c, ...row } = await invoiceRow(h.db, issued.invoiceId);
    const other = await makeOrder(h.db, { channel: "pos", status: "paid", subtotalCents: 4_500, totalCents: 4_500 });
    const snapshot = { ...(row.customerSnapshot as FullCustomerSnapshot), vat_number: null };
    const insert = (customerSnapshot: FullCustomerSnapshot, n: number) =>
      h.db.insert(invoices).values({
        ...(row as typeof invoices.$inferInsert),
        orderId: other.id,
        sequenceNumber: n,
        number: `BEAM-${row.fiscalYear}-${String(n).padStart(6, "0")}`,
        customerSnapshot,
        pdfFileId: null,
        billitId: null,
      });
    expect(await pgError(insert(snapshot, 900_001))).toMatch(/chk_invoices_party/);
    expect(await pgError(insert({ ...snapshot, vat_number: " " } as FullCustomerSnapshot, 900_002))).toMatch(/chk_invoices_party/);
  });
});
