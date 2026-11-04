/**
 * finance-P6 privacy registration (finance spec section 9, rule 45, scenario 7 at module level):
 * the export lists documents with their PDFs, billing details, requests and Billit parties; the
 * erasure keeps documents with the reduced snapshot, deletes billing details and requests and
 * anonymises the Billit party; afterwards no finance row references the person and the report
 * holds counts and actions only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@beam/db";
import { makePaidOrder } from "@beam/db/testing/commerce-factories";
import { billitParties, invoiceRequests, invoices, orderBillingDetails, persons } from "@beam/db/schema";
import { eq, inArray, setAppDb, sql } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { resetRuntime } from "@/lib/testing";
import { GDPR_REGISTRY, NO_PII_TABLES } from "@/registry/privacy.generated";
import { getBillitCustomerRef, issueInvoice, setOrderBillingDetails } from "./api";
import { paidB2c, withPdf } from "./finance-p4.helpers";
import { financePrivacy, noPiiTables, privacy } from "./privacy";
import { asTx, ctxAt, invoiceRow, payment, setupDb } from "./service/__tests__/fixtures";

let h: DbHandle;
beforeAll(async () => {
  h = await setupDb();
  setAppDb(h.db);
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

/** A person with a B2C invoice, a company invoice with billing details, a pending request and a Billit party. */
async function subject() {
  const b2c = await paidB2c(h.db);
  const personId = b2c.personId;
  const { order } = await makePaidOrder(h.db, { personId });
  await payment(h.db, order.id, { amountCents: order.totalCents });
  await setOrderBillingDetails(asTx(h.db), ctxAt(h.db), {
    orderId: order.id,
    details: { isCompany: true, legalName: "Acme Wellness BV", vatNumber: "BE0123456749", address: { line1: "Kerkstraat 1", postal_code: "9000", city: "Gent", country: "BE" }, billingEmail: "billing@example.com" },
  });
  const company = await issueInvoice(asTx(h.db), ctxAt(h.db), { orderId: order.id });
  if (company.status !== "issued") throw new Error("not issued");
  await withPdf(h.db, company.invoiceId, company.number);
  await h.db.insert(invoiceRequests).values({
    invoiceId: b2c.invoiceId,
    personId,
    billing: { isCompany: true, legalName: "Other Company BV", vatNumber: "BE0123456749", address: { line1: "Markt 2", postal_code: "2000", city: "Antwerpen", country: "BE" } },
  });
  const partyId = `PARTY-${personId.slice(0, 8)}`;
  await h.db.insert(billitParties).values({ partyKey: `person:${personId}`, personId, billitPartyId: partyId, snapshotHash: "abc" });
  const [person] = await h.db.select().from(persons).where(eq(persons.id, personId));
  return { personId, partyId, person: person!, b2c, companyInvoiceId: company.invoiceId, companyOrderId: order.id, b2cOrderId: b2c.orderId };
}

