/**
 * finance-P3 `finance.send_invoice_email` against a mocked `email.sendTransactional` (finance
 * section 10, email decision 6): the exact input, the job key as email key, the template per
 * document and reason, the attachment, and no `personId` for walk-in or erased documents.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { DbHandle } from "@beam/db";
import { reduceSnapshot, type FullCustomerSnapshot } from "@beam/core/finance";
import { templates as financeTemplates } from "@beam/email/templates/finance";
import { sql } from "@/lib/ctx";
import { runJobTwice } from "@/lib/testing";
import { issueCreditNote, issueInvoice, setOrderBillingDetails } from "./api";
import { invoiceEmailKey } from "./jobs";
import { asTx, ctxAt, invoiceRow, jobByKey, makeOrder, makeOrderLine, makePerson, paidOrder, setupDb } from "./service/__tests__/fixtures";

const sendTransactional = vi.hoisted(() => vi.fn());
vi.mock("@/modules/email/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/email/api")>()),
  sendTransactional,
}));
vi.mock("@/registry/jobs.generated", async (importOriginal) => {
  const mod = await importOriginal<{ JOB_BY_KIND: Record<string, unknown> }>();
  const added: Record<string, unknown> = {};
  for (const kind of ["billit.push_invoice", "billit.push_credit_note", "billit.push_payment", "billit.push_customer"]) {
    if (!mod.JOB_BY_KIND[kind]) added[kind] = { kind, lane: "fast", priority: 5, input: z.object({}).passthrough(), run: () => Promise.resolve(null) };
  }
  return { ...mod, JOB_BY_KIND: { ...mod.JOB_BY_KIND, ...added } };
});

let h: DbHandle;
beforeAll(async () => {
  h = await setupDb();
});
afterAll(() => h.close());
beforeEach(() => {
  sendTransactional.mockReset();
  sendTransactional.mockImplementation(() => Promise.resolve({ emailMessageId: "6f1c1f9e-0b7a-4c39-9a51-0d2b6f6f3a11", jobId: "7f1c1f9e-0b7a-4c39-9a51-0d2b6f6f3a11" }));
});

type SendInput = { template: string; personId?: string; to?: string; locale: string; data: Record<string, unknown>; key: string; attachments: unknown[] };
const lastCall = (): SendInput => sendTransactional.mock.calls.at(-1)![1] as SendInput;
const schemaOf = (template: string) => financeTemplates.find((tpl) => `finance.${tpl.name}` === template)!.props;

const render = (invoiceId: string) => runJobTwice(h.db, "finance.render_pdf", { invoiceId });
const send = (invoiceId: string, reason: string, to?: string) => runJobTwice(h.db, "finance.send_invoice_email", { invoiceId, reason, ...(to ? { to } : {}) });

async function companyInvoice() {
  const { order } = await paidOrder(h.db);
  await setOrderBillingDetails(asTx(h.db), ctxAt(h.db), {
    orderId: order.id,
    details: { isCompany: true, legalName: "Acme Wellness BV", vatNumber: "BE0123456749", address: { line1: "Kerkstraat 1", postal_code: "9000", city: "Gent", country: "BE" }, billingEmail: "billing@example.com" },
  });
  const r = await issueInvoice(asTx(h.db), ctxAt(h.db), { orderId: order.id });
  if (r.status !== "issued") throw new Error("not issued");
  await render(r.invoiceId);
  return { order, invoice: await invoiceRow(h.db, r.invoiceId) };
}

describe("finance.send_invoice_email -> email.sendTransactional", () => {
  it("passes { template, personId, to, locale, data, key, attachments } with key = the job key", async () => {
    const { order, invoice } = await companyInvoice();
    const job = await jobByKey(h.db, invoiceEmailKey(invoice.id, "issued"));
    expect(job).not.toBeNull();
    await send(invoice.id, "issued");

    expect(sendTransactional).toHaveBeenCalled();
    const input = lastCall();
    expect(Object.keys(input).sort()).toEqual(["attachments", "data", "key", "locale", "personId", "template", "to"]);
    expect(input).toMatchObject({
      template: "finance.invoice",
      personId: order.personId,
      to: "billing@example.com",
      locale: "nl-BE",
      key: job!.idempotencyKey,
      attachments: [{ fileId: invoice.pdfFileId, filename: `${invoice.number}.pdf` }],
    });
    expect(input.data).toMatchObject({ number: invoice.number, isCourtesyCopy: true });
    expect(schemaOf(input.template).safeParse(input.data).success).toBe(true);
    // ctx comes first, as email's signature says.
    expect(sendTransactional.mock.calls.at(-1)![0]).toHaveProperty("tx");
  });

  it("an open bank-transfer invoice carries due date, structured communication and IBAN in the person's language", async () => {
    const person = await makePerson(h.db, { locale: "fr-BE" });
    const order = await makeOrder(h.db, { channel: "admin", status: "pending_payment", personId: person.id, subtotalCents: 4_500, totalCents: 4_500 });
    await makeOrderLine(h.db, { orderId: order.id });
    const r = await issueInvoice(asTx(h.db), ctxAt(h.db), { orderId: order.id, status: "open" });
    if (r.status !== "issued") throw new Error("not issued");
    await render(r.invoiceId);
    const inv = await invoiceRow(h.db, r.invoiceId);
    expect(await jobByKey(h.db, invoiceEmailKey(inv.id, "issued"))).not.toBeNull();
    await send(inv.id, "issued");
    const input = lastCall();
    expect(input).toMatchObject({ template: "finance.invoice", personId: person.id, to: person.email, locale: "fr-BE" });
    expect(input.data).toMatchObject({ paymentReference: inv.paymentReference });
    expect(typeof input.data.dueOn).toBe("string");
    expect(input.data).not.toHaveProperty("isCourtesyCopy");
    expect(schemaOf(input.template).safeParse(input.data).success).toBe(true);

    await send(inv.id, "reminder:2026-11-25");
    expect(lastCall()).toMatchObject({ template: "finance.invoice_reminder", key: invoiceEmailKey(inv.id, "reminder:2026-11-25") });
    expect(schemaOf("finance.invoice_reminder").safeParse(lastCall().data).success).toBe(true);
  });

  it("a credit note uses finance.credit_note with its reason", async () => {
    const { invoice } = await companyInvoice();
    const cn = await issueCreditNote(asTx(h.db), ctxAt(h.db), { invoiceId: invoice.id, reason: "Reissued to company", noRefund: true });
    await render(cn.creditNoteId);
    await send(cn.creditNoteId, "issued");
    expect(lastCall()).toMatchObject({ template: "finance.credit_note", to: "billing@example.com", key: invoiceEmailKey(cn.creditNoteId, "issued") });
    expect(lastCall().data).toMatchObject({ number: cn.number, reason: "Reissued to company" });
    expect(schemaOf("finance.credit_note").safeParse(lastCall().data).success).toBe(true);
  });

  it("a walk-in document is sent without personId (staff resend to an address)", async () => {
    const order = await makeOrder(h.db, { channel: "pos", status: "paid", subtotalCents: 4_500, totalCents: 4_500 });
    await makeOrderLine(h.db, { orderId: order.id });
    const r = await issueInvoice(asTx(h.db), ctxAt(h.db), { orderId: order.id });
    if (r.status !== "issued") throw new Error("not issued");
    await render(r.invoiceId);

    await send(r.invoiceId, "issued");
    expect(sendTransactional).not.toHaveBeenCalled();

    await send(r.invoiceId, "resend:1", "desk@example.com");
    const input = lastCall();
    expect(input).not.toHaveProperty("personId");
    expect(input).toMatchObject({ template: "finance.invoice", to: "desk@example.com", locale: "nl-BE", key: invoiceEmailKey(r.invoiceId, "resend:1") });
  });

  it("an erased person's document is sent without personId and never to the old address", async () => {
    const { order } = await paidOrder(h.db);
    const r = await issueInvoice(asTx(h.db), ctxAt(h.db), { orderId: order.id });
    if (r.status !== "issued") throw new Error("not issued");
    await render(r.invoiceId);
    const before = await invoiceRow(h.db, r.invoiceId);
    const reduced = reduceSnapshot(before.customerSnapshot as FullCustomerSnapshot);
    await h.db.transaction(async (tx) => {
      await tx.execute(sql`set local beam.allow_rewrite = 'on'`);
      await tx.execute(sql`update invoices set person_id = null, customer_snapshot = ${JSON.stringify(reduced)}::jsonb where id = ${r.invoiceId}::uuid`);
    });

    await send(r.invoiceId, "resend:1");
    expect(sendTransactional).not.toHaveBeenCalled();

    await send(r.invoiceId, "resend:2", "new-address@example.com");
    const input = lastCall();
    expect(input).not.toHaveProperty("personId");
    expect(input.to).toBe("new-address@example.com");
  });
});
