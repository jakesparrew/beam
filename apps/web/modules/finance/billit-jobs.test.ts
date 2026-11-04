/**
 * finance-P4 Billit jobs against the Billit fake (finance rules 30 to 34, edge cases 7 to 10, 24,
 * 29): push, lost response, failure bookkeeping, credit note ordering, Peppol, payment
 * registration, anonymisation, the disabled switch and the double run of every handler.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@beam/db";
import { billitParties, persons, settings, tasks } from "@beam/db/schema";
import { BILLIT_PAYMENT_METHOD_CODES } from "@beam/integrations/billit";
import { eq } from "@/lib/ctx";
import { createFakeIntegrations, runJobTwice, type FakeIntegrations } from "@/lib/testing";
import { BILLIT_PAYMENT_METHOD_CODES as CORE_CODES } from "@beam/core/finance";
import { issueCreditNote } from "./api";
import { financeUser, jobsOf, openInvoice, paidB2c, paidCompany, runJob, setFinanceSettings, slackJobs, withPdf } from "./finance-p4.helpers";
import { asTx, ctxAt, invoiceRow, NOW, setupDb } from "./service/__tests__/fixtures";
import { markInvoicePaidInternal } from "./service/settle";

let h: DbHandle;
/** One fake for the file: its ids (`billit_<n>`) stay unique like the database's. */
const fakes: FakeIntegrations = createFakeIntegrations();
beforeAll(async () => {
  h = await setupDb();
  await financeUser(h.db);
});
afterAll(() => h.close());
afterEach(async () => {
  await h.db.delete(settings).where(eq(settings.key, "finance"));
});

const billit = fakes.billit;
const orderOf = (number: string) => billit.snapshot().orders.filter((o) => o.OrderNumber === number);
const callCount = () => billit.calls.length;
const callsSince = (from: number, operation: string) => billit.calls.slice(from).filter((c) => c.operation === operation);
const run = (kind: Parameters<typeof runJob>[1], payload: unknown) => runJob(h.db, kind, payload, { integrations: fakes, now: NOW });
const push = (invoiceId: string, kind: "billit.push_invoice" | "billit.push_credit_note" = "billit.push_invoice") => run(kind, { invoiceId });

