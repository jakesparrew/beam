/**
 * finance-P6 retention sweep handlers (finance rule 45, section 9, edge case 27): the
 * `finance.invoices` horizon of 3653 days from 1 January after the fiscal year with `anonymise`
 * and `delete`, the legal floor when the policy is edited below it, and the three plain delete
 * sweeps. ops' `privacy.retention_sweep` passes `cutoff = now - days`; the tests do the same.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db, DbHandle } from "@beam/db";
import { makePerson, makeUser } from "@beam/db/testing";
import { makePaidOrder } from "@beam/db/testing/commerce-factories";
import {
  billitReconcileRuns,
  companies,
  files,
  financeExports,
  invoiceRequests,
  invoiceSequences,
  invoices,
  orderBillingDetails,
  retentionPolicies,
} from "@beam/db/schema";
import { eq, inArray, setAppDb } from "@/lib/ctx";
import { logger } from "@/lib/logger";
import { resetRuntime } from "@/lib/testing";
import { issueCreditNote, issueInvoice, setOrderBillingDetails } from "../api";
import { withPdf } from "../finance-p4.helpers";
import { asTx, ctxAt, invoiceRow, payment, setupDb } from "./__tests__/fixtures";
import { sweep } from "./retention";

const DAY_MS = 86_400_000;
let h: DbHandle;

beforeAll(async () => {
  h = await setupDb();
  setAppDb(h.db);
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

const at = (iso: string) => new Date(`${iso}T10:00:00Z`);
const cutoffFor = (now: Date, days: number) => new Date(now.getTime() - days * DAY_MS);

async function setPolicy(db: Db, key: string, days: number, action: "anonymise" | "delete") {
  await db.delete(retentionPolicies).where(eq(retentionPolicies.key, key));
  await db.insert(retentionPolicies).values({ key, tableName: key.split(".")[1]!, days, action, description: "test" });
}

/** A paid company invoice issued on `day` (with a CRM company, billing details and a PDF). */
async function companyDoc(db: Db, day: string) {
  const person = await makePerson(db);
  const [company] = await db.insert(companies).values({ name: "Acme Wellness BV" }).returning();
  const { order } = await makePaidOrder(db, { personId: person.id, order: { companyId: company!.id } });
  const p = await payment(db, order.id, { amountCents: order.totalCents });
  await setOrderBillingDetails(asTx(db), ctxAt(db, at(day)), {
    orderId: order.id,
    details: { isCompany: true, legalName: "Acme Wellness BV", vatNumber: "BE0123456749", address: { line1: "Kerkstraat 1", postal_code: "9000", city: "Gent", country: "BE" }, billingEmail: "billing@example.com" },
  });
  const r = await issueInvoice(asTx(db), ctxAt(db, at(day)), { orderId: order.id, paymentId: p.id });
  if (r.status !== "issued") throw new Error("not issued");
  await withPdf(db, r.invoiceId, r.number);
  return { invoiceId: r.invoiceId, orderId: order.id, personId: person.id, companyId: company!.id };
}

/** A paid B2C invoice issued on `day` with its PDF. */
async function personDoc(db: Db, day: string) {
  const person = await makePerson(db);
  const { order } = await makePaidOrder(db, { personId: person.id });
  const p = await payment(db, order.id, { amountCents: order.totalCents });
  const r = await issueInvoice(asTx(db), ctxAt(db, at(day)), { orderId: order.id, paymentId: p.id });
  if (r.status !== "issued") throw new Error("not issued");
  await withPdf(db, r.invoiceId, r.number);
  return { invoiceId: r.invoiceId, orderId: order.id, personId: person.id };
}

const fileExists = async (id: string | null) => (id ? (await h.db.select({ id: files.id }).from(files).where(eq(files.id, id))).length === 1 : false);
const run = (key: keyof typeof sweep, cutoff: Date) => h.db.transaction((tx) => sweep[key](tx, cutoff));

describe("sweep['finance.invoices'] with anonymise", () => {
  it("anonymises fiscal years past 3653 days and keeps rows, totals, lines and numbers", async () => {
    await setPolicy(h.db, "finance.invoices", 3653, "anonymise");
    const old = await companyDoc(h.db, "2026-03-02");
    const young = await personDoc(h.db, "2027-02-01");
    const before = await invoiceRow(h.db, old.invoiceId);
    const youngBefore = await invoiceRow(h.db, young.invoiceId);

    // 1 January 2027 + 3653 days = 1 January 2037: the 2026 documents are due, 2027 is not.
    const now = at("2037-01-02");
    const count = await run("finance.invoices", cutoffFor(now, 3653));
    expect(count).toBeGreaterThanOrEqual(1);

    const after = await invoiceRow(h.db, old.invoiceId);
    expect(after).toMatchObject({ personId: null, companyId: null, customerSnapshot: { anonymised: true }, pdfFileId: null });
    expect(after.customerSnapshot).toEqual({ anonymised: true });
    expect({ number: after.number, lines: after.lines, total: after.totalCents, vat: after.vatCents, sub: after.subtotalCents, status: after.status }).toEqual({
      number: before.number,
      lines: before.lines,
      total: before.totalCents,
      vat: before.vatCents,
      sub: before.subtotalCents,
      status: before.status,
    });
    expect(await fileExists(before.pdfFileId)).toBe(false);
    expect(await h.db.select().from(orderBillingDetails).where(eq(orderBillingDetails.orderId, old.orderId))).toHaveLength(0);

    expect(await invoiceRow(h.db, young.invoiceId)).toEqual(youngBefore);
    expect(await fileExists(youngBefore.pdfFileId)).toBe(true);

    // A second run finds nothing left in the swept years.
    expect(await run("finance.invoices", cutoffFor(now, 3653))).toBe(0);
  });

  it("never goes below the legal floor: a policy edited below 3653 days is applied at the floor and logged", async () => {
    await setPolicy(h.db, "finance.invoices", 365, "anonymise");
    const doc = await personDoc(h.db, "2027-03-01");
    const before = await invoiceRow(h.db, doc.invoiceId);
    const warn = vi.spyOn(logger, "warn");
    // On 1 June 2028 a 365-day policy would reach fiscal 2027; the floor does not.
    const count = await run("finance.invoices", cutoffFor(at("2028-06-01"), 365));
    expect(count).toBe(0);
    expect(await invoiceRow(h.db, doc.invoiceId)).toEqual(before);
    const logged = warn.mock.calls.find(([o]) => (o as { status?: string }).status === "skipped_legal_floor");
    expect(logged?.[0]).toMatchObject({ key: "finance.invoices", status: "skipped_legal_floor" });
    expect((logged?.[0] as { count: number }).count).toBeGreaterThanOrEqual(1);
    warn.mockRestore();
  });
});

