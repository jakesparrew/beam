/**
 * finance-P2 `issueCreditNote` (finance rules 21 to 25, edge cases 6, 21, 30).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { invoices } from "@beam/db/schema";
import { computeLineVat, reduceSnapshot, type InvoiceRecord } from "@beam/core/finance";
import { and, eq, sql } from "@/lib/ctx";
import { issueCreditNote, issueInvoice } from "../api";
import { asTx, ctxAt, eventsOf, invoiceRow, jobByKey, lastNumber, makeOrder, makeOrderLine, paidOrder, payment, refund, setupDb } from "./__tests__/fixtures";

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
const credit = (input: Parameters<typeof issueCreditNote>[2]) => issueCreditNote(tx(), ctxAt(h.db), input);

/** A paid invoice of `lines` with its Mollie payment. */
async function paidInvoice(lines?: Parameters<typeof paidOrder>[1]) {
  const { order } = await paidOrder(h.db, lines);
  const pay = await payment(h.db, order.id, { amountCents: order.totalCents });
  const r = await issueInvoice(tx(), ctxAt(h.db), { orderId: order.id, paymentId: pay.id });
  if (r.status !== "issued") throw new Error("not issued");
  return { order, pay, invoice: await invoiceRow(h.db, r.invoiceId) };
}

const creditNotesOf = (invoiceId: string) =>
  h.db.select().from(invoices).where(and(eq(invoices.reversesInvoiceId, invoiceId), eq(invoices.kind, "credit_note"))) as Promise<InvoiceRecord[]>;