describe("billit.push_invoice", () => {
  it("creates the party and the order, stores billit_id; a paid document is created with Paid = true", async () => {
    const doc = await paidB2c(h.db);
    expect((await push(doc.invoiceId)).result).toMatchObject({ status: "synced" });
    const inv = await invoiceRow(h.db, doc.invoiceId);
    const [order] = orderOf(doc.number);
    expect(orderOf(doc.number)).toHaveLength(1);
    expect(inv).toMatchObject({ billitId: order!.OrderID, billitStatus: "synced", billitPaymentStatus: "synced", billitLastError: null, billitFailedSince: null });
    expect(order!.input).toMatchObject({ OrderNumber: doc.number, Reference: doc.number, Paid: true, PaidDate: "2026-11-04", PaymentMethod: BILLIT_PAYMENT_METHOD_CODES.card });
    expect(order!.input.Attachments?.[0]).toMatchObject({ FileName: `${doc.number}.pdf`, MimeType: "application/pdf" });
    expect(Math.round(order!.TotalIncl * 100)).toBe(doc.totalCents);
    const [party] = await h.db.select().from(billitParties).where(eq(billitParties.partyKey, `person:${doc.personId}`));
    expect(party).toMatchObject({ personId: doc.personId, billitPartyId: order!.input.Customer.PartyID });
    expect(party!.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await jobsOf(h.db, "billit.send_peppol", doc.invoiceId)).toHaveLength(0);
  });

  it("a lost response creates no duplicate: the retry finds the order by reference", async () => {
    const doc = await paidB2c(h.db);
    billit.loseResponseNext("createOrder");
    expect((await push(doc.invoiceId)).error).toMatchObject({ retryable: true, code: "timeout" });
    expect((await invoiceRow(h.db, doc.invoiceId)).billitStatus).toBe("failed");
    expect((await push(doc.invoiceId)).result).toMatchObject({ status: "synced" });
    expect(orderOf(doc.number)).toHaveLength(1);
    expect((await invoiceRow(h.db, doc.invoiceId)).billitId).toBe(orderOf(doc.number)[0]!.OrderID);
  });

  it("records failure columns and keeps billit_failed_since across attempts; success clears the streak", async () => {
    const doc = await paidB2c(h.db);
    billit.failNext("createOrder", { status: 503 });
    expect((await push(doc.invoiceId)).error).toMatchObject({ retryable: true, statusCode: 503 });
    const a = await invoiceRow(h.db, doc.invoiceId);
    expect(a).toMatchObject({ billitStatus: "failed", billitAttempts: 1 });
    expect(a.billitLastError).toMatch(/^503: /);
    expect(a.billitFailedSince).toBeInstanceOf(Date);

    billit.failNext("createOrder", { status: 400 });
    expect((await push(doc.invoiceId)).error).toMatchObject({ retryable: false, statusCode: 400 });
    const b = await invoiceRow(h.db, doc.invoiceId);
    expect(b).toMatchObject({ billitStatus: "failed", billitAttempts: 2 });
    expect(b.billitFailedSince!.getTime()).toBe(a.billitFailedSince!.getTime());

    await push(doc.invoiceId);
    expect(await invoiceRow(h.db, doc.invoiceId)).toMatchObject({ billitStatus: "synced", billitFailedSince: null, billitLastError: null, billitAttempts: 2 });
  });

  it("401 is permanent and raises the billit-auth alert once per hour", async () => {
    const doc = await paidB2c(h.db);
    billit.failNext(null, { status: 401 });
    billit.failNext(null, { status: 401 });
    expect((await push(doc.invoiceId)).error).toMatchObject({ retryable: false, code: "auth" });
    await push(doc.invoiceId);
    expect(await slackJobs(h.db, "billit-auth")).toHaveLength(1);
    expect((await invoiceRow(h.db, doc.invoiceId)).billitAttempts).toBe(2);
  });

  it("with billit_enabled = false succeeds without calling Billit and leaves pending", async () => {
    await setFinanceSettings(h.db, { billit_enabled: false });
    const doc = await paidB2c(h.db);
    const from = callCount();
    expect((await push(doc.invoiceId)).result).toEqual({ status: "disabled" });
    expect(callCount()).toBe(from);
    expect((await invoiceRow(h.db, doc.invoiceId)).billitStatus).toBe("pending");
  });
});

describe("billit.push_credit_note", () => {
  it("waits for the original (and queues its push), then references it", async () => {
    const doc = await paidB2c(h.db);
    const cn = await issueCreditNote(asTx(h.db), ctxAt(h.db), { invoiceId: doc.invoiceId, reason: "Correction", noRefund: true });
    await withPdf(h.db, cn.creditNoteId, cn.number);
    const waiting = await push(cn.creditNoteId, "billit.push_credit_note");
    expect(String(waiting.error)).toContain("original_not_synced");
    expect((await jobsOf(h.db, "billit.push_invoice", doc.invoiceId)).length).toBeGreaterThan(0);
    expect(orderOf(cn.number)).toHaveLength(0);

    await push(doc.invoiceId);
    expect((await push(cn.creditNoteId, "billit.push_credit_note")).result).toMatchObject({ status: "synced" });
    const [credit] = orderOf(cn.number);
    expect(credit!.input).toMatchObject({ OrderType: "CreditNote", AboutInvoiceNumber: doc.number });
    expect(Math.round(credit!.TotalIncl * 100)).toBe(-cn.totalCents);
  });
});

