/**
 * finance's GDPR registration (finance spec section 9, architecture section 11, ops rule 62).
 * Facade read by `pnpm gen:indexes`; ops runs export, erase and the retention sweeps.
 * finance-P6 implements `export`, `erase` and the four `sweep` handlers (`service/retention.ts`).
 * finance passes no `retention`: ops seeds the finance retention rows (cross-module D37).
 *
 * - `export`: `finance/invoices.json` (every document of the person: snapshot, lines, totals,
 *   status, and its PDF as `{ fileId, name }`), `finance/billing_details.json` (the billing
 *   identities of the person's orders), `finance/invoice_requests.json` and
 *   `finance/billit_parties.json` (the Billit party ids).
 * - `erase` (runs under `SET LOCAL beam.allow_rewrite = 'on'`, after commerce): invoices are
 *   `retained_legal` (`person_id` null, snapshot reduced, PDFs kept); billing details are deleted;
 *   pending requests are cancelled and then every request of the person is deleted; Billit
 *   parties are anonymised (`person_id` null, `is_anonymised`, `snapshot_hash` of the reduced
 *   party). The report holds counts and actions only.
 */
import { createHash } from "node:crypto";
import type { Tx } from "@beam/db";
import { billitParties, invoiceRequests, invoices, orderBillingDetails } from "@beam/db/schema";
import { isAnonymisedSnapshot, reduceSnapshot, type CustomerSnapshot } from "@beam/core/finance";
import type { EraseReportRow, PrivacyExport, PrivacyRegistration } from "@beam/core/privacy";
import { and, asc, desc, eq, inArray, sql, type DbOrTx } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
// Relative until `@beam/core/finance` re-exports billit-mapping (open request of finance-P4).
import { toBillitParty } from "../../../../packages/core/src/finance/billit-mapping";
import { sweep } from "./service/retention";

const allowRewrite = (tx: DbOrTx) => tx.execute(sql`set local beam.allow_rewrite = 'on'`);
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** The orders whose billing details belong to the person: their own orders and those of their documents. */
async function personOrderIds(tx: DbOrTx, personId: string): Promise<string[]> {
  const rows = rowsOf<{ id: string }>(
    await tx.execute(sql`select id from orders where person_id = ${personId}
      union select order_id as id from invoices where person_id = ${personId}
      union select i.order_id as id from invoice_requests r join invoices i on i.id = r.invoice_id where r.person_id = ${personId}`),
  );
  return rows.map((r) => r.id);
}

async function exportPerson(tx: Tx, personId: string): Promise<PrivacyExport> {
  const docs = await tx.select().from(invoices).where(eq(invoices.personId, personId)).orderBy(asc(invoices.issuedAt), asc(invoices.number));
  const orderIds = await personOrderIds(tx, personId);
  const billing = orderIds.length ? await tx.select().from(orderBillingDetails).where(inArray(orderBillingDetails.orderId, orderIds)).orderBy(asc(orderBillingDetails.createdAt)) : [];
  const requests = await tx
    .select({ r: invoiceRequests, number: invoices.number })
    .from(invoiceRequests)
    .innerJoin(invoices, eq(invoices.id, invoiceRequests.invoiceId))
    .where(eq(invoiceRequests.personId, personId))
    .orderBy(asc(invoiceRequests.createdAt));
  const parties = await tx.select().from(billitParties).where(eq(billitParties.personId, personId)).orderBy(asc(billitParties.createdAt));
  return {
    "finance/invoices.json": docs.map((d) => ({
      number: d.number,
      kind: d.kind,
      status: d.status,
      issued_on: d.issuedOn,
      due_on: d.dueOn,
      paid_at: iso(d.paidAt),
      customer: d.customerSnapshot,
      lines: d.lines,
      subtotal_cents: d.subtotalCents,
      vat_cents: d.vatCents,
      total_cents: d.totalCents,
      vat_breakdown: d.vatBreakdown,
      payment_method: d.paymentMethod,
      payment_reference: d.paymentReference,
      reason: d.reason,
      pdf: d.pdfFileId ? { fileId: d.pdfFileId, name: `${d.number}.pdf` } : null,
    })),
    "finance/billing_details.json": billing.map((b) => ({
      order_id: b.orderId,
      is_company: b.isCompany,
      legal_name: b.legalName,
      vat_number: b.vatNumber,
      address: b.address,
      billing_email: b.billingEmail,
      purchase_order_ref: b.purchaseOrderRef,
      peppol_id: b.peppolId,
      created_at: iso(b.createdAt),
    })),
    "finance/invoice_requests.json": requests.map(({ r, number }) => ({
      invoice_number: number,
      status: r.status,
      billing: r.billing,
      created_at: iso(r.createdAt),
      decided_at: iso(r.decidedAt),
      decision_note: r.decisionNote,
    })),
    "finance/billit_parties.json": parties.map((p) => ({ billit_party_id: p.billitPartyId, synced_at: iso(p.syncedAt), is_anonymised: p.isAnonymised })),
  };
}

