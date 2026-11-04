/**
 * finance-P3 jobs: `finance.render_pdf` and `finance.send_invoice_email` (finance rules 36 to 39,
 * edge cases 16 and 23), each run twice with `runJobTwice`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { DbHandle } from "@beam/db";
import { emailMessages, files, jobs, settings } from "@beam/db/schema";
import { and, eq, flushDurableWrites, sql } from "@/lib/ctx";
import { loadJobs } from "@/lib/job-runner";
import { makeJobCtx, runJobTwice } from "@/lib/testing";
import { issueCreditNote, issueInvoice, setOrderBillingDetails } from "./api";
import { invoiceEmailKey } from "./jobs";
import { MissingCompanySettingsError } from "./pdf/render";
import { asTx, ctxAt, eventsOf, invoiceRow, jobByKey, makeOrder, makeOrderLine, paidOrder, payment, setupDb } from "./service/__tests__/fixtures";

const STUB_KINDS = ["billit.push_invoice", "billit.push_credit_note", "billit.push_payment", "billit.push_customer"];
vi.mock("@/registry/jobs.generated", async (importOriginal) => {
  const mod = await importOriginal<{ JOB_BY_KIND: Record<string, unknown> }>();
  const added: Record<string, unknown> = {};
  for (const kind of STUB_KINDS) {
    if (!mod.JOB_BY_KIND[kind]) added[kind] = { kind, lane: "fast", priority: 5, input: z.object({}).passthrough(), run: () => Promise.resolve(null) };
  }
  return { ...mod, JOB_BY_KIND: { ...mod.JOB_BY_KIND, ...added } };
});

let h: DbHandle;
beforeAll(async () => {
  h = await setupDb();
});
afterAll(() => h.close());
afterEach(() => {
  vi.unstubAllEnvs();
});

const COMPLETE_COMPANY = {
  legal_name: "Vibrant Lifestyle Collective BV",
  trade_name: "BEAM Vitality Center",
  vat_number: "BE0123456749",
  enterprise_number: "0123.456.749",
  address: { street: "Voorbeeldstraat 1", postal_code: "9000", city: "Gent", country: "BE" },
  support_email: "hello@demo.beam.be",
  phone: "+32 9 000 00 00",
  website: "https://beam.example.com",
};

async function setIssuer(complete: boolean) {
  const db = h.db;
  await db.delete(settings).where(eq(settings.key, "company"));
  await db.delete(settings).where(eq(settings.key, "finance"));
  if (!complete) return;
  await db.insert(settings).values({ key: "company", value: COMPLETE_COMPANY, version: 1 });
  const finance = (await import("@beam/core/finance")).FINANCE_SETTING_DEFAULT;
  await db.insert(settings).values({ key: "finance", value: { ...finance, issuer: { ...finance.issuer, register_court: "Gent", iban: "BE71096123456769", bic: "GKCCBEBB" } }, version: 1 });
}

async function issuedB2c() {
  const { order } = await paidOrder(h.db);
  await payment(h.db, order.id, { amountCents: order.totalCents });
  const r = await issueInvoice(asTx(h.db), ctxAt(h.db), { orderId: order.id });
  if (r.status !== "issued") throw new Error("not issued");
  return r.invoiceId;
}

async function issuedCompany() {
  const { order } = await paidOrder(h.db);
  await setOrderBillingDetails(asTx(h.db), ctxAt(h.db), {
    orderId: order.id,
    details: {
      isCompany: true,
      legalName: "Acme Wellness BV",
      vatNumber: "BE0123456749",
      address: { line1: "Kerkstraat 1", postal_code: "9000", city: "Gent", country: "BE" },
      billingEmail: "billing@example.com",
    },
  });
  const r = await issueInvoice(asTx(h.db), ctxAt(h.db), { orderId: order.id });
  if (r.status !== "issued") throw new Error("not issued");
  return r.invoiceId;
}

async function issuedWalkIn() {
  const order = await makeOrder(h.db, { channel: "pos", status: "paid", subtotalCents: 4_500, totalCents: 4_500 });
  await makeOrderLine(h.db, { orderId: order.id });
  const r = await issueInvoice(asTx(h.db), ctxAt(h.db), { orderId: order.id });
  if (r.status !== "issued") throw new Error("not issued");
  return r.invoiceId;
}

const render = (invoiceId: string) => runJobTwice(h.db, "finance.render_pdf", { invoiceId });
const pdfFiles = (name: string) => h.db.select().from(files).where(and(eq(files.kind, "invoice_pdf"), eq(files.name, name)));
const messagesByKey = (key: string) => h.db.select().from(emailMessages).where(eq(emailMessages.idempotencyKey, key));

/** One run of the render handler in its own transaction, like the runner (durable writes flushed after). */
async function renderOnce(invoiceId: string): Promise<unknown> {
  const def = (await loadJobs())["finance.render_pdf"]!;
  let ctx: ReturnType<typeof makeJobCtx> | undefined;
  try {
    return await h.db.transaction(async (tx) => {
      ctx = makeJobCtx(h.db, "finance.render_pdf", { tx });
      return def.run(ctx, { invoiceId });
    });
  } finally {
    if (ctx) await flushDurableWrites(h.db, ctx);
  }
}

