import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { InvoiceLine, InvoiceRecord } from "@beam/core/finance";
import { buildInvoiceDocumentModel, renderInvoicePdf } from "./render";

const LINE: InvoiceLine = {
  order_line_id: "b3f0c8a1-1111-4a3a-9a0e-6a6b1d2a7c11",
  product_id: "c3f0c8a1-2222-4a3a-9a0e-6a6b1d2a7c11",
  sku: "DAY-1",
  category: "session",
  description: "Dagsessie",
  description_i18n: { "nl-BE": "Dagsessie", "fr-BE": "Séance de jour", en: "Day session" },
  quantity: 1,
  unit_amount_cents: 4_500,
  discount_cents: 0,
  discount_label: null,
  line_total_cents: 4_500,
  vat_rate_pct: 21,
  vat_cents: 781,
  net_cents: 3_719,
  vat_note: null,
  credit_kind: null,
  credit_units: null,
  session_starts_at: "2026-11-20T09:00:00.000Z",
};

/** A paid B2C invoice with `n` lines of 45.00 at 21 %. */
export function sampleInvoice(n: number, overrides: Partial<InvoiceRecord> = {}): InvoiceRecord {
  const lines = Array.from({ length: n }, (_, i) => ({ ...LINE, order_line_id: `b3f0c8a1-1111-4a3a-9a0e-${String(i).padStart(12, "0")}`, description: `Dagsessie ${i + 1}` }));
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
    personId: null,
    companyId: null,
    isCompany: false,
    locale: "nl-BE",
    currency: "EUR",
    customerSnapshot: {
      kind: "person",
      name: "An Peeters",
      email: "an.peeters@example.com",
      phone: "+32 470 12 34 56",
      address: { line1: "Kerkstraat 5", postal_code: "9000", city: "Gent", country: "BE" },
      vat_number: null,
      peppol_id: null,
      purchase_order_ref: null,
      person_id: null,
      company_id: null,
      is_reduced: false,
    },
    sellerSnapshot: {
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
      footer: "Algemene voorwaarden van toepassing.",
      locale: "nl-BE",
    },
    lines,
    subtotalCents: 3_719 * n,
    vatCents: 781 * n,
    totalCents: 4_500 * n,
    vatBreakdown: [{ vat_rate_pct: 21, net_cents: 3_719 * n, vat_cents: 781 * n, gross_cents: 4_500 * n }],
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

const latin1 = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");

/** Number of page objects (`/Type /Page`, not `/Pages`). */
export function pageCount(pdf: Uint8Array): number {
  return latin1(pdf).match(/\/Type\s*\/Page(?![a-zA-Z])/g)?.length ?? 0;
}

/** The text shown by every content stream (standard fonts, hex strings in `Tj`/`TJ`), in order. */
export function pdfText(pdf: Uint8Array): string {
  const raw = Buffer.from(pdf);
  const src = raw.toString("latin1");
  const out: string[] = [];
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const start = m.index + m[0].length;
    const end = src.indexOf("endstream", start);
    if (end < 0) break;
    const chunk = raw.subarray(start, end);
    let body: string;
    try {
      body = inflateSync(chunk).toString("latin1");
    } catch {
      body = chunk.toString("latin1");
    }
    for (const op of body.matchAll(/\[([^\]]*)\]\s*TJ|<([0-9a-fA-F]*)>\s*Tj/g)) {
      const parts = op[1] !== undefined ? [...op[1].matchAll(/<([0-9a-fA-F]*)>/g)].map((h) => h[1]!) : [op[2]!];
      out.push(parts.map((h) => Buffer.from(h, "hex").toString("latin1")).join(""));
    }
    re.lastIndex = end + "endstream".length;
  }
  return out.join("\n");
}

describe("renderInvoicePdf", () => {
  it("returns PDF bytes", async () => {
    const pdf = await renderInvoicePdf(buildInvoiceDocumentModel(sampleInvoice(3)));
    expect(latin1(pdf.subarray(0, 5))).toBe("%PDF-");
    const text = pdfText(pdf);
    expect(text).toContain("BEAM-2026-000042");
    expect(text).toContain("Factuur");
    expect(text).toContain("An Peeters");
    expect(text).not.toContain("an.peeters@example.com");
  }, 30_000);

  it("fits 10 lines on one page and needs two pages for 40", async () => {
    expect(pageCount(await renderInvoicePdf(buildInvoiceDocumentModel(sampleInvoice(10))))).toBe(1);
    const forty = await renderInvoicePdf(buildInvoiceDocumentModel(sampleInvoice(40)));
    expect(pageCount(forty)).toBe(2);
    expect(pdfText(forty)).toContain("Pagina 2 van 2");
  }, 30_000);

  it("gives the same text content for the same input", async () => {
    const model = buildInvoiceDocumentModel(sampleInvoice(12));
    const [a, b] = [await renderInvoicePdf(model), await renderInvoicePdf(buildInvoiceDocumentModel(sampleInvoice(12)))];
    expect(pdfText(a)).toBe(pdfText(b));
    expect(pdfText(a).length).toBeGreaterThan(200);
  }, 30_000);

  it("carries title, author and language in the document information", async () => {
    const pdf = latin1(await renderInvoicePdf(buildInvoiceDocumentModel(sampleInvoice(1, { locale: "fr-BE" }))));
    expect(pdf).toMatch(/\/Lang \(fr-BE\)/);
    expect(pdf).toContain("Facture BEAM-2026-000042");
    expect(pdf).toContain("Vibrant Lifestyle Collective BV");
  }, 30_000);
});