/** The hash `billit.push_customer` would store for the reduced party (no email or phone), so a later push sends only name and address. */
function reducedPartyHash(snapshot: CustomerSnapshot | null): string | null {
  if (!snapshot) return null;
  const payload = { ...toBillitParty(reduceSnapshot(snapshot)), Email: null, Phone: null, Mobile: null };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

async function erasePerson(tx: Tx, personId: string): Promise<EraseReportRow[]> {
  await allowRewrite(tx);
  const orderIds = await personOrderIds(tx, personId);

  // invoices: retained for accounting with the reduced snapshot (rule 45).
  const docs = await tx
    .select({ id: invoices.id, snapshot: invoices.customerSnapshot })
    .from(invoices)
    .where(eq(invoices.personId, personId))
    .orderBy(desc(invoices.issuedAt))
    .for("update");
  for (const d of docs) {
    const reduced = isAnonymisedSnapshot(d.snapshot) ? d.snapshot : reduceSnapshot(d.snapshot);
    await tx.update(invoices).set({ personId: null, customerSnapshot: reduced, updatedAt: sql`now()` }).where(eq(invoices.id, d.id));
  }

  // billit_parties: unlinked and anonymised (the Billit call was made by ops' privacy.erase_external).
  const parties = await tx.select({ id: billitParties.id }).from(billitParties).where(eq(billitParties.personId, personId));
  const hash = reducedPartyHash(docs[0]?.snapshot ?? null);
  if (parties.length) {
    await tx
      .update(billitParties)
      .set({ personId: null, isAnonymised: true, snapshotHash: hash, updatedAt: sql`now()` })
      .where(eq(billitParties.personId, personId));
  }

  // invoice_requests: pending ones cancelled, then every request of the person deleted.
  const cancelled = await tx
    .update(invoiceRequests)
    .set({ status: "cancelled", updatedAt: sql`now()` })
    .where(and(eq(invoiceRequests.personId, personId), eq(invoiceRequests.status, "requested")))
    .returning({ id: invoiceRequests.id });
  const deletedRequests = await tx.delete(invoiceRequests).where(eq(invoiceRequests.personId, personId)).returning({ id: invoiceRequests.id });

  // order_billing_details: deleted for every order of the person.
  const deletedBilling = orderIds.length
    ? await tx.delete(orderBillingDetails).where(inArray(orderBillingDetails.orderId, orderIds)).returning({ id: orderBillingDetails.id })
    : [];

  return [
    { table: "invoices", rows: docs.length, action: "retained_legal" },
    { table: "order_billing_details", rows: deletedBilling.length, action: "deleted" },
    { table: "invoice_requests", rows: cancelled.length, action: "cancelled" },
    { table: "invoice_requests", rows: deletedRequests.length, action: "deleted" },
    { table: "billit_parties", rows: parties.length, action: "anonymised" },
  ];
}

export const privacy: PrivacyRegistration<Tx> = {
  tables: ["invoices", "order_billing_details", "invoice_requests", "billit_parties"],
  export: exportPerson,
  erase: erasePerson,
  sweep,
};

/** The spec's name for the registration (finance spec section 9). */
export const financePrivacy = privacy;

/** finance tables that hold no person data (finance spec section 9). */
export const noPiiTables = ["invoice_sequences", "billit_reconcile_runs", "finance_exports"] as const;