describe("billit.send_peppol", () => {
  it("company documents only: push queues send_peppol, which sets peppol_status = sent", async () => {
    const doc = await paidCompany(h.db, "BE0123456749");
    await push(doc.invoiceId);
    expect(await jobsOf(h.db, "billit.send_peppol", doc.invoiceId)).toHaveLength(1);
    expect((await run("billit.send_peppol", { invoiceId: doc.invoiceId })).result).toEqual({ status: "sent" });
    expect((await invoiceRow(h.db, doc.invoiceId)).peppolStatus).toBe("sent");
  });

  it("a Peppol failure for a BE buyer: failed, High alert, follow_up task and the courtesy email", async () => {
    const doc = await paidCompany(h.db, "BE0403170701", "BE");
    billit.setPeppolReachable("BE0403170701", false);
    await push(doc.invoiceId);
    expect((await run("billit.send_peppol", { invoiceId: doc.invoiceId })).result).toEqual({ status: "failed" });
    expect((await invoiceRow(h.db, doc.invoiceId)).peppolStatus).toBe("failed");
    expect(await slackJobs(h.db, `peppol-failed:${doc.invoiceId}`)).toHaveLength(1);
    const [task] = await h.db.select().from(tasks).where(eq(tasks.dedupeKey, `invoice:${doc.invoiceId}:peppol_task`));
    expect(task).toMatchObject({ kind: "follow_up", priority: "high", title: `Fix Peppol delivery ${doc.number}`, refType: "invoice", refId: doc.invoiceId, personId: doc.personId });
    expect(task!.dueAt).toEqual(new Date("2026-11-05T09:00:00Z"));
    expect((await jobsOf(h.db, "finance.send_invoice_email", doc.invoiceId)).map((j) => j.idempotencyKey)).toContain(`invoice_email:${doc.invoiceId}:peppol_fallback`);
  });

  it("for an NL buyer only the email: no alert, no task", async () => {
    const doc = await paidCompany(h.db, "NL123456789B01", "NL");
    billit.setPeppolReachable("NL123456789B01", false);
    await push(doc.invoiceId);
    expect((await run("billit.send_peppol", { invoiceId: doc.invoiceId })).result).toEqual({ status: "failed" });
    expect(await slackJobs(h.db, `peppol-failed:${doc.invoiceId}`)).toHaveLength(0);
    expect(await h.db.select().from(tasks).where(eq(tasks.dedupeKey, `invoice:${doc.invoiceId}:peppol_task`))).toHaveLength(0);
    expect((await jobsOf(h.db, "finance.send_invoice_email", doc.invoiceId)).map((j) => j.idempotencyKey)).toContain(`invoice_email:${doc.invoiceId}:peppol_fallback`);
  });
});

describe("billit.push_payment", () => {
  it("mark paid after the push registers the payment once", async () => {
    const doc = await openInvoice(h.db);
    await push(doc.invoiceId);
    expect((await invoiceRow(h.db, doc.invoiceId)).billitPaymentStatus).toBe("not_applicable");
    await markInvoicePaidInternal(asTx(h.db), ctxAt(h.db), { invoiceId: doc.invoiceId, paidAt: NOW, settledVia: "manual", bankReference: "BANK-1" });
    expect((await invoiceRow(h.db, doc.invoiceId)).billitPaymentStatus).toBe("pending");
    expect(await jobsOf(h.db, "billit.push_payment", doc.invoiceId)).toHaveLength(1);

    await runJobTwice(h.db, "billit.push_payment", { invoiceId: doc.invoiceId }, { integrations: fakes });
    const [order] = orderOf(doc.number);
    expect(order!.payments).toEqual([{ paidOn: "2026-11-04", amountCents: 12_100, method: BILLIT_PAYMENT_METHOD_CODES.transfer, reference: "BANK-1" }]);
    expect(order!.Paid).toBe(true);
    expect((await invoiceRow(h.db, doc.invoiceId)).billitPaymentStatus).toBe("synced");
  });

  it("mark paid before the push: the payment job waits, the push creates it paid, then the job is a no-op", async () => {
    const doc = await openInvoice(h.db);
    await markInvoicePaidInternal(asTx(h.db), ctxAt(h.db), { invoiceId: doc.invoiceId, paidAt: NOW, settledVia: "manual" });
    expect(String((await run("billit.push_payment", { invoiceId: doc.invoiceId })).error)).toContain("not_synced");
    await push(doc.invoiceId);
    expect(orderOf(doc.number)[0]!.input).toMatchObject({ Paid: true, PaymentMethod: BILLIT_PAYMENT_METHOD_CODES.transfer });
    expect((await invoiceRow(h.db, doc.invoiceId)).billitPaymentStatus).toBe("synced");
    const from = callCount();
    expect((await run("billit.push_payment", { invoiceId: doc.invoiceId })).result).toEqual({ status: "noop" });
    expect(callsSince(from, "registerPayment")).toHaveLength(0);
    expect(orderOf(doc.number)[0]!.payments).toHaveLength(0);
  });

  it("a failed registration sets billit_payment_status = failed", async () => {
    const doc = await openInvoice(h.db);
    await push(doc.invoiceId);
    await markInvoicePaidInternal(asTx(h.db), ctxAt(h.db), { invoiceId: doc.invoiceId, paidAt: NOW, settledVia: "manual" });
    billit.failNext("registerPayment", { status: 500 });
    expect((await run("billit.push_payment", { invoiceId: doc.invoiceId })).error).toMatchObject({ retryable: true });
    expect((await invoiceRow(h.db, doc.invoiceId)).billitPaymentStatus).toBe("failed");
  });
});

