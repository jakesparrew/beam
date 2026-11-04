/**
 * Test helpers of the finance-P4 suites (billit-jobs, sync-pending, reconcile, scan-overdue):
 * documents issued through finance's api on orders from commerce's factories, a stored PDF, the
 * finance settings row, and `runJob`, which runs one handler like the job runner does (its own
 * transaction, rolled back on error, durable writes and the integration log flushed afterwards).
 */
import type { Db } from "@beam/db";
import { makePerson, makeUser } from "@beam/db/testing";
import { makeOrder, makeOrderLine, makePaidOrder, type LineOverrides } from "@beam/db/testing/commerce-factories";
import { jobs, settings } from "@beam/db/schema";
import { FINANCE_SETTING_DEFAULT, type BillingDetails } from "@beam/core/finance";
import { eq, flushDurableWrites, flushIntegrationLog, sql } from "@/lib/ctx";
import { loadJobs, type JobCtx } from "@/lib/job-runner";
import { makeJobCtx, type FakeIntegrations } from "@/lib/testing";
import { storeFile } from "@/modules/platform/api";
import type { JobKind } from "@/registry/types.generated";
import { issueInvoice, setOrderBillingDetails } from "./api";
import { updateInvoiceState } from "./service/invoice-state";
import { asTx, ctxAt, NOW, payment } from "./service/__tests__/fixtures";

export { NOW };

/** Runs one job handler in its own transaction like the runner; returns the result or the error. */
export async function runJob(
  db: Db,
  kind: JobKind,
  payload: unknown,
  opts: { integrations: FakeIntegrations; now?: Date; key?: string },
): Promise<{ result?: unknown; error?: unknown }> {
  const def = (await loadJobs())[kind];
  if (!def) throw new Error(`unknown job kind ${kind}`);
  const input = def.input.parse(payload);
  let ctx: JobCtx | undefined;
  let result: unknown;
  let error: unknown;
  try {
    await db.transaction(async (tx) => {
      ctx = makeJobCtx(db, kind, { integrations: opts.integrations, tx: tx, ...(opts.now ? { now: opts.now } : {}), ...(opts.key ? { key: opts.key } : {}) });
      result = await def.run(ctx, input);
    });
  } catch (e) {
    error = e;
  }
  if (ctx) {
    await flushDurableWrites(db, ctx);
    await flushIntegrationLog(db, ctx);
  }
  return error === undefined ? { result } : { error };
}

/** Stores a PDF for the document and marks it rendered (what `finance.render_pdf` leaves). */
export async function withPdf(db: Db, invoiceId: string, number = "doc"): Promise<void> {
  const { fileId } = await storeFile(ctxAt(db), { kind: "invoice_pdf", name: `${number}.pdf`, mime: "application/pdf", bytes: new TextEncoder().encode("%PDF-1.4 test") });
  await updateInvoiceState(asTx(db), invoiceId, { pdfFileId: fileId, pdfStatus: "rendered" });
}

/** A paid B2C invoice (Bancontact) with its PDF. */
export async function paidB2c(db: Db, lines?: Omit<LineOverrides, "orderId">[], now: Date = NOW) {
  const person = await makePerson(db);
  const { order } = await makePaidOrder(db, { personId: person.id, ...(lines ? { lines } : {}) });
  const p = await payment(db, order.id, { amountCents: order.totalCents });
  const r = await issueInvoice(asTx(db), ctxAt(db, now), { orderId: order.id, paymentId: p.id });
  if (r.status !== "issued") throw new Error("not issued");
  await withPdf(db, r.invoiceId, r.number);
  return { invoiceId: r.invoiceId, number: r.number, orderId: order.id, personId: person.id, totalCents: order.totalCents };
}

/** A paid company invoice with a VAT number of `country` and its PDF. */
export async function paidCompany(db: Db, vatNumber = "BE0123456749", country = "BE") {
  const person = await makePerson(db);
  const { order } = await makePaidOrder(db, { personId: person.id });
  await payment(db, order.id, { amountCents: order.totalCents });
  const details: BillingDetails = { isCompany: true, legalName: "Acme Wellness BV", vatNumber, address: { line1: "Kerkstraat 1", postal_code: "9000", city: "Gent", country }, billingEmail: "billing@example.com" };
  await setOrderBillingDetails(asTx(db), ctxAt(db), { orderId: order.id, details });
  const r = await issueInvoice(asTx(db), ctxAt(db), { orderId: order.id });
  if (r.status !== "issued") throw new Error("not issued");
  await withPdf(db, r.invoiceId, r.number);
  return { invoiceId: r.invoiceId, number: r.number, orderId: order.id, personId: person.id };
}

/** An open bank-transfer invoice (staff order, `pending_payment`) with its PDF. */
export async function openInvoice(db: Db, opts: { totalCents?: number; dueOn?: string; now?: Date; personId?: string | null } = {}) {
  const total = opts.totalCents ?? 12_100;
  const personId = opts.personId === undefined ? (await makePerson(db)).id : opts.personId;
  const order = await makeOrder(db, { channel: "admin", status: "pending_payment", subtotalCents: total, totalCents: total, ...(personId ? { personId } : {}) });
  await makeOrderLine(db, { orderId: order.id, unitAmountCents: total, lineTotalCents: total, quantity: 1 });
  const r = await issueInvoice(asTx(db), ctxAt(db, opts.now ?? NOW), { orderId: order.id, status: "open", ...(opts.dueOn ? { dueOn: opts.dueOn } : {}) });
  if (r.status !== "issued") throw new Error("not issued");
  await withPdf(db, r.invoiceId, r.number);
  return { invoiceId: r.invoiceId, number: r.number, orderId: order.id, personId };
}

/** Writes the `finance` settings row with `overrides` on the default. */
export async function setFinanceSettings(db: Db, overrides: Partial<typeof FINANCE_SETTING_DEFAULT> = {}): Promise<void> {
  await db.delete(settings).where(eq(settings.key, "finance"));
  await db.insert(settings).values({ key: "finance", value: { ...FINANCE_SETTING_DEFAULT, ...overrides }, version: 1 });
}

/** An active staff user of the finance role (task owner for `crm.createTask`). */
export const financeUser = (db: Db) => makeUser(db, { roleKey: "finance" });

/** Jobs of `kind` (optionally for one invoice), oldest first. */
export async function jobsOf(db: Db, kind: string, invoiceId?: string) {
  const rows = await db.select().from(jobs).where(eq(jobs.kind, kind)).orderBy(sql`${jobs.createdAt}, ${jobs.idempotencyKey}`);
  return invoiceId ? rows.filter((r) => (r.payload as { invoiceId?: string }).invoiceId === invoiceId) : rows;
}

/** `notify.slack` jobs whose key starts with `slack:<fingerprint>`. */
export async function slackJobs(db: Db, fingerprint: string) {
  return db.select().from(jobs).where(sql`${jobs.idempotencyKey} like ${`slack:${fingerprint}:%`}`);
}
