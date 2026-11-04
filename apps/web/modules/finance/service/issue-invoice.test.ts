/**
 * finance-P2 `issueInvoice` (finance rules 1 to 16, edge cases 1 to 5, 22, 28).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { invoices } from "@beam/db/schema";
import { brusselsDateOf, structuredCommunication, type FullCustomerSnapshot } from "@beam/core/finance";
import { eq } from "@/lib/ctx";
import { issueCreditNote, issueInvoice, setOrderBillingDetails } from "../api";
import {
  asTx,
  ctxAt,
  eventsOf,
  invoiceRow,
  jobByKey,
  lastNumber,
  makeOrder,
  makeOrderLine,
  makePerson,
  paidOrder,
  payment,
  refund,
  setupDb,
  txCtx,
} from "./__tests__/fixtures";

vi.mock("@/registry/jobs.generated", async (importOriginal) => {
  const { withFinanceJobStubs } = await import("./__tests__/fixtures");
  return withFinanceJobStubs(await importOriginal<{ JOB_BY_KIND: Record<string, unknown> }>());
});

let h: DbHandle;
beforeAll(async () => {
  h = await setupDb();
});
afterAll(() => h.close());

const issue = (orderId: string, now?: Date, extra: Partial<Parameters<typeof issueInvoice>[2]> = {}) =>
  issueInvoice(asTx(h.db), ctxAt(h.db, now), { orderId, ...extra });

describe("issueInvoice: paid orders", () => {
  it("issues BEAM-2026-000001 as paid with the payment method, a PDF job and one event", async () => {
    const { order, lines } = await paidOrder(h.db);
    const pay = await payment(h.db, order.id, { amountCents: order.totalCents });
    const result = await issue(order.id, undefined, { paymentId: pay.id });
    expect(result).toMatchObject({ status: "issued", number: "BEAM-2026-000001" });
    if (result.status !== "issued") throw new Error("not issued");

    const inv = await invoiceRow(h.db, result.invoiceId);
    expect(inv).toMatchObject({
      kind: "invoice",
      status: "paid",
      fiscalYear: 2026,
      sequenceNumber: 1,
      issuedOn: "2026-11-04",
      totalCents: order.totalCents,
      paymentId: pay.id,
      paymentProvider: "mollie",
      paymentMethod: "bancontact",
      paymentTransactionRef: pay.providerPaymentId,
      settledVia: "provider",
      isCompany: false,
      locale: "nl-BE",
      pdfStatus: "pending",
      billitStatus: "pending",
      billitPaymentStatus: "not_applicable",
      peppolStatus: "not_applicable",
      issuedBy: { kind: "system", id: null },
    });
    expect(inv.paidAt).not.toBeNull();
    expect(inv.lines).toHaveLength(1);
    expect(inv.lines[0]).toMatchObject({ order_line_id: lines[0]!.id, line_total_cents: lines[0]!.lineTotalCents, vat_cents: lines[0]!.vatCents, vat_rate_pct: 21 });
    expect(inv.subtotalCents + inv.vatCents).toBe(inv.totalCents);
    expect(inv.vatBreakdown).toEqual([{ vat_rate_pct: 21, net_cents: inv.subtotalCents, vat_cents: inv.vatCents, gross_cents: inv.totalCents }]);
    expect((inv.customerSnapshot as FullCustomerSnapshot).kind).toBe("person");
    expect(inv.sellerSnapshot.legal_name).toBe("Vibrant Lifestyle Collective BV");

    const job = await jobByKey(h.db, `invoice_pdf:${inv.id}`);
    expect(job).toMatchObject({ kind: "finance.render_pdf", payload: { invoiceId: inv.id } });
    const issued = (await eventsOf(h.db, "invoice.issued")).filter((e) => e.refId === inv.id);
    expect(issued).toHaveLength(1);
    expect(issued[0]).toMatchObject({ personId: order.personId, dedupeKey: `invoice:${inv.id}:issued` });
    expect(issued[0]!.data).toEqual({ invoice_id: inv.id, number: "BEAM-2026-000001", total_cents: inv.totalCents, is_company: false, status: "paid" });
  });

  it("returns the invoice as existing on a second call and issues nothing", async () => {
    const { order } = await paidOrder(h.db);
    const first = await issue(order.id);
    const before = await lastNumber(h.db, "invoice", 2026);
    const second = await issue(order.id);
    expect(first.status).toBe("issued");
    expect(second).toEqual({ ...first, status: "existing" });
    expect(await lastNumber(h.db, "invoice", 2026)).toBe(before);
    expect(await h.db.select().from(invoices).where(eq(invoices.orderId, order.id))).toHaveLength(1);
  });

  it("skips a zero-total order", async () => {
    const { order } = await paidOrder(h.db, [{ unitAmountCents: 0 }]);
    const before = await lastNumber(h.db, "invoice", 2026);
    expect(await issue(order.id)).toEqual({ status: "skipped", reason: "zero_total" });
    expect(await h.db.select().from(invoices).where(eq(invoices.orderId, order.id))).toHaveLength(0);
    expect(await lastNumber(h.db, "invoice", 2026)).toBe(before);
  });

  it("throws conflict on a total mismatch and the transaction leaves no row and no counter change", async () => {
    const order = await makeOrder(h.db, { status: "paid", subtotalCents: 5_000, totalCents: 5_000 });
    await makeOrderLine(h.db, { orderId: order.id, unitAmountCents: 4_500 });
    const before = await lastNumber(h.db, "invoice", 2026);
    await expect(h.db.transaction((tx) => issueInvoice(tx, txCtx(tx), { orderId: order.id }))).rejects.toMatchObject({
      code: "conflict",
      message: "finance.errors.total_mismatch",
    });
    expect(await h.db.select().from(invoices).where(eq(invoices.orderId, order.id))).toHaveLength(0);
    expect(await lastNumber(h.db, "invoice", 2026)).toBe(before);
  });

  it("rolls back the number when the caller's transaction fails after issuing (edge case 2)", async () => {
    const { order } = await paidOrder(h.db);
    const before = await lastNumber(h.db, "invoice", 2026);
    await expect(
      h.db.transaction(async (tx) => {
        await issueInvoice(tx, txCtx(tx), { orderId: order.id });
        throw new Error("credits grant failed");
      }),
    ).rejects.toThrow("credits grant failed");
    expect(await lastNumber(h.db, "invoice", 2026)).toBe(before);
    const again = await issue(order.id);
    expect(again).toMatchObject({ status: "issued", number: `BEAM-2026-${String((before ?? 0) + 1).padStart(6, "0")}` });
  });

  it("takes the company snapshot from the order's billing details", async () => {
    const { order } = await paidOrder(h.db);
    await setOrderBillingDetails(asTx(h.db), ctxAt(h.db), {
      orderId: order.id,
      details: {
        isCompany: true,
        legalName: "Acme Wellness BV",
        vatNumber: "be 0123.456.749",
        address: { line1: "Kerkstraat 1", postal_code: "9000", city: "Gent", country: "be" },
        billingEmail: "Billing@Example.com",
        purchaseOrderRef: "PO-77",
      },
    });
    const result = await issue(order.id);
    if (result.status !== "issued") throw new Error("not issued");
    const inv = await invoiceRow(h.db, result.invoiceId);
    expect(inv.isCompany).toBe(true);
    expect(inv.peppolStatus).toBe("pending");
    expect(inv.personId).toBe(order.personId);
    expect(inv.customerSnapshot).toMatchObject({
      kind: "company",
      name: "Acme Wellness BV",
      vat_number: "BE0123456749",
      peppol_id: "0208:0123456749",
      email: "billing@example.com",
      purchase_order_ref: "PO-77",
      address: { line1: "Kerkstraat 1", postal_code: "9000", city: "Gent", country: "BE" },
      is_reduced: false,
    });
  });

  it("gives payment_method voucher for euro credit and mixed for two payments", async () => {
    const credit = await paidOrder(h.db);
    await payment(h.db, credit.order.id, { provider: "credit_balance", method: null, providerPaymentId: null, amountCents: credit.order.totalCents });
    const r1 = await issue(credit.order.id);
    if (r1.status !== "issued") throw new Error("not issued");
    expect(await invoiceRow(h.db, r1.invoiceId)).toMatchObject({ paymentProvider: "credit_balance", paymentMethod: "voucher" });

    const mixed = await paidOrder(h.db, [{ unitAmountCents: 10_000 }]);
    await payment(h.db, mixed.order.id, { provider: "credit_balance", method: null, providerPaymentId: null, amountCents: 3_000 });
    const card = await payment(h.db, mixed.order.id, { amountCents: 7_000 });
    const r2 = await issue(mixed.order.id);
    if (r2.status !== "issued") throw new Error("not issued");
    const inv = await invoiceRow(h.db, r2.invoiceId);
    expect(inv).toMatchObject({ paymentProvider: "mixed", paymentMethod: "mixed", paymentId: card.id, totalCents: 10_000 });
    expect(inv.lines).toHaveLength(1);
    expect(inv.lines[0]!.line_total_cents).toBe(10_000);
  });

  it("gives an anonymous POS order the walk_in snapshot in nl-BE and records no event", async () => {
    const order = await makeOrder(h.db, { channel: "pos", status: "paid", subtotalCents: 4_500, totalCents: 4_500, locale: "fr-BE" });
    expect(order.personId).toBeNull();
    await makeOrderLine(h.db, { orderId: order.id });
    const result = await issue(order.id);
    if (result.status !== "issued") throw new Error("not issued");
    const inv = await invoiceRow(h.db, result.invoiceId);
    expect(inv.locale).toBe("nl-BE");
    expect(inv.personId).toBeNull();
    expect(inv.customerSnapshot).toMatchObject({ kind: "walk_in", email: null, address: null, person_id: null });
    expect((inv.customerSnapshot as FullCustomerSnapshot).name.length).toBeGreaterThan(3);
    expect((await eventsOf(h.db, "invoice.issued")).filter((e) => e.refId === inv.id)).toHaveLength(0);
  });

  it("prints the voucher VAT note on a 0 % voucher line and refuses a 0 % line without a note", async () => {
    const voucher = await paidOrder(h.db, [{ productKind: "voucher", unitAmountCents: 5_000, vatRatePct: "0.00", vatCents: 0 }]);
    const r = await issue(voucher.order.id);
    if (r.status !== "issued") throw new Error("not issued");
    const inv = await invoiceRow(h.db, r.invoiceId);
    expect(inv.lines[0]).toMatchObject({ category: "voucher", vat_rate_pct: 0, vat_cents: 0, net_cents: 5_000, vat_note: "Btw verschuldigd bij inwisseling." });
    expect(inv.vatCents).toBe(0);

    const item = await paidOrder(h.db, [{ productKind: "item", unitAmountCents: 1_000, vatRatePct: "0.00", vatCents: 0 }]);
    await expect(issue(item.order.id)).rejects.toMatchObject({ code: "validation", message: "finance.errors.vat_note_missing" });
  });

  it("uses the person's locale and falls back to nl-BE for the whole document when a line lacks it", async () => {
    const fr = await makePerson(h.db, { locale: "fr-BE" });
    const ok = await paidOrder(h.db, undefined, { personId: fr.id });
    const r1 = await issue(ok.order.id);
    if (r1.status !== "issued") throw new Error("not issued");
    expect((await invoiceRow(h.db, r1.invoiceId)).locale).toBe("fr-BE");

    const legacy = await paidOrder(h.db, [{ description: { "nl-BE": "Oude lijn", en: "Old line" } }], { personId: fr.id });
    const r2 = await issue(legacy.order.id);
    if (r2.status !== "issued") throw new Error("not issued");
    const inv = await invoiceRow(h.db, r2.invoiceId);
    expect(inv.locale).toBe("nl-BE");
    expect(inv.lines[0]!.description).toBe("Oude lijn");
    expect(inv.sellerSnapshot.locale).toBe("nl-BE");
  });
});

describe("issueInvoice: bank transfer (open)", () => {
  it("issues an open invoice with due date and structured communication", async () => {
    const order = await makeOrder(h.db, { channel: "admin", status: "pending_payment", subtotalCents: 4_500, totalCents: 4_500 });
    await makeOrderLine(h.db, { orderId: order.id });
    const result = await issue(order.id, undefined, { status: "open" });
    if (result.status !== "issued") throw new Error("not issued");
    const inv = await invoiceRow(h.db, result.invoiceId);
    expect(inv).toMatchObject({ status: "open", issuedOn: "2026-11-04", dueOn: "2026-11-18", paidAt: null, settledVia: null, paymentMethod: null });
    expect(inv.paymentReference).toBe(structuredCommunication(2026, inv.sequenceNumber));
    expect(inv.paymentReference).toMatch(/^\+\+\+\d{3}\/\d{4}\/\d{5}\+\+\+$/);
    const issued = (await eventsOf(h.db, "invoice.issued")).filter((e) => e.refId === inv.id);
    expect((issued[0]!.data as { status: string }).status).toBe("open");
  });

  it("takes dueOn from commerce over payment_terms_days", async () => {
    const order = await makeOrder(h.db, { subtotalCents: 4_500, totalCents: 4_500 });
    await makeOrderLine(h.db, { orderId: order.id });
    const result = await issue(order.id, undefined, { status: "open", dueOn: "2026-11-30" });
    if (result.status !== "issued") throw new Error("not issued");
    expect((await invoiceRow(h.db, result.invoiceId)).dueOn).toBe("2026-11-30");
  });

  it("settles an open invoice on a later paid call (rule 2a) with the payment snapshot", async () => {
    const order = await makeOrder(h.db, { subtotalCents: 4_500, totalCents: 4_500 });
    await makeOrderLine(h.db, { orderId: order.id });
    const open = await issue(order.id, undefined, { status: "open" });
    if (open.status !== "issued") throw new Error("not issued");
    const transfer = await payment(h.db, order.id, { provider: "bank_transfer", method: "bank_transfer", providerPaymentId: null });
    const paidAt = new Date("2026-11-10T11:00:00Z");
    const settled = await issue(order.id, undefined, { status: "paid", paymentId: transfer.id, paidAt, settledVia: "billit" });
    expect(settled).toEqual({ status: "existing", invoiceId: open.invoiceId, number: open.number });
    const inv = await invoiceRow(h.db, open.invoiceId);
    expect(inv).toMatchObject({ status: "paid", settledVia: "billit", paymentId: transfer.id, paymentProvider: "bank_transfer", paymentMethod: "bank_transfer" });
    expect(inv.paidAt?.toISOString()).toBe(paidAt.toISOString());
    expect((await eventsOf(h.db, "invoice.paid")).filter((e) => e.refId === inv.id)).toHaveLength(1);
    // A second paid call is a no-op.
    await issue(order.id, undefined, { status: "paid", paymentId: transfer.id });
    expect((await eventsOf(h.db, "invoice.paid")).filter((e) => e.refId === inv.id)).toHaveLength(1);
  });
});

describe("issueInvoice: numbering", () => {
  it("numbers 50 orders 1..50 consecutively", async () => {
    const now = new Date("2030-03-01T09:00:00Z");
    const numbers: number[] = [];
    for (let i = 0; i < 50; i++) {
      const { order } = await paidOrder(h.db);
      const r = await issue(order.id, now);
      if (r.status !== "issued") throw new Error("not issued");
      numbers.push((await invoiceRow(h.db, r.invoiceId)).sequenceNumber);
    }
    expect(numbers).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(await lastNumber(h.db, "invoice", 2030)).toBe(50);
  });

  it("restarts at 1 in the new Brussels year, even while UTC is still in the old one", async () => {
    const lateDec = new Date("2028-12-31T22:30:00Z"); // 23:30 in Brussels
    const newYear = new Date("2028-12-31T23:30:00Z"); // 00:30 on 1 January 2029 in Brussels
    expect(brusselsDateOf(newYear)).toBe("2029-01-01");
    const a = await paidOrder(h.db);
    const b = await paidOrder(h.db);
    expect(await issue(a.order.id, lateDec)).toMatchObject({ number: "BEAM-2028-000001" });
    const r = await issue(b.order.id, newYear);
    expect(r).toMatchObject({ number: "BEAM-2029-000001" });
    if (r.status !== "issued") throw new Error("not issued");
    expect(await invoiceRow(h.db, r.invoiceId)).toMatchObject({ fiscalYear: 2029, issuedOn: "2029-01-01" });
  });

  it("returns the cancelled invoice as existing after a full refund (edge case 28)", async () => {
    const { order } = await paidOrder(h.db);
    const pay = await payment(h.db, order.id, { amountCents: order.totalCents });
    const r = await issue(order.id);
    if (r.status !== "issued") throw new Error("not issued");
    const ref = await refund(h.db, pay, order.totalCents);
    await issueCreditNote(asTx(h.db), ctxAt(h.db), { invoiceId: r.invoiceId, refundId: ref.id, reason: "Full refund" });
    expect((await invoiceRow(h.db, r.invoiceId)).status).toBe("cancelled");
    const again = await issue(order.id);
    expect(again).toEqual({ status: "existing", invoiceId: r.invoiceId, number: r.number });
    expect(await h.db.select().from(invoices).where(eq(invoices.orderId, order.id))).toHaveLength(2);
  });
});
