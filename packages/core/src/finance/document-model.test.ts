import { describe, expect, it } from "vitest";
import { formatMoney } from "../i18n/format";
import { LOCALES, type Locale } from "../i18n/locales";
import { t } from "../i18n/t";
import { assertRenderableSeller, buildInvoiceDocumentModel, formatIban, MissingCompanySettingsError } from "./document-model";
import type { FullCustomerSnapshot, InvoiceLine, InvoiceRecord, SellerSnapshot } from "./types";

const SELLER: SellerSnapshot = {
  legal_name: "Vibrant Lifestyle Collective BV",
  trade_name: "BEAM Vitality Center",
  vat_number: "BE0123456749",
  enterprise_number: "0123.456.749",
  address: { line1: "Voorbeeldstraat 1", postal_code: "9000", city: "Gent", country: "BE" },
  support_email: "hello@demo.beam.be",
  phone: "+32 9 000 00 00",
  website: "https://beam.example.com",
  register_court: "Gent",
  iban: "BE71096123456769",
  bic: "GKCCBEBB",
  footer: "General terms apply.",
  locale: "nl-BE",
};

const PERSON: FullCustomerSnapshot = {
  kind: "person",
  name: "An Peeters",
  email: "an.peeters@example.com",
  phone: "+32 470 12 34 56",
  address: { line1: "Kerkstraat 5", postal_code: "9000", city: "Gent", country: "BE" },
  vat_number: null,
  peppol_id: null,
  purchase_order_ref: null,
  person_id: "8d0f4c51-2d0a-4b3a-9a0e-6a6b1d2a7c11",
  company_id: null,
  is_reduced: false,
};

const COMPANY: FullCustomerSnapshot = {
  ...PERSON,
  kind: "company",
  name: "Example Wellness BV",
  email: "billing@example.com",
  phone: "+32 2 000 00 01",
  vat_number: "BE0403170701",
  peppol_id: "0208:0403170701",
  purchase_order_ref: "PO-778",
  person_id: null,
};

const LINE: InvoiceLine = {
  order_line_id: "b3f0c8a1-1111-4a3a-9a0e-6a6b1d2a7c11",
  product_id: "c3f0c8a1-2222-4a3a-9a0e-6a6b1d2a7c11",
  sku: "DAY-10",
  category: "package",
  description: "10-dagenpakket",
  description_i18n: { "nl-BE": "10-dagenpakket", "fr-BE": "Forfait 10 jours", en: "10-day package" },
  quantity: 1,
  unit_amount_cents: 12_100,
  discount_cents: 0,
  discount_label: null,
  line_total_cents: 12_100,
  vat_rate_pct: 21,
  vat_cents: 2_100,
  net_cents: 10_000,
  vat_note: null,
  credit_kind: "day",
  credit_units: 10,
  session_starts_at: null,
};

function invoice(overrides: Partial<InvoiceRecord> = {}): InvoiceRecord {
  return {
    id: "f3f0c8a1-3333-4a3a-9a0e-6a6b1d2a7c11",
    kind: "invoice",
    number: "BEAM-2026-000042",
    fiscalYear: 2026,
    sequenceNumber: 42,
    reversesInvoiceId: null,
    replacesInvoiceId: null,
    orderId: "a3f0c8a1-4444-4a3a-9a0e-6a6b1d2a7c11",
    paymentId: null,
    refundId: null,
    personId: PERSON.person_id,
    companyId: null,
    isCompany: false,
    locale: "nl-BE",
    currency: "EUR",
    customerSnapshot: PERSON,
    sellerSnapshot: SELLER,
    lines: [LINE],
    subtotalCents: 10_000,
    vatCents: 2_100,
    totalCents: 12_100,
    vatBreakdown: [{ vat_rate_pct: 21, net_cents: 10_000, vat_cents: 2_100, gross_cents: 12_100 }],
    issuedOn: "2026-11-04",
    issuedAt: new Date("2026-11-04T10:00:00Z"),
    dueOn: null,
    status: "paid",
    paidAt: new Date("2026-11-04T10:00:00Z"),
    settledVia: "provider",
    paymentProvider: "mollie",
    paymentMethod: "bancontact",
    paymentTransactionRef: "tr_abc123",
    paymentReference: null,
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
    ...overrides,
  };
}