describe("sweep['finance.invoices'] with delete", () => {
  it("deletes a fiscal year past the horizon with its PDFs and billing details, keeps sequences and a chain with a newer credit note", async () => {
    await setPolicy(h.db, "finance.invoices", 3653, "delete");
    const gone = await companyDoc(h.db, "2028-04-01");
    const chained = await personDoc(h.db, "2028-05-01");
    const cn = await issueCreditNote(asTx(h.db), ctxAt(h.db, at("2029-01-15")), { invoiceId: chained.invoiceId, reason: "Correction", noRefund: true });
    const goneBefore = await invoiceRow(h.db, gone.invoiceId);
    const seqBefore = await h.db.select().from(invoiceSequences).where(eq(invoiceSequences.year, 2028));

    // 1 January 2029 + 3653 days = 1 January 2039: fiscal 2028 is due, 2029 is not.
    await run("finance.invoices", cutoffFor(at("2039-01-02"), 3653));

    expect(await h.db.select().from(invoices).where(eq(invoices.id, gone.invoiceId))).toHaveLength(0);
    expect(await fileExists(goneBefore.pdfFileId)).toBe(false);
    expect(await h.db.select().from(orderBillingDetails).where(eq(orderBillingDetails.orderId, gone.orderId))).toHaveLength(0);
    // The 2028 invoice that a 2029 credit note reverses stays with it.
    const kept = await h.db.select({ id: invoices.id }).from(invoices).where(inArray(invoices.id, [chained.invoiceId, cn.creditNoteId]));
    expect(kept).toHaveLength(2);
    expect(await h.db.select().from(invoiceSequences).where(eq(invoiceSequences.year, 2028))).toEqual(seqBefore);
  });
});

describe("the plain delete sweeps", () => {
  it("finance.invoice_requests: decided requests older than 730 days go, pending ones stay", async () => {
    await setPolicy(h.db, "finance.invoice_requests", 730, "delete");
    const doc = await personDoc(h.db, "2029-02-01");
    const billing = { isCompany: true, legalName: "Acme BV", vatNumber: "BE0123456749", address: { line1: "Kerkstraat 1", postal_code: "9000", city: "Gent", country: "BE" } };
    const now = at("2032-01-01");
    const old = new Date(now.getTime() - 800 * DAY_MS);
    const recent = new Date(now.getTime() - 100 * DAY_MS);
    const [decided] = await h.db.insert(invoiceRequests).values({ invoiceId: doc.invoiceId, personId: doc.personId, billing, status: "rejected", decidedAt: old, updatedAt: old }).returning();
    const [fresh] = await h.db.insert(invoiceRequests).values({ invoiceId: doc.invoiceId, personId: doc.personId, billing, status: "cancelled", updatedAt: recent }).returning();
    const [pending] = await h.db.insert(invoiceRequests).values({ invoiceId: doc.invoiceId, personId: doc.personId, billing, createdAt: old, updatedAt: old }).returning();
    const n = await run("finance.invoice_requests", cutoffFor(now, 730));
    expect(n).toBe(1);
    const left = (await h.db.select({ id: invoiceRequests.id }).from(invoiceRequests).where(eq(invoiceRequests.invoiceId, doc.invoiceId))).map((r) => r.id).sort();
    expect(left).toEqual([fresh!.id, pending!.id].sort());
    expect(left).not.toContain(decided!.id);
  });

  it("finance.billit_reconcile_runs and finance.finance_exports delete rows older than the cutoff", async () => {
    const now = at("2031-01-01");
    const old = new Date(now.getTime() - 500 * DAY_MS);
    await h.db.insert(billitReconcileRuns).values([
      { runOn: "2029-08-01", startedAt: old, status: "ok" },
      { runOn: "2030-12-30", startedAt: new Date(now.getTime() - 2 * DAY_MS), status: "ok" },
    ]);
    expect(await run("finance.billit_reconcile_runs", cutoffFor(now, 400))).toBe(1);
    expect(await h.db.select().from(billitReconcileRuns)).toHaveLength(1);

    const user = await makeUser(h.db);
    await h.db.insert(financeExports).values([
      { kind: "invoices", periodFrom: "2030-01-01", periodTo: "2030-01-31", requestedByUserId: user.id, createdAt: new Date(now.getTime() - 120 * DAY_MS) },
      { kind: "payments", periodFrom: "2030-11-01", periodTo: "2030-11-30", requestedByUserId: user.id, createdAt: new Date(now.getTime() - 5 * DAY_MS) },
    ]);
    expect(await run("finance.finance_exports", cutoffFor(now, 90))).toBe(1);
    const rest = await h.db.select({ kind: financeExports.kind }).from(financeExports);
    expect(rest).toEqual([{ kind: "payments" }]);
  });
});