describe("financePrivacy", () => {
  it("is the registration the generated registry carries, with the four tables and the four sweep keys", () => {
    expect(financePrivacy).toBe(privacy);
    expect(GDPR_REGISTRY.finance).toBe(privacy);
    expect([...privacy.tables].sort()).toEqual(["billit_parties", "invoice_requests", "invoices", "order_billing_details"]);
    expect(Object.keys(privacy.sweep ?? {}).sort()).toEqual(["finance.billit_reconcile_runs", "finance.finance_exports", "finance.invoice_requests", "finance.invoices"]);
    for (const t of noPiiTables) expect(NO_PII_TABLES).toContain(t);
  });

  it("export lists the documents with their PDFs, the billing details, the requests and the Billit party", async () => {
    const s = await subject();
    const out = await h.db.transaction((tx) => privacy.export(tx, s.personId));
    const docs = out["finance/invoices.json"] as { number: string; pdf: { fileId: string; name: string } | null; customer: unknown; lines: unknown[] }[];
    expect(docs).toHaveLength(2);
    for (const d of docs) {
      expect(d.pdf).toMatchObject({ name: `${d.number}.pdf` });
      expect(d.lines.length).toBeGreaterThan(0);
    }
    expect(out["finance/billing_details.json"]).toEqual([expect.objectContaining({ order_id: s.companyOrderId, legal_name: "Acme Wellness BV", vat_number: "BE0123456749" })]);
    expect(out["finance/invoice_requests.json"]).toEqual([expect.objectContaining({ invoice_number: s.b2c.number, status: "requested" })]);
    expect(out["finance/billit_parties.json"]).toEqual([expect.objectContaining({ billit_party_id: s.partyId })]);
  });

  it("erase keeps the documents reduced, deletes billing details and requests, anonymises the Billit party", async () => {
    const s = await subject();
    expect(await getBillitCustomerRef(h.db, s.personId)).toBe(s.partyId);
    const pdfBefore = (await invoiceRow(h.db, s.b2c.invoiceId)).pdfFileId;

    const report = await h.db.transaction((tx) => privacy.erase(tx, s.personId));

    for (const id of [s.b2c.invoiceId, s.companyInvoiceId]) {
      const doc = await invoiceRow(h.db, id);
      expect(doc.personId).toBeNull();
      expect(doc.customerSnapshot).toMatchObject({ is_reduced: true, email: null, phone: null, person_id: null, company_id: null });
    }
    expect((await invoiceRow(h.db, s.companyInvoiceId)).customerSnapshot).toMatchObject({ kind: "company", name: "Acme Wellness BV", vat_number: "BE0123456749" });
    expect((await invoiceRow(h.db, s.b2c.invoiceId)).pdfFileId).toBe(pdfBefore);
    expect(await h.db.select().from(orderBillingDetails).where(inArray(orderBillingDetails.orderId, [s.companyOrderId, s.b2cOrderId]))).toHaveLength(0);
    expect(await h.db.select().from(invoiceRequests).where(eq(invoiceRequests.invoiceId, s.b2c.invoiceId))).toHaveLength(0);
    const [party] = await h.db.select().from(billitParties).where(eq(billitParties.partyKey, `person:${s.personId}`));
    expect(party).toMatchObject({ personId: null, isAnonymised: true, billitPartyId: s.partyId });
    expect(party!.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await getBillitCustomerRef(h.db, s.personId)).toBeNull();

    // No finance row references the person afterwards, by column or inside a snapshot.
    for (const table of ["invoices", "invoice_requests", "billit_parties"]) {
      const [row] = rowsOf<{ n: number }>(await h.db.execute(sql.raw(`select count(*)::int as n from ${table} where person_id = '${s.personId}'`)));
      expect(Number(row!.n)).toBe(0);
    }
    const [inJson] = rowsOf<{ n: number }>(
      await h.db.execute(sql`select count(*)::int as n from invoices where customer_snapshot::text like ${`%${s.personId}%`} or customer_snapshot::text like ${`%${s.person.email ?? "@"}%`}`),
    );
    expect(Number(inJson!.n)).toBe(0);

    // The report: counts and actions only.
    expect(report).toEqual(
      expect.arrayContaining([
        { table: "invoices", rows: 2, action: "retained_legal" },
        { table: "order_billing_details", rows: 1, action: "deleted" },
        { table: "invoice_requests", rows: 1, action: "cancelled" },
        { table: "invoice_requests", rows: 1, action: "deleted" },
        { table: "billit_parties", rows: 1, action: "anonymised" },
      ]),
    );
    for (const row of report) expect(Object.keys(row).sort()).toEqual(["action", "rows", "table"]);
    const text = JSON.stringify(report);
    for (const value of [s.personId, s.person.email, s.person.firstName, s.person.lastName, "Acme", s.partyId]) {
      if (value) expect(text).not.toContain(value);
    }
  });

  it("erase is idempotent: a second run changes nothing and reports zero rows", async () => {
    const s = await subject();
    await h.db.transaction((tx) => privacy.erase(tx, s.personId));
    const before = await h.db.select().from(invoices).where(inArray(invoices.id, [s.b2c.invoiceId, s.companyInvoiceId]));
    const again = await h.db.transaction((tx) => privacy.erase(tx, s.personId));
    expect(again.every((r) => r.rows === 0)).toBe(true);
    const after = await h.db.select().from(invoices).where(inArray(invoices.id, [s.b2c.invoiceId, s.companyInvoiceId]));
    expect(after.map((d) => d.customerSnapshot)).toEqual(before.map((d) => d.customerSnapshot));
  });
});