describe("buildInvoiceDocumentModel", () => {
  it("B2C: unit prices and line amounts include VAT, plus the breakdown", () => {
    const m = buildInvoiceDocumentModel(invoice());
    expect(m.columns.map((c) => c.label)).toContain(t("nl-BE", "finance.pdf.unit_price_incl"));
    expect(m.columns.map((c) => c.label)).toContain(t("nl-BE", "finance.pdf.amount"));
    expect(m.rows[0]).toMatchObject({ unit: formatMoney(12_100, "nl-BE"), amount: formatMoney(12_100, "nl-BE") });
    expect(m.breakdown.rows).toHaveLength(1);
    expect(m.breakdown.rows[0]![0]).toMatch(/21/);
    expect(m.breakdown.rows[0]!.slice(1)).toEqual([formatMoney(10_000, "nl-BE"), formatMoney(2_100, "nl-BE"), formatMoney(12_100, "nl-BE")]);
    expect(m.totals.at(-1)).toMatchObject({ value: formatMoney(12_100, "nl-BE"), strong: true });
  });

  it("B2B: unit prices and line amounts exclude VAT, with VAT number and PO reference of the buyer", () => {
    const m = buildInvoiceDocumentModel(invoice({ isCompany: true, customerSnapshot: COMPANY, companyId: "d3f0c8a1-5555-4a3a-9a0e-6a6b1d2a7c11" }));
    expect(m.columns.map((c) => c.label)).toContain(t("nl-BE", "finance.pdf.unit_price_excl"));
    expect(m.columns.map((c) => c.label)).toContain(t("nl-BE", "finance.pdf.net_amount"));
    expect(m.rows[0]).toMatchObject({ unit: formatMoney(10_000, "nl-BE"), amount: formatMoney(10_000, "nl-BE") });
    expect(m.customer.name).toBe("Example Wellness BV");
    expect(m.customer.lines.join("\n")).toContain("BE0403170701");
    expect(m.customer.lines.join("\n")).toContain("PO-778");
  });

  it("credit note: heading, reference to the original invoice and the reason", () => {
    const m = buildInvoiceDocumentModel(
      invoice({
        kind: "credit_note",
        number: "CN-2026-000007",
        status: "issued",
        reason: "Customer request",
        reversesInvoiceId: "e3f0c8a1-6666-4a3a-9a0e-6a6b1d2a7c11",
        lines: [{ ...LINE, quantity: -1, line_total_cents: -12_100, vat_cents: -2_100, net_cents: -10_000 }],
        subtotalCents: -10_000,
        vatCents: -2_100,
        totalCents: -12_100,
        vatBreakdown: [{ vat_rate_pct: 21, net_cents: -10_000, vat_cents: -2_100, gross_cents: -12_100 }],
        paidAt: null,
      }),
      { number: "BEAM-2026-000042" },
    );
    expect(m.heading).toBe(t("nl-BE", "finance.pdf.credit_note_title"));
    expect(m.reference).toBe(t("nl-BE", "finance.pdf.credit_note_for", { number: "BEAM-2026-000042" }));
    expect(m.reason).toEqual({ label: t("nl-BE", "finance.pdf.reason"), value: "Customer request" });
    expect(m.rows[0]!.amount).toBe(formatMoney(-12_100, "nl-BE"));
    expect(m.meta.title).toContain("CN-2026-000007");
  });

  it("open invoice: due date, IBAN and structured communication", () => {
    const m = buildInvoiceDocumentModel(
      invoice({ status: "open", dueOn: "2026-11-18", paymentReference: "+++260/0000/04297+++", paidAt: null, settledVia: null, paymentMethod: null, paymentProvider: null, paymentTransactionRef: null }),
    );
    expect(m.facts.map((f) => f.label)).toEqual([
      t("nl-BE", "finance.pdf.number"),
      t("nl-BE", "finance.pdf.issue_date"),
      t("nl-BE", "finance.pdf.due_date"),
      t("nl-BE", "finance.pdf.structured_communication"),
    ]);
    const text = m.payment.lines.join("\n");
    expect(text).toContain(formatIban(SELLER.iban));
    expect(text).toContain("GKCCBEBB");
    expect(text).toContain("+++260/0000/04297+++");
  });

  it("paid invoice prints payment date, method and transaction reference, no due date", () => {
    const m = buildInvoiceDocumentModel(invoice());
    expect(m.facts).toHaveLength(2);
    expect(m.payment.lines.join("\n")).toContain("tr_abc123");
    expect(m.payment.lines.join("\n")).toContain("Bancontact");
  });

  it("never carries the buyer's email address or phone number", () => {
    for (const snap of [PERSON, COMPANY]) {
      const json = JSON.stringify(buildInvoiceDocumentModel(invoice({ customerSnapshot: snap, isCompany: snap.kind === "company" })));
      expect(json).not.toContain(snap.email!);
      expect(json).not.toContain(snap.phone!);
    }
  });

  it.each(LOCALES)("renders every label in %s from the finance catalogue", (locale: Locale) => {
    const m = buildInvoiceDocumentModel(invoice({ locale, sellerSnapshot: { ...SELLER, locale } }));
    expect(m.locale).toBe(locale);
    expect(m.meta.language).toBe(locale);
    expect(m.heading).toBe(t(locale, "finance.pdf.invoice_title"));
    expect(m.customer.label).toBe(t(locale, "finance.pdf.customer"));
    expect(m.totals[2]!.label).toBe(t(locale, "finance.pdf.total_incl"));
    expect(m.pageLabel).toContain("{x}");
    expect(m.pageLabel).toContain("{y}");
    expect(JSON.stringify(m)).not.toContain("⟦");
  });

  it("is deterministic and prints session dates, discounts and VAT notes as line details", () => {
    const line: InvoiceLine = {
      ...LINE,
      category: "session",
      discount_cents: 500,
      discount_label: "Welcome",
      line_total_cents: 11_600,
      vat_cents: 2_013,
      net_cents: 9_587,
      session_starts_at: "2026-11-20T09:00:00.000Z",
      vat_note: "Btw verschuldigd bij inwisseling",
    };
    const inv = invoice({ lines: [line] });
    expect(buildInvoiceDocumentModel(inv)).toEqual(buildInvoiceDocumentModel(inv));
    const details = buildInvoiceDocumentModel(inv).rows[0]!.details.join("\n");
    expect(details).toContain("Welcome");
    expect(details).toContain(formatMoney(-500, "nl-BE"));
    expect(details).toContain("Btw verschuldigd bij inwisseling");
    expect(details).toContain("2026");
  });

  it("an anonymised document has an empty buyer block", () => {
    const m = buildInvoiceDocumentModel(invoice({ customerSnapshot: { anonymised: true }, personId: null }));
    expect(m.customer).toMatchObject({ name: "", lines: [] });
  });
});

describe("assertRenderableSeller", () => {
  it("refuses an empty VAT number, enterprise number or IBAN in production only", () => {
    const blank = { ...SELLER, vat_number: "", iban: "" };
    expect(() => assertRenderableSeller(blank, "production")).toThrow(MissingCompanySettingsError);
    expect(() => assertRenderableSeller(blank, "staging")).not.toThrow();
    expect(() => assertRenderableSeller(SELLER, "production")).not.toThrow();
    try {
      assertRenderableSeller(blank, "production");
    } catch (e) {
      expect((e as MissingCompanySettingsError).missing).toEqual(["company.vat_number", "finance.issuer.iban"]);
      expect((e as MissingCompanySettingsError).retryable).toBe(false);
    }
  });
});
