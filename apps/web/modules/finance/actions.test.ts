/**
 * finance-P5 staff actions (finance spec 4.2, rules 20, 25, 27, 29, 30a, 35, 38, 39; section 7
 * audit names): manual credit notes (with and without the no-refund flag; a full credit of an
 * `open` invoice goes through commerce's `cancelOrder`), reissue, mark paid, Billit retries with
 * new keys, reconcile now, PDF re-render, email resend, payment reminders (one per 7 days) and
 * the company invoice request decision. Commerce's `cancelOrder` and `recordBankTransferPaid`
 * are mocked; site's `getLegalLinks` is mocked so the decision email can be queued inside the
 * action's transaction on PGlite (OD-15).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { emailMessages, invoiceRequests, invoices } from "@beam/db/schema";
import { enqueueJob, eq, setAppDb } from "@/lib/ctx";
import { resetRuntime } from "@/lib/testing";
import { brusselsDay } from "./service/billit-sync";
import { asTx, invoiceRow, setupDb } from "./service/__tests__/fixtures";
import { openInvoice, paidB2c } from "./finance-p4.helpers";
import { auditRows, jobsWithKeyPrefix, killJob, signInStaff } from "./finance-p5.helpers";
import { updateInvoiceState } from "./service/invoice-state";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.44" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));
vi.mock("@/modules/site/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getLegalLinks: () => Promise.resolve({ privacy: null, terms: null, cookies: null, accessibility: null }),
}));
const commerce = vi.hoisted(() => ({
  cancelOrder: vi.fn((_tx: unknown, _ctx: unknown, _input: { orderId: string; reason: string }) => Promise.resolve({ cancelled: true })),
  recordBankTransferPaid: vi.fn((_tx: unknown, _ctx: unknown, _input: unknown) => Promise.resolve({ applied: true })),
}));
vi.mock("@/modules/commerce/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  cancelOrder: commerce.cancelOrder,
  recordBankTransferPaid: commerce.recordBankTransferPaid,
}));

const actions = await import("./actions");
const { issueCreditNote } = await import("./api");

let h: DbHandle;
beforeAll(async () => {
  h = await setupDb();
  setAppDb(h.db);
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  jar.clear();
  commerce.cancelOrder.mockClear();
  commerce.recordBankTransferPaid.mockClear();
  await signInStaff(jar, h.db, "finance");
});

const now = () => new Date();
const today = () => brusselsDay(now());
const ok = <T>(r: { ok: boolean; data?: T; error?: unknown }): T => {
  if (!r.ok) throw new Error(`action failed: ${JSON.stringify(r.error)}`);
  return r.data as T;
};
const creditNotesOf = (invoiceId: string) => h.db.select().from(invoices).where(eq(invoices.reversesInvoiceId, invoiceId));

describe("issueManualCreditNote", () => {
  it("needs the no-refund flag on a paid invoice; with it issues the credit note and audits it", async () => {
    const doc = await paidB2c(h.db, undefined, now());
    const refused = await actions.issueManualCreditNote({ invoiceId: doc.invoiceId, reason: "Correction", noRefund: false });
    expect(refused).toMatchObject({ ok: false, error: { code: "conflict", message: "finance.errors.no_refund_flag_required" } });
    expect(await creditNotesOf(doc.invoiceId)).toHaveLength(0);

    const out = ok(await actions.issueManualCreditNote({ invoiceId: doc.invoiceId, reason: "Correction", noRefund: true }));
    expect(out.number).toMatch(/^CN-\d{4}-\d{6}$/);
    expect(await creditNotesOf(doc.invoiceId)).toHaveLength(1);
    expect((await invoiceRow(h.db, doc.invoiceId)).status).toBe("cancelled");
    expect(commerce.cancelOrder).not.toHaveBeenCalled();
    const audit = await auditRows(h.db, "invoice.credit_note_issued", doc.invoiceId);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ entityType: "invoice", personId: doc.personId });
  });

  it("a full credit of an open invoice calls commerce.cancelOrder once and returns the credit note it created", async () => {
    const doc = await openInvoice(h.db, { now: now() });
    commerce.cancelOrder.mockImplementationOnce(async (tx, ctx, input) => {
      await issueCreditNote(tx as never, ctx as never, { orderId: input.orderId, reason: input.reason, noRefund: true });
      return { cancelled: true };
    });
    const out = ok(await actions.issueManualCreditNote({ invoiceId: doc.invoiceId, reason: "Order cancelled", noRefund: false }));
    expect(commerce.cancelOrder).toHaveBeenCalledTimes(1);
    expect(commerce.cancelOrder.mock.calls[0]![2]).toEqual({ orderId: doc.orderId, reason: "Order cancelled" });
    const notes = await creditNotesOf(doc.invoiceId);
    expect(notes).toHaveLength(1);
    expect(out).toEqual({ creditNoteId: notes[0]!.id, number: notes[0]!.number });
    expect((await invoiceRow(h.db, doc.invoiceId)).status).toBe("cancelled");
  });

  it("`{ cancelled: false }` from commerce gives order_not_cancellable and writes nothing", async () => {
    const doc = await openInvoice(h.db, { now: now() });
    commerce.cancelOrder.mockResolvedValueOnce({ cancelled: false });
    const r = await actions.issueManualCreditNote({ invoiceId: doc.invoiceId, reason: "Order cancelled", noRefund: true });
    expect(r).toMatchObject({ ok: false, error: { code: "conflict", message: "finance.errors.order_not_cancellable" } });
    expect(await creditNotesOf(doc.invoiceId)).toHaveLength(0);
    expect((await invoiceRow(h.db, doc.invoiceId)).status).toBe("open");
    expect(await auditRows(h.db, "invoice.credit_note_issued", doc.invoiceId)).toHaveLength(0);
  });

  it("a partial credit of an open invoice stays in finance and does not call commerce", async () => {
    const doc = await openInvoice(h.db, { totalCents: 12_100, now: now() });
    const inv = await invoiceRow(h.db, doc.invoiceId);
    const out = ok(
      await actions.issueManualCreditNote({ invoiceId: doc.invoiceId, reason: "Discount agreed", noRefund: false, lines: [{ orderLineId: inv.lines[0]!.order_line_id, amountCents: 2_100 }] }),
    );
    expect(commerce.cancelOrder).not.toHaveBeenCalled();
    expect(out.number).toMatch(/^CN-/);
    expect((await invoiceRow(h.db, doc.invoiceId)).status).toBe("open");
  });
});

describe("reissueInvoice", () => {
  it("issues a credit note and a new company invoice and cancels the original", async () => {
    const doc = await paidB2c(h.db, undefined, now());
    const billing = { isCompany: true, legalName: "Acme Wellness BV", vatNumber: "BE0123456749", address: { line1: "Kerkstraat 1", postal_code: "9000", city: "Gent", country: "BE" } };
    const out = ok(await actions.reissueInvoice({ invoiceId: doc.invoiceId, billing, reason: "Company invoice requested" }));
    const original = await invoiceRow(h.db, doc.invoiceId);
    const fresh = await invoiceRow(h.db, out.invoiceId);
    const note = await invoiceRow(h.db, out.creditNoteId);
    expect(original.status).toBe("cancelled");
    expect(note).toMatchObject({ kind: "credit_note", reversesInvoiceId: doc.invoiceId, totalCents: -original.totalCents });
    expect(fresh).toMatchObject({ kind: "invoice", status: "paid", replacesInvoiceId: doc.invoiceId, isCompany: true, totalCents: original.totalCents, number: out.number });
    expect(fresh.lines).toEqual(original.lines);
    expect(fresh.customerSnapshot).toMatchObject({ kind: "company", name: "Acme Wellness BV", vat_number: "BE0123456749" });
    expect(fresh.paidAt).toEqual(original.paidAt);
    expect(await auditRows(h.db, "invoice.reissued", doc.invoiceId)).toHaveLength(1);
    // A second reissue of the cancelled original is refused.
    expect(await actions.reissueInvoice({ invoiceId: doc.invoiceId, billing, reason: "Again" })).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
});

describe("markInvoicePaid", () => {
  it("refuses a future date and a date before issued_on", async () => {
    const doc = await openInvoice(h.db, { now: now() });
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    expect(await actions.markInvoicePaid({ invoiceId: doc.invoiceId, paidOn: tomorrow > today() ? tomorrow : "2099-01-01", note: "Bank" })).toMatchObject({
      ok: false,
      error: { code: "validation", message: "finance.errors.paid_on_future" },
    });
    expect(await actions.markInvoicePaid({ invoiceId: doc.invoiceId, paidOn: "2026-01-01", note: "Bank" })).toMatchObject({
      ok: false,
      error: { code: "validation", message: "finance.errors.paid_on_before_issue" },
    });
    expect(commerce.recordBankTransferPaid).not.toHaveBeenCalled();
  });

  it("settles the invoice manually, calls commerce once and is a no-op the second time", async () => {
    const doc = await openInvoice(h.db, { now: now() });
    ok(await actions.markInvoicePaid({ invoiceId: doc.invoiceId, paidOn: today(), bankReference: "BANK-123", note: "Seen on statement" }));
    const inv = await invoiceRow(h.db, doc.invoiceId);
    expect(inv).toMatchObject({ status: "paid", settledVia: "manual", paymentTransactionRef: "BANK-123", billitPaymentStatus: "not_applicable" });
    expect(commerce.recordBankTransferPaid).toHaveBeenCalledTimes(1);
    expect(commerce.recordBankTransferPaid.mock.calls[0]![2]).toEqual({ orderId: doc.orderId, paidOn: today(), reference: doc.number });
    expect(await jobsWithKeyPrefix(h.db, `billit:payment:${doc.invoiceId}`)).toHaveLength(0);

    expect(ok(await actions.markInvoicePaid({ invoiceId: doc.invoiceId, paidOn: today(), note: "Again" }))).toMatchObject({ changed: false });
    expect(commerce.recordBankTransferPaid).toHaveBeenCalledTimes(1);
    const audit = await auditRows(h.db, "invoice.marked_paid", doc.invoiceId);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ oldValue: { status: "open" }, newValue: expect.objectContaining({ status: "paid" }) });
  });

  it("after the Billit push enqueues billit.push_payment", async () => {
    const doc = await openInvoice(h.db, { now: now() });
    await updateInvoiceState(asTx(h.db), doc.invoiceId, { billitId: `bl-${doc.invoiceId.slice(0, 8)}`, billitStatus: "synced" });
    ok(await actions.markInvoicePaid({ invoiceId: doc.invoiceId, paidOn: today(), note: "Seen on statement" }));
    expect((await invoiceRow(h.db, doc.invoiceId)).billitPaymentStatus).toBe("pending");
    expect(await jobsWithKeyPrefix(h.db, `billit:payment:${doc.invoiceId}`)).toHaveLength(1);
  });
});

describe("Billit retries and reconcile", () => {
  it("retryBillitSync uses a new key after a dead push and does not queue twice while one is live", async () => {
    const doc = await paidB2c(h.db, undefined, now());
    await enqueueJob(h.db, { kind: "billit.push_invoice", payload: { invoiceId: doc.invoiceId }, key: `billit:invoice:${doc.invoiceId}` });
    await killJob(h.db, `billit:invoice:${doc.invoiceId}`);
    await updateInvoiceState(asTx(h.db), doc.invoiceId, { billitStatus: "failed", billitAttempts: 6, billitLastError: "HTTP 422" });

    const first = ok(await actions.retryBillitSync({ invoiceId: doc.invoiceId }));
    const second = ok(await actions.retryBillitSync({ invoiceId: doc.invoiceId }));
    expect(second.jobId).toBe(first.jobId);
    const keys = (await jobsWithKeyPrefix(h.db, `billit:invoice:${doc.invoiceId}`)).map((j) => j.idempotencyKey);
    expect(keys).toEqual([`billit:invoice:${doc.invoiceId}`, `billit:invoice:${doc.invoiceId}:r1`]);
    expect(await auditRows(h.db, "billit.retry", doc.invoiceId)).toHaveLength(2);
  });

  it("retryAllBillitFailed queues every failed document and runBillitReconcileNow takes a new manual key each time", async () => {
    const a = await paidB2c(h.db, undefined, now());
    await updateInvoiceState(asTx(h.db), a.invoiceId, { billitStatus: "failed" });
    const all = ok(await actions.retryAllBillitFailed({}));
    expect(all.count).toBeGreaterThanOrEqual(1);
    expect(await jobsWithKeyPrefix(h.db, `billit:invoice:${a.invoiceId}`)).toHaveLength(1);
    expect(await auditRows(h.db, "billit.retry_all")).not.toHaveLength(0);

    ok(await actions.runBillitReconcileNow({}));
    ok(await actions.runBillitReconcileNow({}));
    const keys = (await jobsWithKeyPrefix(h.db, `billit:reconcile:${today()}:manual:`)).map((j) => j.idempotencyKey).sort();
    expect(keys).toEqual([`billit:reconcile:${today()}:manual:1`, `billit:reconcile:${today()}:manual:2`]);
    expect(await auditRows(h.db, "billit.reconcile_requested")).toHaveLength(2);
  });
});

describe("PDF and emails", () => {
  it("rerenderInvoicePdf only takes failed PDFs and uses invoice_pdf:<id>:r<n>", async () => {
    const doc = await paidB2c(h.db, undefined, now());
    expect(await actions.rerenderInvoicePdf({ invoiceId: doc.invoiceId })).toMatchObject({ ok: false, error: { message: "finance.errors.pdf_not_blocked" } });
    await updateInvoiceState(asTx(h.db), doc.invoiceId, { pdfStatus: "failed" });
    await killJob(h.db, `invoice_pdf:${doc.invoiceId}`); // the issuing render died
    const out = ok(await actions.rerenderInvoicePdf({ invoiceId: doc.invoiceId }));
    expect(out.jobIds).toHaveLength(1);
    const keys = (await jobsWithKeyPrefix(h.db, `invoice_pdf:${doc.invoiceId}`)).map((j) => j.idempotencyKey);
    expect(keys).toContain(`invoice_pdf:${doc.invoiceId}:r1`);
    expect(await auditRows(h.db, "invoice.pdf_rerendered", doc.invoiceId)).toHaveLength(1);
  });

  it("resendInvoiceEmail queues resend:1 then resend:2, to the given address", async () => {
    const doc = await paidB2c(h.db, undefined, now());
    ok(await actions.resendInvoiceEmail({ invoiceId: doc.invoiceId, to: "accounts@example.com" }));
    ok(await actions.resendInvoiceEmail({ invoiceId: doc.invoiceId }));
    const rows = await jobsWithKeyPrefix(h.db, `invoice_email:${doc.invoiceId}:resend:`);
    expect(rows.map((j) => j.idempotencyKey).sort()).toEqual([`invoice_email:${doc.invoiceId}:resend:1`, `invoice_email:${doc.invoiceId}:resend:2`]);
    expect(rows.find((j) => j.idempotencyKey.endsWith(":1"))!.payload).toMatchObject({ reason: "resend:1", to: "accounts@example.com" });
    expect(await auditRows(h.db, "invoice.email_resent", doc.invoiceId)).toHaveLength(2);
  });

  it("sendPaymentReminder: only for overdue open invoices, at most once per 7 days", async () => {
    const notDue = await openInvoice(h.db, { now: now(), dueOn: "2099-01-01" });
    expect(await actions.sendPaymentReminder({ invoiceId: notDue.invoiceId })).toMatchObject({ ok: false, error: { message: "finance.errors.not_overdue" } });

    const doc = await openInvoice(h.db, { now: now(), dueOn: "2026-01-15" });
    ok(await actions.sendPaymentReminder({ invoiceId: doc.invoiceId }));
    expect(await actions.sendPaymentReminder({ invoiceId: doc.invoiceId })).toMatchObject({ ok: false, error: { code: "conflict", message: "finance.errors.reminder_too_soon" } });
    const rows = await jobsWithKeyPrefix(h.db, `invoice_email:${doc.invoiceId}:reminder:`);
    expect(rows.map((j) => j.idempotencyKey)).toEqual([`invoice_email:${doc.invoiceId}:reminder:${today()}`]);
    expect(await auditRows(h.db, "invoice.reminder_sent", doc.invoiceId)).toHaveLength(1);

    const paid = await paidB2c(h.db, undefined, now());
    expect(await actions.sendPaymentReminder({ invoiceId: paid.invoiceId })).toMatchObject({ ok: false, error: { message: "finance.errors.not_open" } });
  });
});

describe("decideCompanyInvoiceRequest", () => {
  const billing = { isCompany: true, legalName: "Studio Noord BV", vatNumber: "BE0123456749", address: { line1: "Noordlaan 5", postal_code: "2000", city: "Antwerpen", country: "BE" } };

  it("approve reissues to the requested company and queues the decision email", async () => {
    const doc = await paidB2c(h.db, undefined, now());
    const [req] = await h.db.insert(invoiceRequests).values({ invoiceId: doc.invoiceId, personId: doc.personId, billing }).returning();
    const out = ok(await actions.decideCompanyInvoiceRequest({ requestId: req!.id, decision: "approve" }));
    expect(out.status).toBe("approved");
    const [after] = await h.db.select().from(invoiceRequests).where(eq(invoiceRequests.id, req!.id));
    expect(after).toMatchObject({ status: "approved", newInvoiceId: out.newInvoiceId });
    expect(after!.decidedAt).not.toBeNull();
    expect(await invoiceRow(h.db, out.newInvoiceId!)).toMatchObject({ replacesInvoiceId: doc.invoiceId, isCompany: true });
    expect((await invoiceRow(h.db, doc.invoiceId)).status).toBe("cancelled");
    const mails = await h.db.select().from(emailMessages).where(eq(emailMessages.idempotencyKey, `invoice_request:${req!.id}:decided`));
    expect(mails).toHaveLength(1);
    expect(await auditRows(h.db, "invoice_request.approved", req!.id)).toHaveLength(1);
    // A decided request cannot be decided again.
    expect(await actions.decideCompanyInvoiceRequest({ requestId: req!.id, decision: "reject" })).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("reject keeps the invoice and stores the note", async () => {
    const doc = await paidB2c(h.db, undefined, now());
    const [req] = await h.db.insert(invoiceRequests).values({ invoiceId: doc.invoiceId, personId: doc.personId, billing }).returning();
    ok(await actions.decideCompanyInvoiceRequest({ requestId: req!.id, decision: "reject", note: "VAT number does not match the company" }));
    const [after] = await h.db.select().from(invoiceRequests).where(eq(invoiceRequests.id, req!.id));
    expect(after).toMatchObject({ status: "rejected", decisionNote: "VAT number does not match the company", newInvoiceId: null });
    expect((await invoiceRow(h.db, doc.invoiceId)).status).toBe("paid");
    expect(await auditRows(h.db, "invoice_request.rejected", req!.id)).toHaveLength(1);
  });
});
