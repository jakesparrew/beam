/**
 * finance-P2 `updateInvoiceState` (finance section 2.1 transition table, section 2.2 column
 * rules): every allowed transition, every refused one, the no-op repeat, and the database
 * trigger `invoices_guard_immutable()` refusing guarded columns when code is bypassed.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { invoices } from "@beam/db/schema";
import { INVOICE_STATUSES, INVOICE_TRANSITIONS, InvalidTransitionError, InvoiceImmutableError, type InvoiceStatus } from "@beam/core/finance";
import { eq } from "@/lib/ctx";
import { issueCreditNote, issueInvoice } from "../api";
import { asTx, ctxAt, invoiceRow, makeOrder, makeOrderLine, paidOrder, setupDb } from "./__tests__/fixtures";
import { updateInvoiceState } from "./invoice-state";

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

async function paidInvoice(): Promise<string> {
  const { order } = await paidOrder(h.db, [{ unitAmountCents: 2_000, quantity: 2 }]);
  const r = await issueInvoice(tx(), ctxAt(h.db), { orderId: order.id });
  if (r.status !== "issued") throw new Error("not issued");
  return r.invoiceId;
}

async function openInvoice(): Promise<string> {
  const order = await makeOrder(h.db, { subtotalCents: 4_500, totalCents: 4_500 });
  await makeOrderLine(h.db, { orderId: order.id });
  const r = await issueInvoice(tx(), ctxAt(h.db), { orderId: order.id, status: "open" });
  if (r.status !== "issued") throw new Error("not issued");
  return r.invoiceId;
}

/** A credit note of one unit of a paid invoice (the invoice stays paid). */
async function creditNote(): Promise<string> {
  const invoiceId = await paidInvoice();
  const inv = await invoiceRow(h.db, invoiceId);
  const cn = await issueCreditNote(tx(), ctxAt(h.db), {
    invoiceId,
    reason: "Correction",
    noRefund: true,
    lines: [{ orderLineId: inv.lines[0]!.order_line_id, quantity: 1 }],
  });
  return cn.creditNoteId;
}

const paidPatch = { paidAt: new Date("2026-11-05T10:00:00Z"), settledVia: "manual" as const };

describe("the transition table of section 2.1", () => {
  it("(new) -> paid and (new) -> open come from issueInvoice; (new) -> issued from issueCreditNote", async () => {
    expect((await invoiceRow(h.db, await paidInvoice())).status).toBe("paid");
    expect((await invoiceRow(h.db, await openInvoice())).status).toBe("open");
    expect((await invoiceRow(h.db, await creditNote())).status).toBe("issued");
  });

  it("invoice open -> paid", async () => {
    const id = await openInvoice();
    await updateInvoiceState(tx(), id, { status: "paid", ...paidPatch });
    expect(await invoiceRow(h.db, id)).toMatchObject({ status: "paid", settledVia: "manual" });
  });

  it("invoice open -> cancelled", async () => {
    const id = await openInvoice();
    await updateInvoiceState(tx(), id, { status: "cancelled" });
    expect((await invoiceRow(h.db, id)).status).toBe("cancelled");
  });

  it("invoice paid -> cancelled", async () => {
    const id = await paidInvoice();
    await updateInvoiceState(tx(), id, { status: "cancelled" });
    expect((await invoiceRow(h.db, id)).status).toBe("cancelled");
  });

  it("credit note issued -> paid", async () => {
    const id = await creditNote();
    await updateInvoiceState(tx(), id, { status: "paid", paidAt: paidPatch.paidAt, settledVia: "provider" });
    expect((await invoiceRow(h.db, id)).status).toBe("paid");
  });

  it("a repeated transition to the current status is a no-op", async () => {
    const id = await paidInvoice();
    const before = await invoiceRow(h.db, id);
    await updateInvoiceState(tx(), id, { status: "paid" });
    const after = await invoiceRow(h.db, id);
    expect(after.status).toBe("paid");
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });

  it("refuses every pair that is not in the table", async () => {
    const make: Record<string, () => Promise<string>> = {
      "invoice:paid": paidInvoice,
      "invoice:open": openInvoice,
      "invoice:cancelled": async () => {
        const id = await openInvoice();
        await updateInvoiceState(tx(), id, { status: "cancelled" });
        return id;
      },
      "credit_note:issued": creditNote,
      "credit_note:paid": async () => {
        const id = await creditNote();
        await updateInvoiceState(tx(), id, { status: "paid", paidAt: paidPatch.paidAt, settledVia: "provider" });
        return id;
      },
    };
    let refused = 0;
    for (const [state, create] of Object.entries(make)) {
      const [kind, from] = state.split(":") as ["invoice" | "credit_note", InvoiceStatus];
      for (const to of INVOICE_STATUSES) {
        if (to === from) continue;
        if (INVOICE_TRANSITIONS.some(([k, f, t]) => k === kind && f === from && t === to)) continue;
        const id = await create();
        await expect(updateInvoiceState(tx(), id, { status: to, ...paidPatch })).rejects.toBeInstanceOf(InvalidTransitionError);
        expect((await invoiceRow(h.db, id)).status).toBe(from);
        refused++;
      }
    }
    // 5 existing states x 3 other statuses, minus the 4 transitions of the table between existing states.
    expect(refused).toBe(11);
  });

  it("maps a refused transition to conflict", async () => {
    const id = await paidInvoice();
    await expect(updateInvoiceState(tx(), id, { status: "open" })).rejects.toMatchObject({ code: "conflict", message: "finance.errors.invalid_transition" });
  });
});

