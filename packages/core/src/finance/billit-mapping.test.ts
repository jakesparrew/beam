import { describe, expect, it } from "vitest";
import {
  BILLIT_PAYMENT_METHOD,
  BILLIT_PAYMENT_METHOD_CODES,
  billitOrderTotalCents,
  billitPartyKey,
  billitPaymentMethod,
  paymentSplitComment,
  toBillitOrder,
  toBillitParty,
  toBillitPayment,
  unitPriceExcl,
} from "./billit-mapping";
import { reduceSnapshot } from "./snapshot";
import type { FullCustomerSnapshot, InvoiceLine, InvoiceRecord, VatRatePct } from "./types";
import { buildVatBreakdown, computeLineVat, documentTotals } from "./vat";

function line(gross: number, rate: VatRatePct, quantity = 1, extra: Partial<InvoiceLine> = {}): InvoiceLine {
  const { vatCents, netCents } = computeLineVat(gross, rate);
  return {
    order_line_id: "00000000-0000-4000-8000-000000000001",
    product_id: "00000000-0000-4000-8000-000000000002",
    sku: "SKU",
    category: "item",
    description: "Item",
    description_i18n: { "nl-BE": "Item", "fr-BE": "Article", en: "Item" },
    quantity,
    unit_amount_cents: Math.round(gross / (quantity || 1)),
    discount_cents: 0,
    discount_label: null,
    line_total_cents: gross,
    vat_rate_pct: rate,
    vat_cents: vatCents,
    net_cents: netCents,
    vat_note: rate === 0 ? "VAT due on redemption" : null,
    credit_kind: null,
    credit_units: null,
    session_starts_at: null,
    ...extra,
  };
}

const SNAPSHOT: FullCustomerSnapshot = {
  kind: "person",
  name: "Lotte Peeters",
  email: "lotte@example.com",
  phone: "+32 470 00 00 00",
  address: { line1: "Kerkstraat 1", line2: "bus 2", postal_code: "9000", city: "Gent", country: "BE" },
  vat_number: null,
  peppol_id: null,
  purchase_order_ref: null,
  person_id: "00000000-0000-4000-8000-0000000000aa",
  company_id: null,
  is_reduced: false,
};