describe("issueCreditNote", () => {
  it("credits a full refund, numbers it CN-2026-000001 in its own series and cancels the invoice", async () => {
    const { pay, invoice } = await paidInvoice([{ unitAmountCents: 2_000, quantity: 2 }, { unitAmountCents: 1_500 }]);
    const invoicesBefore = await lastNumber(h.db, "invoice", 2026);
    const ref = await refund(h.db, pay, invoice.totalCents);
    const cn = await credit({ invoiceId: invoice.id, refundId: ref.id, reason: "Full refund" });
    expect(cn).toMatchObject({ number: "CN-2026-000001", totalCents: -invoice.totalCents });

    const note = await invoiceRow(h.db, cn.creditNoteId);
    expect(note).toMatchObject({
      kind: "credit_note",
      status: "issued",
      reversesInvoiceId: invoice.id,
      refundId: ref.id,
      orderId: invoice.orderId,
      personId: invoice.personId,
      reason: "Full refund",
      subtotalCents: -invoice.subtotalCents,
      vatCents: -invoice.vatCents,
      locale: invoice.locale,
    });
    expect(note.customerSnapshot).toEqual(invoice.customerSnapshot);
    expect(note.lines.map((l) => [l.quantity, l.line_total_cents])).toEqual([
      [-2, -4_000],
      [-1, -1_500],
    ]);
    expect((await invoiceRow(h.db, invoice.id)).status).toBe("cancelled");
    expect(await lastNumber(h.db, "invoice", 2026)).toBe(invoicesBefore);
    expect(await jobByKey(h.db, `invoice_pdf:${note.id}`)).toMatchObject({ kind: "finance.render_pdf" });
    const events = (await eventsOf(h.db, "credit_note.issued")).filter((e) => e.refId === note.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toEqual({ credit_note_id: note.id, number: "CN-2026-000001", invoice_number: invoice.number, total_cents: -invoice.totalCents, refund_id: ref.id });
  });

  it("issues one credit note per refund id", async () => {
    const { pay, invoice } = await paidInvoice();
    const ref = await refund(h.db, pay, 1_000);
    const line = invoice.lines[0]!.order_line_id;
    const first = await credit({ invoiceId: invoice.id, refundId: ref.id, reason: "Partial refund", lines: [{ orderLineId: line, amountCents: 1_000 }] });
    const again = await credit({ invoiceId: invoice.id, refundId: ref.id, reason: "Partial refund", lines: [{ orderLineId: line, amountCents: 1_000 }] });
    expect(again).toEqual(first);
    expect(await creditNotesOf(invoice.id)).toHaveLength(1);
  });

  it("handles two partial refunds and cancels the invoice once they reach its total", async () => {
    const { pay, invoice } = await paidInvoice([{ unitAmountCents: 1_000, quantity: 3 }, { unitAmountCents: 2_000 }]);
    const [a, b] = invoice.lines;
    const r1 = await refund(h.db, pay, 1_000);
    const cn1 = await credit({ invoiceId: invoice.id, refundId: r1.id, reason: "One unit", lines: [{ orderLineId: a!.order_line_id, quantity: 1 }] });
    expect(cn1.totalCents).toBe(-1_000);
    const r2 = await refund(h.db, pay, 500);
    const cn2 = await credit({ invoiceId: invoice.id, refundId: r2.id, reason: "Goodwill", lines: [{ orderLineId: b!.order_line_id, amountCents: 500 }] });
    expect(cn2.totalCents).toBe(-500);
    expect((await invoiceRow(h.db, invoice.id)).status).toBe("paid");

    const r3 = await refund(h.db, pay, 3_500);
    const cn3 = await credit({ invoiceId: invoice.id, refundId: r3.id, reason: "The rest" });
    expect(cn3.totalCents).toBe(-3_500);
    expect((await invoiceRow(h.db, invoice.id)).status).toBe("cancelled");
    const notes = await creditNotesOf(invoice.id);
    expect(notes.reduce((s, n) => s + n.totalCents, 0)).toBe(-invoice.totalCents);
  });

  it("refuses an over-credit with credit_exceeds_invoice and writes nothing", async () => {
    const { pay, invoice } = await paidInvoice();
    const line = invoice.lines[0]!.order_line_id;
    const before = await lastNumber(h.db, "credit_note", 2026);
    const ref = await refund(h.db, pay, 4_000);
    await expect(
      credit({ invoiceId: invoice.id, refundId: ref.id, reason: "Too much", lines: [{ orderLineId: line, amountCents: invoice.totalCents + 1 }] }),
    ).rejects.toMatchObject({ code: "conflict", message: "finance.errors.credit_exceeds_invoice" });
    await credit({ invoiceId: invoice.id, refundId: ref.id, reason: "Most of it", lines: [{ orderLineId: line, amountCents: 4_000 }] });
    const ref2 = await refund(h.db, pay, 501);
    await expect(
      credit({ invoiceId: invoice.id, refundId: ref2.id, reason: "Overlap", lines: [{ orderLineId: line, amountCents: 501 }] }),
    ).rejects.toMatchObject({ message: "finance.errors.credit_exceeds_invoice" });
    expect(await creditNotesOf(invoice.id)).toHaveLength(1);
    expect(await lastNumber(h.db, "credit_note", 2026)).toBe((before ?? 0) + 1);
  });

  it("sums a line credited in three quantity parts to its gross exactly", async () => {
    const { invoice } = await paidInvoice([{ unitAmountCents: 1_000, quantity: 3, discountCents: 1 }]);
    const line = invoice.lines[0]!;
    expect(line.line_total_cents).toBe(2_999);
    const parts: number[] = [];
    for (let i = 0; i < 3; i++) {
      const cn = await credit({ invoiceId: invoice.id, reason: `Part ${i + 1}`, noRefund: true, lines: [{ orderLineId: line.order_line_id, quantity: 1 }] });
      parts.push(cn.totalCents);
    }
    expect(parts).toEqual([-1_000, -1_000, -999]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(-2_999);
    const notes = await creditNotesOf(invoice.id);
    for (const n of notes) {
      expect(n.vatCents).toBe(computeLineVat(n.totalCents, 21).vatCents);
      expect(n.subtotalCents + n.vatCents).toBe(n.totalCents);
    }
    expect((await invoiceRow(h.db, invoice.id)).status).toBe("cancelled");
  });

  it("credits by amount with one line of quantity -1, the line's rate and the partial-credit label", async () => {
    const { invoice } = await paidInvoice([{ unitAmountCents: 10_000 }]);
    const line = invoice.lines[0]!;
    const cn = await credit({ invoiceId: invoice.id, reason: "Price correction", noRefund: true, lines: [{ orderLineId: line.order_line_id, amountCents: 1_210 }] });
    const note = await invoiceRow(h.db, cn.creditNoteId);
    const vat = computeLineVat(-1_210, 21);
    expect(note.lines).toHaveLength(1);
    expect(note.lines[0]).toMatchObject({ quantity: -1, unit_amount_cents: 1_210, discount_cents: 0, line_total_cents: -1_210, vat_rate_pct: 21, vat_cents: vat.vatCents, net_cents: vat.netCents });
    expect(note.lines[0]!.description).not.toBe(line.description);
    expect(note.lines[0]!.description.endsWith(line.description)).toBe(true);
    expect(note.vatBreakdown).toEqual([{ vat_rate_pct: 21, net_cents: vat.netCents, vat_cents: vat.vatCents, gross_cents: -1_210 }]);
  });

  it("copies the reduced snapshot of an erased person and records no event", async () => {
    const { invoice } = await paidInvoice();
    await h.db.transaction(async (t) => {
      await t.execute(sql`set local beam.allow_rewrite = 'on'`);
      await t.update(invoices).set({ personId: null, customerSnapshot: reduceSnapshot(invoice.customerSnapshot) }).where(eq(invoices.id, invoice.id));
    });
    const cn = await credit({ invoiceId: invoice.id, reason: "Refund after erasure", noRefund: true });
    const note = await invoiceRow(h.db, cn.creditNoteId);
    expect(note.personId).toBeNull();
    expect(note.customerSnapshot).toMatchObject({ is_reduced: true, email: null, phone: null, person_id: null });
    expect((await eventsOf(h.db, "credit_note.issued")).filter((e) => e.refId === note.id)).toHaveLength(0);
  });

  it("fully credits an open invoice for { orderId, noRefund: true } and cancels it", async () => {
    const order = await makeOrder(h.db, { subtotalCents: 4_500, totalCents: 4_500 });
    await makeOrderLine(h.db, { orderId: order.id });
    const open = await issueInvoice(tx(), ctxAt(h.db), { orderId: order.id, status: "open" });
    if (open.status !== "issued") throw new Error("not issued");
    const cn = await credit({ orderId: order.id, reason: "Order cancelled", noRefund: true });
    expect(cn.totalCents).toBe(-4_500);
    expect((await invoiceRow(h.db, open.invoiceId)).status).toBe("cancelled");
    expect((await invoiceRow(h.db, cn.creditNoteId)).reversesInvoiceId).toBe(open.invoiceId);
    await expect(credit({ orderId: order.id, reason: "Again", noRefund: true })).rejects.toMatchObject({ code: "not_found" });
  });

  it("allows a partial correction of an open invoice without the flag, but not of a paid one", async () => {
    const order = await makeOrder(h.db, { subtotalCents: 4_500, totalCents: 4_500 });
    await makeOrderLine(h.db, { orderId: order.id });
    const open = await issueInvoice(tx(), ctxAt(h.db), { orderId: order.id, status: "open" });
    if (open.status !== "issued") throw new Error("not issued");
    const inv = await invoiceRow(h.db, open.invoiceId);
    await credit({ invoiceId: inv.id, reason: "Discount agreed", lines: [{ orderLineId: inv.lines[0]!.order_line_id, amountCents: 500 }] });
    expect((await invoiceRow(h.db, inv.id)).status).toBe("open");

    const { invoice } = await paidInvoice();
    await expect(credit({ invoiceId: invoice.id, reason: "No refund" })).rejects.toMatchObject({ code: "conflict", message: "finance.errors.no_refund_flag_required" });
  });

  it("refuses a reason shorter than 3 characters and a refund of another order", async () => {
    const { invoice } = await paidInvoice();
    await expect(credit({ invoiceId: invoice.id, reason: " x ", noRefund: true })).rejects.toMatchObject({ code: "validation" });
    const other = await paidInvoice();
    const ref = await refund(h.db, other.pay, 100);
    await expect(credit({ invoiceId: invoice.id, refundId: ref.id, reason: "Wrong order" })).rejects.toMatchObject({ code: "not_found" });
  });
});
