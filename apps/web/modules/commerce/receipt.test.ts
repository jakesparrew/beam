/**
 * commerce-P4a the receipt PDF (rules 44 and 54, section 8): PDF bytes per locale; VAT per rate;
 * the withdrawal notice on online orders only; a missing catalogue key is permanent.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson, makeProduct } from "@beam/db/testing";
import { makeOrder, makeOrderLine } from "@beam/db/testing/commerce-factories";
import type { DbHandle } from "@beam/db";
import { PermanentError } from "@beam/core/errors";
import { LOCALES, MESSAGES } from "@beam/core/i18n";

vi.mock("next/headers", () => ({ cookies: () => Promise.resolve({ get: () => undefined }), headers: () => Promise.resolve(new Headers()) }));
vi.mock("next/server", () => ({ after: () => undefined }));
vi.mock("@/modules/credits/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  grantCredits: () => Promise.resolve({ grantId: randomUUID(), created: true }),
}));
vi.mock("@/modules/finance/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  issueInvoice: () => Promise.resolve({ status: "issued", invoiceId: randomUUID(), number: "2026-000001" }),
}));

const { loadReceiptInput, receiptModel, renderReceiptPdf, vatSummary } = await import("./ui/receipt-pdf");
const { finalizePaidOrder } = await import("./server/paid");
const { createCtx } = await import("@/lib/ctx");
const { makeCtx, resetRuntime, createFakeIntegrations } = await import("@/lib/testing");

let h: DbHandle;

beforeAll(async () => {
  h = await createTestDb();
  makeCtx(h.db, { integrations: createFakeIntegrations() });
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

const sample = (locale: (typeof LOCALES)[number]) => ({
  reference: "BO-7K3M9Q2X",
  locale,
  issuedAt: new Date("2026-11-04T10:00:00Z"),
  company: { name: "BEAM Vitality Center", legalName: "Vibrant Lifestyle Collective BV", vatNumber: "BE0123456789", address: "Voorbeeldstraat 1, 9000 Gent", email: "support@demo.beam.be" },
  lines: [
    { description: { "nl-BE": "Nacht", "fr-BE": "Nuit", en: "Night" }, quantity: 1, unitAmountCents: 9500, discountCents: 0, lineTotalCents: 9500, vatRatePct: 6, vatCents: 538 },
    { description: { "nl-BE": "Dagpakket", "fr-BE": "Forfait jour", en: "Day package" }, quantity: 2, unitAmountCents: 20_000, discountCents: 2000, lineTotalCents: 38_000, vatRatePct: 21, vatCents: 6595 },
    { description: { "nl-BE": "Handdoek", "fr-BE": "Serviette", en: "Towel" }, quantity: 1, unitAmountCents: 1500, discountCents: 0, lineTotalCents: 1500, vatRatePct: 21, vatCents: 260 },
  ],
  subtotalCents: 51_000,
  discountCents: 2000,
  totalCents: 49_000,
  payments: [{ method: "bancontact", amountCents: 44_000 }, { method: "credit_balance", amountCents: 5000 }],
  withdrawalUntilAt: new Date("2026-11-18T10:00:00Z"),
  footer: { "nl-BE": "Bedankt", "fr-BE": "Merci", en: "Thank you" },
});

describe("receipt PDF", () => {
  it("renders PDF bytes in every locale", async () => {
    for (const locale of LOCALES) {
      const bytes = await renderReceiptPdf(sample(locale));
      expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
      expect(bytes.byteLength).toBeGreaterThan(1000);
    }
  });

  it("lists VAT per rate with net, VAT and gross", () => {
    expect(vatSummary(sample("en").lines)).toEqual([
      { ratePct: 6, grossCents: 9500, vatCents: 538, netCents: 8962 },
      { ratePct: 21, grossCents: 39_500, vatCents: 6855, netCents: 32_645 },
    ]);
    const nl = receiptModel(sample("nl-BE"));
    expect(nl.vatRows.map((r) => r.rate)).toEqual(["Btw 6 %", "Btw 21 %"]);
    expect(nl.title).toBe("Kasticket");
    expect(nl.paidWith.map((p) => p.label)).toEqual(["Bancontact", "Tegoed van cadeaubon"]);
    expect(receiptModel(sample("fr-BE")).vatRows.map((r) => r.rate)).toEqual(["TVA 6 %", "TVA 21 %"]);
  });

  it("carries the withdrawal notice on online orders only (rule 54)", async () => {
    const pkg = await makeProduct(h.db, { kind: "package", priceCents: 20_000 });
    const person = await makePerson(h.db);
    const online = await makeOrder(h.db, { personId: person.id, channel: "portal", subtotalCents: 20_000, totalCents: 20_000, locale: "en" });
    await makeOrderLine(h.db, { orderId: online.id, productId: pkg.id, unitAmountCents: 20_000 });
    const desk = await makeOrder(h.db, { personId: person.id, channel: "admin", subtotalCents: 20_000, totalCents: 20_000, locale: "en" });
    await makeOrderLine(h.db, { orderId: desk.id, productId: pkg.id, unitAmountCents: 20_000 });
    for (const id of [online.id, desk.id]) {
      await h.db.transaction((tx) => finalizePaidOrder(tx, createCtx({ tx, actor: { kind: "system", jobId: "" }, durableMode: "immediate" }), id));
    }
    const onlineModel = receiptModel((await loadReceiptInput(h.db, online.id))!);
    expect(onlineModel.withdrawal).toMatch(/withdraw/i);
    expect(onlineModel.meta[0]).toEqual({ label: "Reference", value: online.reference });
    expect(receiptModel((await loadReceiptInput(h.db, desk.id))!).withdrawal).toBeNull();
  });

  it("refuses a receipt with a missing catalogue key (no mixed language)", () => {
    // The catalogue tree of a module keeps its root key: MESSAGES[locale].commerce.commerce.receipt.
    const tr = (MESSAGES["fr-BE"] as unknown as Record<string, { commerce: { receipt: Record<string, string> } }>).commerce!.commerce.receipt;
    const saved = tr.title!;
    delete tr.title;
    try {
      expect(() => receiptModel(sample("fr-BE"))).toThrow(PermanentError);
    } finally {
      tr.title = saved;
    }
  });
});