describe("parties", () => {
  it("push_customer skips an unchanged party and pushes a changed one; anonymiseCustomer clears email and phone", async () => {
    const doc = await paidB2c(h.db);
    await push(doc.invoiceId);
    const key = `person:${doc.personId}`;
    expect((await run("billit.push_customer", { partyKey: key })).result).toMatchObject({ status: expect.stringMatching(/^(pushed|unchanged)$/) });
    expect((await run("billit.push_customer", { partyKey: key })).result).toMatchObject({ status: "unchanged" });
    await h.db.update(persons).set({ phone: "+32 470 99 99 99" }).where(eq(persons.id, doc.personId));
    const changed = (await run("billit.push_customer", { partyKey: key })).result as { status: string; partyId: string };
    expect(changed.status).toBe("pushed");
    const party = () => billit.snapshot().parties.find((p) => p.PartyID === changed.partyId)!;
    expect(party().Phone).toBe("+32 470 99 99 99");
    expect(billit.snapshot().parties.filter((p) => p.ExternalProviderID === key)).toHaveLength(1);

    await billit.anonymiseCustomer(changed.partyId);
    expect(party()).toMatchObject({ Email: null, Phone: null, Mobile: null, anonymised: true });
    expect(party().Name).toBeTruthy();
  });

  it("push_customer without a party is a no-op", async () => {
    expect((await run("billit.push_customer", { partyKey: "person:00000000-0000-4000-8000-000000000999" })).result).toEqual({ status: "no_party" });
  });
});

describe("double runs", () => {
  it("every Billit handler run twice leaves the same state", async () => {
    const doc = await paidCompany(h.db, "BE0123456749");
    const twice = (kind: Parameters<typeof runJobTwice>[1], payload: unknown) => runJobTwice(h.db, kind, payload, { integrations: fakes });
    const from = callCount();
    await twice("billit.push_invoice", { invoiceId: doc.invoiceId });
    const afterPush = await invoiceRow(h.db, doc.invoiceId);
    expect(orderOf(doc.number)).toHaveLength(1);
    await twice("billit.send_peppol", { invoiceId: doc.invoiceId });
    expect(callsSince(from, "sendOrder")).toHaveLength(1);
    await twice("billit.push_payment", { invoiceId: doc.invoiceId });
    await twice("billit.push_customer", { partyKey: `person:${doc.personId}` });
    await twice("billit.sync_pending", {});
    await twice("billit.reconcile", {});
    await twice("finance.scan_overdue", {});
    const after = await invoiceRow(h.db, doc.invoiceId);
    expect({ ...after, updatedAt: null, peppolStatus: null }).toEqual({ ...afterPush, updatedAt: null, peppolStatus: null });
    expect(after.peppolStatus).toBe("sent");
    expect(orderOf(doc.number)).toHaveLength(1);
    expect(callsSince(from, "createOrder")).toHaveLength(1);
  });
});

it("the payment-method codes of the mapping and the client agree", () => {
  expect(CORE_CODES).toEqual(BILLIT_PAYMENT_METHOD_CODES);
});