describe("finance.render_pdf", () => {
  it("issueInvoice enqueues it under invoice_pdf:<id>", async () => {
    const id = await issuedB2c();
    expect(await jobByKey(h.db, `invoice_pdf:${id}`)).toMatchObject({ kind: "finance.render_pdf", payload: { invoiceId: id } });
  });

  it("renders once: two runs leave one file and the same state", async () => {
    const id = await issuedB2c();
    const { first, second } = await render(id);
    expect(first).toMatchObject({ status: "rendered" });
    expect(second).toMatchObject({ status: "already_rendered" });
    const inv = await invoiceRow(h.db, id);
    expect(inv.pdfStatus).toBe("rendered");
    const stored = await pdfFiles(`${inv.number}.pdf`);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id: inv.pdfFileId, mime: "application/pdf", personId: null });
    expect(Buffer.from(stored[0]!.bytes).subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("stores PDF metadata with title, author and language", async () => {
    const id = await issuedB2c();
    await render(id);
    const inv = await invoiceRow(h.db, id);
    const [file] = await pdfFiles(`${inv.number}.pdf`);
    const raw = Buffer.from(file!.bytes).toString("latin1");
    expect(raw).toContain(`Factuur ${inv.number}`);
    expect(raw).toContain(inv.sellerSnapshot.legal_name);
    expect(raw).toMatch(/\/Lang \(nl-BE\)/);
  });

  it("enqueues the Billit push of the invoice and of a credit note", async () => {
    const id = await issuedB2c();
    await render(id);
    expect(await jobByKey(h.db, `billit:invoice:${id}`)).toMatchObject({ kind: "billit.push_invoice", payload: { invoiceId: id } });
    const cn = await issueCreditNote(asTx(h.db), ctxAt(h.db), { invoiceId: id, reason: "Customer request", noRefund: true });
    await render(cn.creditNoteId);
    expect(await jobByKey(h.db, `billit:credit_note:${cn.creditNoteId}`)).toMatchObject({ kind: "billit.push_credit_note" });
  });

  it("queues the email for a company invoice and a credit note, not for a paid B2C invoice", async () => {
    const company = await issuedCompany();
    await render(company);
    expect(await jobByKey(h.db, invoiceEmailKey(company, "issued"))).toMatchObject({ kind: "finance.send_invoice_email", payload: { invoiceId: company, reason: "issued" } });

    const b2c = await issuedB2c();
    await render(b2c);
    expect(await jobByKey(h.db, invoiceEmailKey(b2c, "issued"))).toBeNull();

    const cn = await issueCreditNote(asTx(h.db), ctxAt(h.db), { invoiceId: b2c, reason: "Customer request", noRefund: true });
    await render(cn.creditNoteId);
    expect(await jobByKey(h.db, invoiceEmailKey(cn.creditNoteId, "issued"))).not.toBeNull();
  });

  it("production with placeholder company settings fails permanently and marks the PDF failed", async () => {
    await setIssuer(false);
    vi.stubEnv("APP_ENV", "production");
    const id = await issuedB2c();
    await expect(renderOnce(id)).rejects.toBeInstanceOf(MissingCompanySettingsError);
    const inv = await invoiceRow(h.db, id);
    expect(inv.pdfStatus).toBe("failed");
    expect(inv.pdfFileId).toBeNull();
    expect(await pdfFiles(`${inv.number}.pdf`)).toHaveLength(0);
    expect(await h.db.select().from(jobs).where(eq(jobs.idempotencyKey, `billit:invoice:${id}`))).toHaveLength(0);
  });

  it("re-render after the settings are completed refreshes seller_snapshot once, then renders", async () => {
    await setIssuer(false);
    vi.stubEnv("APP_ENV", "production");
    const id = await issuedB2c();
    expect((await invoiceRow(h.db, id)).sellerSnapshot.vat_number).toBe("BE0000000000");
    await expect(renderOnce(id)).rejects.toThrow(/missing_company_settings/);

    await setIssuer(true);
    const { first, second } = await render(id);
    expect(first).toMatchObject({ status: "rendered" });
    expect(second).toMatchObject({ status: "already_rendered" });
    const inv = await invoiceRow(h.db, id);
    expect(inv.pdfStatus).toBe("rendered");
    expect(inv.sellerSnapshot).toMatchObject({ vat_number: "BE0123456749", iban: "BE71096123456769", register_court: "Gent" });

    // A later settings change never touches the rendered document (rule 14).
    await h.db.update(settings).set({ value: { ...COMPLETE_COMPANY, vat_number: "BE0403170701" } }).where(eq(settings.key, "company"));
    await render(id);
    expect((await invoiceRow(h.db, id)).sellerSnapshot.vat_number).toBe("BE0123456749");
    await setIssuer(false);
  });

  it("never renders a document anonymised by the retention sweep", async () => {
    const id = await issuedB2c();
    await h.db.transaction(async (tx) => {
      await tx.execute(sql`set local beam.allow_rewrite = 'on'`);
      await tx.execute(sql`update invoices set person_id = null, customer_snapshot = '{"anonymised": true}'::jsonb where id = ${id}::uuid`);
    });
    const { first } = await render(id);
    expect(first).toMatchObject({ status: "skipped_anonymised" });
    expect((await invoiceRow(h.db, id)).pdfStatus).toBe("pending");
  });
});

describe("finance.send_invoice_email", () => {
  it("queues one message with the PDF for a company invoice, sets emailed_at and records invoice.emailed once", async () => {
    const id = await issuedCompany();
    await render(id);
    const { first, second } = await runJobTwice(h.db, "finance.send_invoice_email", { invoiceId: id, reason: "issued" });
    expect(first).toMatchObject({ status: "queued" });
    expect(second).toMatchObject({ status: "queued", emailMessageId: (first as { emailMessageId: string }).emailMessageId });

    const inv = await invoiceRow(h.db, id);
    const msgs = await messagesByKey(invoiceEmailKey(id, "issued"));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ toEmail: "billing@example.com", attachments: [{ fileId: inv.pdfFileId, filename: `${inv.number}.pdf` }] });
    expect(msgs[0]!.props).toMatchObject({ number: inv.number, isCourtesyCopy: true });
    expect(inv.emailedAt).not.toBeNull();
    expect((await eventsOf(h.db, "invoice.emailed")).filter((e) => e.refId === id)).toHaveLength(1);
  });

  it("an emailed_at set by the first run is not moved by the second", async () => {
    const id = await issuedCompany();
    await render(id);
    let after1: Date | null = null;
    await runJobTwice(h.db, "finance.send_invoice_email", { invoiceId: id, reason: "resend:1" }, {
      between: async () => {
        after1 = (await invoiceRow(h.db, id)).emailedAt;
      },
    });
    expect(after1).not.toBeNull();
    expect((await invoiceRow(h.db, id)).emailedAt?.getTime()).toBe((after1 as Date | null)?.getTime());
  });

  it("without a recipient it succeeds as skipped_no_recipient and leaves emailed_at null", async () => {
    const id = await issuedWalkIn();
    await render(id);
    const { first, second } = await runJobTwice(h.db, "finance.send_invoice_email", { invoiceId: id, reason: "issued" });
    expect(first).toEqual({ status: "skipped_no_recipient" });
    expect(second).toEqual({ status: "skipped_no_recipient" });
    expect((await invoiceRow(h.db, id)).emailedAt).toBeNull();
    expect(await messagesByKey(invoiceEmailKey(id, "issued"))).toHaveLength(0);
  });
});
