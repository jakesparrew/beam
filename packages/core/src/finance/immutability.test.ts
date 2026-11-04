import { describe, expect, it } from "vitest";
import {
  assertMutableUpdate,
  INVOICE_CONDITIONAL_COLUMNS,
  INVOICE_MUTABLE_COLUMNS,
  INVOICE_SET_ONCE_COLUMNS,
  InvoiceImmutableError,
  INVOICES_GUARD_TRIGGER_SQL,
} from "./immutability";
import { buildSellerSnapshot } from "./seller";
import { FINANCE_SETTING_DEFAULT, type CompanySetting } from "./settings";
import { ANONYMISED_SNAPSHOT, buildCustomerSnapshot, reduceSnapshot } from "./snapshot";
import type { InvoiceRecord } from "./types";

const company: CompanySetting = {
  legal_name: "Vibrant Lifestyle Collective BV",
  trade_name: "BEAM Vitality Center",
  vat_number: "BE0123456749",
  enterprise_number: "0123.456.749",
  address: { street: "Teststraat 1", postal_code: "9000", city: "Gent", country: "BE" },
  support_email: "support@demo.beam.be",
  phone: "",
  website: "",
};

const snapshot = buildCustomerSnapshot({
  person: { id: "p-1", firstName: "An", lastName: "Peeters", email: "an@example.com", phone: "+32470000000", address: null },
});

function record(over: Partial<InvoiceRecord> = {}): InvoiceRecord {
  return {
    id: "inv-1",
    kind: "invoice",
    number: "BEAM-2026-000001",
    fiscalYear: 2026,
    sequenceNumber: 1,
    reversesInvoiceId: null,
    replacesInvoiceId: null,
    orderId: "order-1",
    paymentId: null,
    refundId: null,
    personId: "p-1",
    companyId: "c-1",
    isCompany: false,
    locale: "nl-BE",
    currency: "EUR",
    customerSnapshot: snapshot,
    sellerSnapshot: buildSellerSnapshot(company, FINANCE_SETTING_DEFAULT, "nl-BE"),
    lines: [],
    subtotalCents: 10_000,
    vatCents: 2_100,
    totalCents: 12_100,
    vatBreakdown: [],
    issuedOn: "2026-11-04",
    issuedAt: new Date("2026-11-04T10:00:00Z"),
    dueOn: "2026-11-18",
    status: "open",
    paidAt: null,
    settledVia: null,
    paymentProvider: null,
    paymentMethod: null,
    paymentTransactionRef: null,
    paymentReference: "+++260/0000/00170+++",
    reason: null,
    pdfFileId: null,
    pdfStatus: "pending",
    emailedAt: null,
    billitId: null,
    billitStatus: "pending",
    billitSyncedAt: null,
    billitAttempts: 0,
    billitLastError: null,
    billitFailedSince: null,
    billitPaymentStatus: "not_applicable",
    peppolStatus: "not_applicable",
    issuedBy: { kind: "system", id: null },
    createdAt: new Date("2026-11-04T10:00:00Z"),
    updatedAt: new Date("2026-11-04T10:00:00Z"),
    ...over,
  };
}

const refused = (fn: () => void) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(InvoiceImmutableError);
    expect((e as InvoiceImmutableError).code).toBe("conflict");
    return (e as InvoiceImmutableError).column;
  }
  throw new Error("expected the update to be refused");
};

describe("assertMutableUpdate: normal mode", () => {
  it("allows the always-mutable columns", () => {
    const now = new Date();
    expect(() =>
      assertMutableUpdate(
        {
          status: "paid",
          paidAt: now,
          settledVia: "billit",
          pdfFileId: "file-1",
          pdfStatus: "rendered",
          emailedAt: now,
          billitId: "B-1",
          billitStatus: "synced",
          billitSyncedAt: now,
          billitAttempts: 2,
          billitLastError: null,
          billitFailedSince: null,
          billitPaymentStatus: "pending",
          peppolStatus: "pending",
          updatedAt: now,
        },
        record(),
        "normal",
      ),
    ).not.toThrow();
  });

  it("accepts snake_case column names and ignores unchanged values", () => {
    expect(() => assertMutableUpdate({ billit_status: "failed", total_cents: 12_100, issued_at: "2026-11-04T10:00:00.000Z" }, record(), "normal")).not.toThrow();
    expect(refused(() => assertMutableUpdate({ total_cents: 1 }, record(), "normal"))).toBe("total_cents");
  });

  it("refuses frozen columns", () => {
    for (const patch of [
      { number: "BEAM-2026-000002" },
      { lines: [{ x: 1 }] },
      { totalCents: 1 },
      { issuedOn: "2026-11-05" },
      { dueOn: "2026-12-01" },
      { paymentReference: "+++x+++" },
      { reason: "changed" },
      { locale: "en" },
      { orderId: "order-2" },
    ]) {
      expect(refused(() => assertMutableUpdate(patch, record(), "normal"))).toBeDefined();
    }
  });

  it("refuses an invalid status transition", () => {
    expect(refused(() => assertMutableUpdate({ status: "issued" }, record(), "normal"))).toBe("status");
    expect(refused(() => assertMutableUpdate({ status: "open" }, record({ status: "paid", paidAt: new Date() }), "normal"))).toBe("status");
    expect(() => assertMutableUpdate({ status: "paid" }, record({ status: "paid" }), "normal")).not.toThrow();
  });

  it("payment columns only from null", () => {
    expect(() => assertMutableUpdate({ paymentId: "pay-1", paymentProvider: "bank_transfer", paymentMethod: "bank_transfer", paymentTransactionRef: "REF" }, record(), "normal")).not.toThrow();
    const settled = record({ paymentId: "pay-1", paymentProvider: "mollie", paymentMethod: "bancontact", paymentTransactionRef: "tr_1" });
    for (const column of ["paymentId", "paymentProvider", "paymentMethod", "paymentTransactionRef"]) {
      expect(refused(() => assertMutableUpdate({ [column]: "other" }, settled, "normal"))).toBeDefined();
      expect(refused(() => assertMutableUpdate({ [column]: null }, settled, "rewrite"))).toBeDefined();
    }
  });

  it("seller_snapshot only before the first render and before Billit", () => {
    const fresh = buildSellerSnapshot({ ...company, phone: "+3290000000" }, FINANCE_SETTING_DEFAULT, "nl-BE");
    expect(() => assertMutableUpdate({ sellerSnapshot: fresh }, record({ pdfStatus: "failed" }), "normal")).not.toThrow();
    expect(refused(() => assertMutableUpdate({ sellerSnapshot: fresh }, record({ pdfStatus: "rendered" }), "normal"))).toBe("seller_snapshot");
    expect(refused(() => assertMutableUpdate({ sellerSnapshot: fresh }, record({ billitId: "B-1" }), "normal"))).toBe("seller_snapshot");
  });

  it("refuses person, company and snapshot changes outside rewrite", () => {
    expect(refused(() => assertMutableUpdate({ personId: null }, record(), "normal"))).toBe("person_id");
    expect(refused(() => assertMutableUpdate({ companyId: null }, record(), "normal"))).toBe("company_id");
    expect(refused(() => assertMutableUpdate({ customerSnapshot: reduceSnapshot(snapshot) }, record(), "normal"))).toBe("customer_snapshot");
    expect(refused(() => assertMutableUpdate({ pdfFileId: null }, record({ pdfFileId: "file-1" }), "normal"))).toBe("pdf_file_id");
  });
});

