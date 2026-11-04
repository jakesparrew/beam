/**
 * finance-P5 back-office queries (finance spec 4.3): `listInvoices` filters (period, kind,
 * status, Billit status, B2B), search by exact number and by customer name, keyset pages;
 * `getFinanceOverview` counts; `getInvoice` with balance, credit notes and the reissue chain;
 * the Billit backlog, reconcile runs, company requests with the VAT check, and the invoicing
 * identity with its missing fields.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@beam/db";
import { billitReconcileRuns, invoiceRequests } from "@beam/db/schema";
import { makePaidOrder } from "@beam/db/testing/commerce-factories";
import { issueCreditNote, issueInvoice } from "./api";
import { openInvoice, paidB2c, paidCompany } from "./finance-p4.helpers";
import {
  getFinanceOverview,
  getInvoice,
  getInvoicingIdentity,
  getReconcileRun,
  listBillitBacklog,
  listCompanyInvoiceRequests,
  listInvoices,
  listReconcileRuns,
} from "./queries";
import { asTx, ctxAt, makePerson, NOW, payment, setupDb } from "./service/__tests__/fixtures";
import { updateInvoiceState } from "./service/invoice-state";
import { reissueToCompany } from "./service/reissue";

let h: DbHandle;
let b2c: Awaited<ReturnType<typeof paidB2c>>;
let company: Awaited<ReturnType<typeof paidCompany>>;
let open: Awaited<ReturnType<typeof openInvoice>>;
let creditNoteId: string;
let named: { invoiceId: string; number: string };

beforeAll(async () => {
  h = await setupDb();
  b2c = await paidB2c(h.db);
  company = await paidCompany(h.db);
  open = await openInvoice(h.db, { totalCents: 24_200, dueOn: "2026-10-01" });
  creditNoteId = (await issueCreditNote(asTx(h.db), ctxAt(h.db), { invoiceId: b2c.invoiceId, reason: "Correction", noRefund: true })).creditNoteId;
  const person = await makePerson(h.db, { firstName: "Zelda", lastName: "Vandenbroucke" });
  const { order } = await makePaidOrder(h.db, { personId: person.id });
  await payment(h.db, order.id, { amountCents: order.totalCents });
  const r = await issueInvoice(asTx(h.db), ctxAt(h.db), { orderId: order.id });
  if (r.status !== "issued") throw new Error("not issued");
  named = { invoiceId: r.invoiceId, number: r.number };
  await updateInvoiceState(asTx(h.db), company.invoiceId, { billitStatus: "failed", billitAttempts: 3, billitFailedSince: new Date(Date.now() - 2 * 3_600_000), billitLastError: "HTTP 503" });
});
afterAll(() => h.close());

const numbers = (rows: { number: string }[]) => rows.map((r) => r.number).sort();

describe("listInvoices", () => {
  it("lists every document newest first and filters by kind, status, Billit status and B2B", async () => {
    const all = await listInvoices(h.db);
    expect(all.rows).toHaveLength(5);
    expect(numbers((await listInvoices(h.db, { kind: "credit_note" })).rows)).toHaveLength(1);
    expect((await listInvoices(h.db, { kind: "credit_note" })).rows[0]).toMatchObject({ id: creditNoteId, kind: "credit_note" });
    expect((await listInvoices(h.db, { status: "open" })).rows.map((r) => r.id)).toEqual([open.invoiceId]);
    expect((await listInvoices(h.db, { status: "cancelled" })).rows.map((r) => r.id)).toEqual([b2c.invoiceId]);
    expect((await listInvoices(h.db, { billitStatus: "failed" })).rows.map((r) => r.id)).toEqual([company.invoiceId]);
    expect((await listInvoices(h.db, { isCompany: true })).rows.map((r) => r.id)).toEqual([company.invoiceId]);
    expect((await listInvoices(h.db, { isCompany: false })).rows).toHaveLength(4);
  });

  it("filters by period on issued_on", async () => {
    expect((await listInvoices(h.db, { from: "2026-11-04", to: "2026-11-04" })).rows).toHaveLength(5);
    expect((await listInvoices(h.db, { from: "2026-11-05" })).rows).toHaveLength(0);
    expect((await listInvoices(h.db, { to: "2026-11-03" })).rows).toHaveLength(0);
  });

  it("searches by exact number (any case) and by customer name", async () => {
    expect((await listInvoices(h.db, { q: named.number })).rows.map((r) => r.id)).toEqual([named.invoiceId]);
    expect((await listInvoices(h.db, { q: named.number.toLowerCase() })).rows.map((r) => r.id)).toEqual([named.invoiceId]);
    expect((await listInvoices(h.db, { q: "vandenbrou" })).rows.map((r) => r.id)).toEqual([named.invoiceId]);
    expect((await listInvoices(h.db, { q: "Acme" })).rows.map((r) => r.id)).toEqual([company.invoiceId]);
    expect((await listInvoices(h.db, { q: "no such customer" })).rows).toHaveLength(0);
    expect((await listInvoices(h.db, { q: "100%_" })).rows).toHaveLength(0);
  });

  it("pages with a keyset cursor without repeating or skipping rows", async () => {
    const first = await listInvoices(h.db, { limit: 2 });
    expect(first.rows).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await listInvoices(h.db, { limit: 2, cursor: first.nextCursor! });
    const third = await listInvoices(h.db, { limit: 2, cursor: second.nextCursor! });
    expect(third.nextCursor).toBeNull();
    const ids = [...first.rows, ...second.rows, ...third.rows].map((r) => r.id);
    expect(new Set(ids).size).toBe(5);
    expect(ids).toEqual((await listInvoices(h.db)).rows.map((r) => r.id));
  });

  it("reports the PDF state per row", async () => {
    const rows = (await listInvoices(h.db)).rows;
    expect(rows.find((r) => r.id === b2c.invoiceId)).toMatchObject({ pdfReady: true });
    expect(rows.find((r) => r.id === named.invoiceId)).toMatchObject({ pdfReady: false, pdfStatus: "pending" });
  });
});

describe("getFinanceOverview", () => {
  it("counts issued documents, open and overdue amounts, Billit backlog, PDF failures, requests and the last reconcile", async () => {
    await h.db.insert(invoiceRequests).values({ invoiceId: named.invoiceId, personId: null, billing: { isCompany: false, legalName: "Zelda V", address: { line1: "Straat 1", postal_code: "1000", city: "Brussel", country: "BE" } } });
    await h.db.insert(billitReconcileRuns).values({ runOn: "2026-11-03", startedAt: NOW, status: "ok", checkedCount: 4 });
    const o = await getFinanceOverview(h.db, { now: NOW });
    expect(o.documentCount).toBe(5);
    expect(o.today.count).toBe(4);
    expect(o.month.count).toBe(4);
    expect(o.open).toEqual({ count: 1, amountCents: 24_200 });
    expect(o.overdue).toEqual({ count: 1, amountCents: 24_200 });
    expect(o.billit).toEqual({ pending: 4, failed: 1, failing: 1 });
    expect(o.pdfFailed).toBe(0);
    expect(o.pendingRequests).toBe(1);
    expect(o.lastReconcile).toMatchObject({ runOn: "2026-11-03", status: "ok", issuesCount: 0 });
    // Net = invoices plus the credit note, excluding VAT.
    const docs = (await listInvoices(h.db)).rows;
    expect(docs.length).toBe(5);
    expect(o.today.netCents).toBeGreaterThan(0);
    expect((await getFinanceOverview(h.db, { now: new Date("2026-12-15T10:00:00Z") })).month.count).toBe(0);
  });
});

describe("getInvoice", () => {
  it("returns the document with balance, credit notes, order, payments and jobs; null for an unknown id", async () => {
    const d = await getInvoice(h.db, b2c.invoiceId);
    expect(d?.invoice.number).toBe(b2c.number);
    expect(d?.balance).toEqual({ creditedCents: b2c.totalCents, remainingCents: 0 });
    expect(d?.creditNotes.map((c) => c.id)).toEqual([creditNoteId]);
    expect(d?.order?.id).toBe(b2c.orderId);
    expect(d?.payments).toHaveLength(1);
    expect(d?.jobs.some((j) => j.kind === "finance.render_pdf")).toBe(true);
    const note = await getInvoice(h.db, creditNoteId);
    expect(note?.original?.id).toBe(b2c.invoiceId);
    expect(note?.balance).toBeNull();
    expect(await getInvoice(h.db, "00000000-0000-4000-8000-000000000000")).toBeNull();
    expect(await getInvoice(h.db, "not-a-uuid")).toBeNull();
  });

  it("links a reissued invoice both ways", async () => {
    const extra = await paidB2c(h.db);
    const out = await reissueToCompany(asTx(h.db), ctxAt(h.db), {
      invoiceId: extra.invoiceId,
      billing: { isCompany: true, legalName: "Nova Health BV", vatNumber: "BE0123456749", address: { line1: "Markt 2", postal_code: "3000", city: "Leuven", country: "BE" } },
      reason: "Reissued to company",
    });
    expect((await getInvoice(h.db, extra.invoiceId))?.replacedBy?.id).toBe(out.invoiceId);
    expect((await getInvoice(h.db, out.invoiceId))?.replaces?.id).toBe(extra.invoiceId);
  });
});

describe("sync, requests and settings queries", () => {
  it("lists the Billit backlog and reconcile runs", async () => {
    const failed = await listBillitBacklog(h.db, { status: "failed" });
    expect(failed.map((r) => r.id)).toEqual([company.invoiceId]);
    expect(failed[0]!.failingMinutes).toBeGreaterThanOrEqual(119);
    expect((await listBillitBacklog(h.db)).length).toBeGreaterThan(1);
    const runs = await listReconcileRuns(h.db);
    expect(runs[0]).toMatchObject({ runOn: "2026-11-03" });
    expect(await getReconcileRun(h.db, runs[0]!.id)).toMatchObject({ id: runs[0]!.id });
    expect(await getReconcileRun(h.db, "00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it("lists company requests with the invoice number and the VAT check", async () => {
    const extra = await paidB2c(h.db);
    await h.db.insert(invoiceRequests).values({
      invoiceId: extra.invoiceId,
      personId: extra.personId,
      billing: { isCompany: true, legalName: "Bad Checksum BV", vatNumber: "BE0123456700", address: { line1: "Plein 1", postal_code: "8000", city: "Brugge", country: "BE" } },
    });
    const rows = await listCompanyInvoiceRequests(h.db, { status: "requested" });
    const bad = rows.find((r) => r.invoiceId === extra.invoiceId);
    expect(bad).toMatchObject({ invoiceNumber: extra.number, vatCheck: "checksum", status: "requested" });
    expect(rows.find((r) => r.invoiceId === named.invoiceId)).toMatchObject({ vatCheck: "missing" });
    expect(await listCompanyInvoiceRequests(h.db, { status: "approved" })).toHaveLength(0);
  });

  it("returns the seller block with its missing fields and VAT note completeness", async () => {
    const id = await getInvoicingIdentity(h.db);
    expect(id.missing).toEqual(expect.arrayContaining(["finance.issuer.iban", "finance.issuer.bic", "finance.issuer.register_court"]));
    expect(id.footerComplete).toBe(true);
    expect(id.vatNotes).toEqual([{ category: "voucher", complete: true, missingLocales: [] }]);
    expect(id.settings.payment_terms_days).toBe(14);
  });
});