function doc(lines: InvoiceLine[], over: Partial<InvoiceRecord> = {}): InvoiceRecord {
  const totals = documentTotals(lines);
  return {
    id: "00000000-0000-4000-8000-0000000000d1",
    kind: "invoice",
    number: "BEAM-2026-000007",
    fiscalYear: 2026,
    sequenceNumber: 7,
    reversesInvoiceId: null,
    replacesInvoiceId: null,
    orderId: "00000000-0000-4000-8000-0000000000o1",
    paymentId: null,
    refundId: null,
    personId: SNAPSHOT.person_id,
    companyId: null,
    isCompany: false,
    locale: "nl-BE",
    currency: "EUR",
    customerSnapshot: SNAPSHOT,
    sellerSnapshot: {} as InvoiceRecord["sellerSnapshot"],
    lines,
    ...totals,
    vatBreakdown: buildVatBreakdown(lines),
    issuedOn: "2026-11-04",
    issuedAt: new Date("2026-11-04T10:00:00Z"),
    dueOn: null,
    status: "paid",
    paidAt: new Date("2026-11-04T10:00:00Z"),
    settledVia: "provider",
    paymentProvider: "mollie",
    paymentMethod: "bancontact",
    paymentTransactionRef: "tr_abc",
    paymentReference: null,
    reason: null,
    pdfFileId: null,
    pdfStatus: "rendered",
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

/** Deterministic PRNG for the random baskets. */
function prng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

describe("toBillitOrder totals", () => {
  it("equal our total to the cent for 300 random mixed-rate baskets", () => {
    const rand = prng(20261104);
    const rates: VatRatePct[] = [0, 6, 12, 21];
    for (let n = 0; n < 300; n++) {
      const lines = Array.from({ length: 1 + Math.floor(rand() * 6) }, () => {
        const q = 1 + Math.floor(rand() * 10);
        return line(q * (100 + Math.floor(rand() * 20_000)) - Math.floor(rand() * 90), rates[Math.floor(rand() * 4)]!, q);
      });
      const d = doc(lines);
      const order = toBillitOrder(d, "p1");
      expect(billitOrderTotalCents(order.OrderLines)).toBe(d.totalCents);
      expect(order.OrderLines.map((l) => l.VATPercentage)).toEqual(lines.map((l) => l.vat_rate_pct));
    }
  });

  it("sends the unit price excluding VAT with at most 4 decimals", () => {
    expect(unitPriceExcl(1000, 1, 21)).toBe(8.2645);
    expect(unitPriceExcl(4500, 3, 6)).toBe(14.1509);
    const order = toBillitOrder(doc([line(1000, 21), line(4500, 6, 3)]), "p1");
    for (const l of order.OrderLines) expect(Math.round(l.UnitPriceExcl * 10_000)).toBeCloseTo(l.UnitPriceExcl * 10_000, 6);
    expect(order.OrderLines[1]).toMatchObject({ Quantity: 3, UnitPriceExcl: 14.1509, VATPercentage: 6 });
  });

  it("maps header fields, the structured communication and the PDF attachment", () => {
    const open = doc([line(12_100, 21)], { status: "open", paidAt: null, dueOn: "2026-11-18", paymentReference: "+++260/0000/12395+++", paymentMethod: null });
    const order = toBillitOrder(open, "p9", new Uint8Array([37, 80, 68, 70]));
    expect(order).toMatchObject({
      OrderType: "Invoice",
      OrderDirection: "Income",
      OrderNumber: "BEAM-2026-000007",
      Reference: "BEAM-2026-000007",
      OrderDate: "2026-11-04",
      ExpiryDate: "2026-11-18",
      Customer: { PartyID: "p9" },
      PaymentReference: "+++260/0000/12395+++",
      Attachments: [{ FileName: "BEAM-2026-000007.pdf", MimeType: "application/pdf", FileContent: "JVBERg==" }],
    });
    expect(order).not.toHaveProperty("Paid");
  });
});

describe("credit notes", () => {
  it("reference the original and carry positive quantities and amounts", () => {
    const credit = doc([line(-4500, 21, -2), line(-1000, 6, -1)], { kind: "credit_note", number: "CN-2026-000003", reversesInvoiceId: "x", status: "issued", paidAt: null, reason: "Refund" });
    const order = toBillitOrder(credit, "p1", undefined, { originalNumber: "BEAM-2026-000007" });
    expect(order).toMatchObject({ OrderType: "CreditNote", AboutInvoiceNumber: "BEAM-2026-000007", OrderNumber: "CN-2026-000003" });
    expect(order.OrderLines.every((l) => l.Quantity > 0 && l.UnitPriceExcl > 0)).toBe(true);
    expect(billitOrderTotalCents(order.OrderLines)).toBe(-credit.totalCents);
  });

  it("a credit note refunded to euro credit registers the voucher method", () => {
    const credit = doc([line(-3000, 21)], { kind: "credit_note", number: "CN-2026-000004", status: "paid", paymentProvider: "credit_balance", paymentMethod: "voucher" });
    expect(toBillitPayment(credit, [{ provider: "credit_balance", method: null, amountCents: 3000 }])).toEqual({
      paidOn: "2026-11-04",
      amountCents: 3000,
      method: BILLIT_PAYMENT_METHOD_CODES.voucher,
      reference: "tr_abc",
    });
  });
});

describe("euro credit (rule 8a)", () => {
  const lines = [line(6000, 21), line(4000, 6)];

  it("an order paid fully with euro credit keeps normal VAT lines, Paid = true and the voucher method", () => {
    const d = doc(lines, { paymentProvider: "credit_balance", paymentMethod: "voucher", paymentTransactionRef: null });
    const order = toBillitOrder(d, "p1", undefined, { payments: [{ provider: "credit_balance", method: null, amountCents: 10_000 }] });
    expect(order.OrderLines).toHaveLength(2);
    expect(order.OrderLines.map((l) => l.VATPercentage)).toEqual([21, 6]);
    expect(order).toMatchObject({ Paid: true, PaidDate: "2026-11-04", PaymentMethod: BILLIT_PAYMENT_METHOD.voucher, Comments: "Euro credit 100.00 EUR" });
    expect(billitOrderTotalCents(order.OrderLines)).toBe(10_000);
  });

  it("30 % euro credit and 70 % Bancontact: order lines and totals unchanged, Bancontact method, split comment", () => {
    const d = doc(lines, { paymentProvider: "mixed", paymentMethod: "mixed" });
    const payments = [
      { provider: "mollie", method: "bancontact", amountCents: 7_000 },
      { provider: "credit_balance", method: null, amountCents: 3_000 },
    ];
    const order = toBillitOrder(d, "p1", undefined, { payments });
    expect(order.OrderLines.every((l) => l.Quantity > 0 && l.UnitPriceExcl > 0)).toBe(true);
    expect(order.OrderLines).toHaveLength(lines.length);
    expect(billitOrderTotalCents(order.OrderLines)).toBe(d.totalCents);
    expect(order.PaymentMethod).toBe(BILLIT_PAYMENT_METHOD.bancontact);
    expect(order.Comments).toBe("Euro credit 30.00 EUR; Bancontact 70.00 EUR");
  });

  it("method table: card, cash, transfer, voucher; mixed without other payments is voucher; null stays null", () => {
    expect(["bancontact", "creditcard", "terminal", "cash", "bank_transfer", "voucher", "ideal"].map((m) => billitPaymentMethod(m))).toEqual([
      "DebitCard",
      "DebitCard",
      "DebitCard",
      "Cash",
      "BankTransfer",
      "Voucher",
      "DebitCard",
    ]);
    expect(billitPaymentMethod("mixed", [{ provider: "credit_balance", method: null, amountCents: 1 }])).toBe("Voucher");
    expect(billitPaymentMethod("mixed", [{ provider: "cash", method: null, amountCents: 5 }, { provider: "terminal", method: null, amountCents: 9 }])).toBe("DebitCard");
    expect(billitPaymentMethod(null)).toBeNull();
    expect(paymentSplitComment([{ provider: "mollie", method: "bancontact", amountCents: 100 }])).toBeNull();
  });
});

describe("parties", () => {
  it("maps name, address, VAT and Peppol id; the reduced snapshot clears email and phone", () => {
    expect(toBillitParty(SNAPSHOT)).toEqual({
      Name: "Lotte Peeters",
      PartyType: "Customer",
      VATNumber: null,
      Email: "lotte@example.com",
      Phone: "+32 470 00 00 00",
      Mobile: null,
      PeppolID: null,
      Addresses: [{ AddressType: "InvoiceAddress", Street: "Kerkstraat 1, bus 2", Zipcode: "9000", City: "Gent", CountryCode: "BE" }],
    });
    const reduced = toBillitParty(reduceSnapshot(SNAPSHOT));
    expect(reduced).toMatchObject({ Name: "Lotte Peeters", Email: null, Phone: null });
    expect(JSON.stringify(reduced)).not.toContain("example.com");
    expect(toBillitParty({ anonymised: true })).toMatchObject({ Email: null, Phone: null });
  });

  it("party keys: company, VAT, person, walk-in, none", () => {
    const company: FullCustomerSnapshot = { ...SNAPSHOT, kind: "company", name: "Acme BV", vat_number: "BE0123456749" };
    expect(billitPartyKey({ personId: "p", companyId: "c", customerSnapshot: company })).toBe("company:c");
    expect(billitPartyKey({ personId: "p", companyId: null, customerSnapshot: company })).toBe("vat:BE0123456749");
    expect(billitPartyKey({ personId: "p", companyId: null, customerSnapshot: SNAPSHOT })).toBe("person:p");
    expect(billitPartyKey({ personId: null, companyId: null, customerSnapshot: { ...SNAPSHOT, kind: "walk_in" } })).toBe("walk_in");
    expect(billitPartyKey({ personId: null, companyId: null, customerSnapshot: reduceSnapshot(SNAPSHOT) })).toBeNull();
    expect(billitPartyKey({ personId: null, companyId: null, customerSnapshot: { anonymised: true } })).toBeNull();
  });
});