describe("assertMutableUpdate: rewrite mode", () => {
  it("erasure: person_id to null and the reduced snapshot", () => {
    expect(() => assertMutableUpdate({ personId: null, customerSnapshot: reduceSnapshot(snapshot) }, record(), "rewrite")).not.toThrow();
    expect(refused(() => assertMutableUpdate({ personId: "p-2" }, record(), "rewrite"))).toBe("person_id");
    expect(refused(() => assertMutableUpdate({ customerSnapshot: { ...snapshot, name: "Someone else" } }, record(), "rewrite"))).toBe("customer_snapshot");
  });

  it("company_id, pdf_file_id and { anonymised: true } only for the retention sweep", () => {
    const sweep = { personId: null, companyId: null, customerSnapshot: ANONYMISED_SNAPSHOT, pdfFileId: null };
    expect(() => assertMutableUpdate(sweep, record({ pdfFileId: "file-1" }), "rewrite")).not.toThrow();
    // Erasure may not null the company link or delete the PDF.
    expect(refused(() => assertMutableUpdate({ companyId: null, customerSnapshot: reduceSnapshot(snapshot) }, record(), "rewrite"))).toBe("company_id");
    expect(refused(() => assertMutableUpdate({ pdfFileId: null, customerSnapshot: reduceSnapshot(snapshot) }, record({ pdfFileId: "file-1" }), "rewrite"))).toBe(
      "pdf_file_id",
    );
    expect(refused(() => assertMutableUpdate({ companyId: "c-2", customerSnapshot: ANONYMISED_SNAPSHOT }, record(), "rewrite"))).toBe("company_id");
    // An anonymised document stays anonymised and gets no new PDF.
    const anonymised = record({ personId: null, companyId: null, customerSnapshot: ANONYMISED_SNAPSHOT });
    expect(refused(() => assertMutableUpdate({ customerSnapshot: reduceSnapshot(snapshot) }, anonymised, "rewrite"))).toBe("customer_snapshot");
    expect(refused(() => assertMutableUpdate({ pdfFileId: "file-2" }, anonymised, "normal"))).toBe("pdf_file_id");
    expect(() => assertMutableUpdate({ companyId: null }, record({ customerSnapshot: ANONYMISED_SNAPSHOT }), "rewrite")).not.toThrow();
  });

  it("frozen columns stay frozen under rewrite", () => {
    expect(refused(() => assertMutableUpdate({ totalCents: 0 }, record(), "rewrite"))).toBe("total_cents");
    expect(refused(() => assertMutableUpdate({ number: "BEAM-2026-000009" }, record(), "rewrite"))).toBe("number");
    expect(refused(() => assertMutableUpdate({ status: "issued" }, record(), "rewrite"))).toBe("status");
  });
});

describe("INVOICES_GUARD_TRIGGER_SQL", () => {
  it("is a create-or-replace function with update/delete and truncate triggers", () => {
    expect(INVOICES_GUARD_TRIGGER_SQL).toMatch(/create or replace function invoices_guard_immutable\(\)/);
    expect(INVOICES_GUARD_TRIGGER_SQL).toMatch(/before update or delete on invoices/);
    expect(INVOICES_GUARD_TRIGGER_SQL).toMatch(/before truncate on invoices/);
    expect(INVOICES_GUARD_TRIGGER_SQL).toMatch(/beam\.allow_rewrite/);
  });

  it("skips exactly the columns the code guard treats as mutable or conditional", () => {
    for (const c of [...INVOICE_MUTABLE_COLUMNS, ...INVOICE_SET_ONCE_COLUMNS, ...INVOICE_CONDITIONAL_COLUMNS]) expect(INVOICES_GUARD_TRIGGER_SQL).toContain(`'${c}'`);
    for (const c of ["total_cents", "number", "lines", "issued_on"]) expect(INVOICES_GUARD_TRIGGER_SQL).not.toContain(`'${c}'`);
  });
});