describe("column rules of section 2.2", () => {
  it("sets the settlement columns once and refuses to change them afterwards", async () => {
    const id = await paidInvoice();
    const inv = await invoiceRow(h.db, id);
    expect(inv.paymentMethod).toBeNull();
    await updateInvoiceState(tx(), id, { paymentMethod: "cash", paymentProvider: "cash" });
    await expect(updateInvoiceState(tx(), id, { paymentMethod: "bancontact" })).rejects.toBeInstanceOf(InvoiceImmutableError);
    expect((await invoiceRow(h.db, id)).paymentMethod).toBe("cash");
  });

  it("refreshes the seller snapshot only before the first render", async () => {
    const id = await paidInvoice();
    const inv = await invoiceRow(h.db, id);
    await updateInvoiceState(tx(), id, { sellerSnapshot: { ...inv.sellerSnapshot, iban: "BE68539007547034" } });
    expect((await invoiceRow(h.db, id)).sellerSnapshot.iban).toBe("BE68539007547034");
    await updateInvoiceState(tx(), id, { pdfStatus: "rendered" });
    await expect(updateInvoiceState(tx(), id, { sellerSnapshot: { ...inv.sellerSnapshot, iban: "" } })).rejects.toBeInstanceOf(InvoiceImmutableError);
  });

  it("refuses a field outside InvoiceMutableFields", async () => {
    const id = await paidInvoice();
    await expect(updateInvoiceState(tx(), id, { totalCents: 1 } as never)).rejects.toThrow(/not a mutable invoice field/);
  });

  it("updates the Billit and PDF bookkeeping columns", async () => {
    const id = await paidInvoice();
    await updateInvoiceState(tx(), id, { billitStatus: "failed", billitAttempts: 1, billitLastError: "503", billitFailedSince: new Date("2026-11-04T10:00:00Z") });
    expect(await invoiceRow(h.db, id)).toMatchObject({ billitStatus: "failed", billitAttempts: 1, billitLastError: "503" });
  });

  it("is not_found for an unknown id", async () => {
    await expect(updateInvoiceState(tx(), "00000000-0000-4000-8000-000000000000", { status: "paid" })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("the database trigger invoices_guard_immutable()", () => {
  it("refuses a guarded column written around updateInvoiceState", async () => {
    const id = await paidInvoice();
    await expect(h.db.update(invoices).set({ totalCents: 1, subtotalCents: 1, vatCents: 0 }).where(eq(invoices.id, id))).rejects.toThrow();
    await expect(h.db.update(invoices).set({ number: "BEAM-2026-999999" }).where(eq(invoices.id, id))).rejects.toThrow();
    expect((await invoiceRow(h.db, id)).totalCents).toBe(4_000);
  });

  it("refuses an invalid status change and a delete", async () => {
    const id = await paidInvoice();
    await expect(h.db.update(invoices).set({ status: "open", dueOn: "2026-12-01" }).where(eq(invoices.id, id))).rejects.toThrow();
    await expect(h.db.delete(invoices).where(eq(invoices.id, id))).rejects.toThrow();
    expect((await invoiceRow(h.db, id)).status).toBe("paid");
  });
});
