/**
 * finance-P2 settlement (finance rules 2a, 24, 26, 27, 30a; edge cases 11, 12, 29):
 * `markInvoicePaidInternal` and `markCreditNoteSettled`.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { issueCreditNote, issueInvoice, markCreditNoteSettled } from "../api";
import { asTx, ctxAt, eventsOf, invoiceRow, jobByKey, makeOrder, makeOrderLine, paidOrder, payment, refund, setupDb } from "./__tests__/fixtures";
import { updateInvoiceState } from "./invoice-state";
import { markInvoicePaidInternal } from "./settle";

vi.mock("@/registry/jobs.generated", async (importOriginal) => {
  const { withFinanceJobStubs } = await import("./__tests__/fixtures");
  return withFinanceJobStubs(await importOriginal<{ JOB_BY_KIND: Record<string, unknown> }>());
});

let h: DbHandle;
beforeAll(async () => {
  h = await setupDb();
});
afterAll(() => h.close());

const tx = () => asTx(h.db);

async function openInvoice() {
  const order = await makeOrder(h.db, { subtotalCents: 4_500, totalCents: 4_500 });
  await makeOrderLine(h.db, { orderId: order.id });
  const r = await issueInvoice(tx(), ctxAt(h.db), { orderId: order.id, status: "open" });
  if (r.status !== "issued") throw new Error("not issued");
  return { order, invoiceId: r.invoiceId };
}

describe("markInvoicePaidInternal", () => {
  it("settles an open invoice once and records invoice.paid once", async () => {
    const { invoiceId } = await openInvoice();
    const paidAt = new Date("2026-11-06T11:00:00Z");
    const first = await markInvoicePaidInternal(tx(), ctxAt(h.db), { invoiceId, paidAt, settledVia: "manual", bankReference: "BANK-REF-1" });
    const second = await markInvoicePaidInternal(tx(), ctxAt(h.db), { invoiceId, paidAt: new Date(), settledVia: "billit" });
    expect(first).toEqual({ changed: true });
    expect(second).toEqual({ changed: false });
    const inv = await invoiceRow(h.db, invoiceId);
    expect(inv).toMatchObject({
      status: "paid",
      settledVia: "manual",
      paymentProvider: "bank_transfer",
      paymentMethod: "bank_transfer",
      paymentTransactionRef: "BANK-REF-1",
      billitPaymentStatus: "not_applicable",
    });
    expect(inv.paidAt?.toISOString()).toBe(paidAt.toISOString());
    const paid = (await eventsOf(h.db, "invoice.paid")).filter((e) => e.refId === invoiceId);
    expect(paid).toHaveLength(1);
    expect(paid[0]).toMatchObject({ dedupeKey: `invoice:${invoiceId}:paid`, data: { invoice_id: invoiceId, number: inv.number, settled_via: "manual" } });
    expect(await jobByKey(h.db, `billit:payment:${invoiceId}`)).toBeNull();
  });

  it("marks the Billit payment pending and enqueues billit.push_payment when the document is already in Billit", async () => {
    const { invoiceId } = await openInvoice();
    await updateInvoiceState(tx(), invoiceId, { billitId: `billit_${invoiceId.slice(0, 8)}`, billitStatus: "synced", billitSyncedAt: new Date() });
    await markInvoicePaidInternal(tx(), ctxAt(h.db), { invoiceId, paidAt: new Date(), settledVia: "manual" });
    expect((await invoiceRow(h.db, invoiceId)).billitPaymentStatus).toBe("pending");
    expect(await jobByKey(h.db, `billit:payment:${invoiceId}`)).toMatchObject({ kind: "billit.push_payment", payload: { invoiceId } });
  });

  it("leaves the Billit payment status alone when Billit reported the payment (settled_via billit)", async () => {
    const { invoiceId } = await openInvoice();
    await updateInvoiceState(tx(), invoiceId, { billitId: `billit_${invoiceId.slice(0, 8)}`, billitStatus: "synced" });
    await markInvoicePaidInternal(tx(), ctxAt(h.db), { invoiceId, paidAt: new Date(), settledVia: "billit" });
    expect(await invoiceRow(h.db, invoiceId)).toMatchObject({ status: "paid", settledVia: "billit", billitPaymentStatus: "not_applicable" });
    expect(await jobByKey(h.db, `billit:payment:${invoiceId}`)).toBeNull();
  });

  it("takes the payment snapshot from the given payment", async () => {
    const { order, invoiceId } = await openInvoice();
    const transfer = await payment(h.db, order.id, { provider: "bank_transfer", method: null, providerPaymentId: null });
    await markInvoicePaidInternal(tx(), ctxAt(h.db), { invoiceId, paidAt: new Date(), settledVia: "provider", paymentId: transfer.id, bankReference: "STMT-9" });
    expect(await invoiceRow(h.db, invoiceId)).toMatchObject({ paymentId: transfer.id, paymentProvider: "bank_transfer", paymentMethod: "bank_transfer", paymentTransactionRef: "STMT-9" });
  });

  it("refuses to settle a cancelled invoice", async () => {
    const { order, invoiceId } = await openInvoice();
    await issueCreditNote(tx(), ctxAt(h.db), { orderId: order.id, reason: "Cancelled", noRefund: true });
    await expect(markInvoicePaidInternal(tx(), ctxAt(h.db), { invoiceId, paidAt: new Date(), settledVia: "manual" })).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("markCreditNoteSettled", () => {
  it("settles the refund's credit note once and records credit_note.settled once", async () => {
    const { order } = await paidOrder(h.db);
    const pay = await payment(h.db, order.id, { amountCents: order.totalCents });
    const r = await issueInvoice(tx(), ctxAt(h.db), { orderId: order.id, paymentId: pay.id });
    if (r.status !== "issued") throw new Error("not issued");
    const ref = await refund(h.db, pay, order.totalCents);
    const cn = await issueCreditNote(tx(), ctxAt(h.db), { invoiceId: r.invoiceId, refundId: ref.id, reason: "Full refund" });
    await updateInvoiceState(tx(), cn.creditNoteId, { billitId: `billit_${cn.creditNoteId.slice(0, 8)}`, billitStatus: "synced" });

    const settledAt = new Date("2026-11-07T09:00:00Z");
    await markCreditNoteSettled(tx(), ctxAt(h.db), { refundId: ref.id, settledAt });
    await markCreditNoteSettled(tx(), ctxAt(h.db), { refundId: ref.id, settledAt: new Date() });
    const note = await invoiceRow(h.db, cn.creditNoteId);
    expect(note).toMatchObject({ status: "paid", settledVia: "provider", paymentId: pay.id, paymentMethod: "bancontact", billitPaymentStatus: "pending" });
    expect(note.paidAt?.toISOString()).toBe(settledAt.toISOString());
    expect((await eventsOf(h.db, "credit_note.settled")).filter((e) => e.refId === note.id)).toHaveLength(1);
    expect(await jobByKey(h.db, `billit:payment:${note.id}`)).toMatchObject({ kind: "billit.push_payment" });
  });

  it("is not_found for a refund without a credit note", async () => {
    await expect(markCreditNoteSettled(tx(), ctxAt(h.db), { refundId: "00000000-0000-4000-8000-000000000001", settledAt: new Date() })).rejects.toMatchObject({
      code: "not_found",
    });
  });
});
