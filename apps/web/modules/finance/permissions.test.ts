/**
 * finance permissions. finance-P2: the finance permission facade, and the api functions refusing
 * a customer actor for another person's data (`not_found`, never `forbidden`, so ids cannot be
 * probed; finance spec 4.2 and rule 40). finance-P5: every finance action refuses a staff user
 * without its permission (`forbidden` before anything is written; reception and marketing hold
 * none of the finance permissions), customer sessions are `unauthorized` on staff actions and
 * staff sessions on customer actions, and a customer reaches only their own invoices and requests.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { DbHandle } from "@beam/db";
import { billitParties, financeExports, invoiceRequests, invoices } from "@beam/db/schema";
import { eq, setAppDb, type Actor } from "@/lib/ctx";
import { PERMISSIONS } from "@/registry/permissions.generated";
import * as actions from "./actions";
import { issueCreditNote, issueInvoice, markCreditNoteSettled, resyncCustomer, setOrderBillingDetails } from "./api";
import { openInvoice, paidB2c } from "./finance-p4.helpers";
import { signInCustomer, signInStaff } from "./finance-p5.helpers";
import { permissions } from "./permissions";
import { asTx, ctxAt, jobByKey, makePerson, NOW, paidOrder, payment, refund, setupDb } from "./service/__tests__/fixtures";

vi.mock("@/registry/jobs.generated", async (importOriginal) => {
  const { withFinanceJobStubs } = await import("./service/__tests__/fixtures");
  return withFinanceJobStubs(await importOriginal<{ JOB_BY_KIND: Record<string, unknown> }>());
});
const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.45" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));

let h: DbHandle;
beforeAll(async () => {
  h = await setupDb();
  setAppDb(h.db);
});
afterAll(() => h.close());

const customer = (personId: string): Actor => ({ kind: "customer", userId: randomUUID(), personId });
const as = (actor: Actor) => ctxAt(h.db, NOW, actor);
const billing = {
  isCompany: false,
  legalName: "Jan Peeters",
  address: { line1: "Dorpsstraat 2", postal_code: "2000", city: "Antwerpen", country: "BE" },
};

describe("finance permissions facade", () => {
  it("declares invoices.read and invoices.issue; reports.finance is in the registry (declared by ops)", () => {
    expect(permissions).toEqual(expect.arrayContaining(["invoices.read", "invoices.issue"]));
    expect(PERMISSIONS).toEqual(expect.arrayContaining(["invoices.read", "invoices.issue", "reports.finance"]));
  });
});

describe("api functions and customer actors", () => {
  it("issueInvoice: not_found for another person's order, issued for the customer's own", async () => {
    const owner = await makePerson(h.db);
    const other = await makePerson(h.db);
    const { order } = await paidOrder(h.db, undefined, { personId: owner.id });
    await expect(issueInvoice(asTx(h.db), as(customer(other.id)), { orderId: order.id })).rejects.toMatchObject({ code: "not_found" });
    expect(await issueInvoice(asTx(h.db), as(customer(owner.id)), { orderId: order.id })).toMatchObject({ status: "issued" });
  });

  it("setOrderBillingDetails: not_found on another person's order, accepted on the customer's own", async () => {
    const owner = await makePerson(h.db);
    const other = await makePerson(h.db);
    const { order } = await paidOrder(h.db, undefined, { personId: owner.id });
    await expect(setOrderBillingDetails(asTx(h.db), as(customer(other.id)), { orderId: order.id, details: billing })).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(setOrderBillingDetails(asTx(h.db), as(customer(owner.id)), { orderId: order.id, details: billing })).resolves.toBeUndefined();
  });

  it("issueCreditNote and markCreditNoteSettled: not_found for customers", async () => {
    const owner = await makePerson(h.db);
    const { order } = await paidOrder(h.db, undefined, { personId: owner.id });
    const pay = await payment(h.db, order.id, { amountCents: order.totalCents });
    const r = await issueInvoice(asTx(h.db), as({ kind: "system", jobId: "" }), { orderId: order.id, paymentId: pay.id });
    if (r.status !== "issued") throw new Error("not issued");
    const ref = await refund(h.db, pay, order.totalCents);
    await expect(issueCreditNote(asTx(h.db), as(customer(owner.id)), { invoiceId: r.invoiceId, refundId: ref.id, reason: "Refund" })).rejects.toMatchObject({
      code: "not_found",
    });
    await issueCreditNote(asTx(h.db), as({ kind: "system", jobId: "" }), { invoiceId: r.invoiceId, refundId: ref.id, reason: "Refund" });
    const other = await makePerson(h.db);
    await expect(markCreditNoteSettled(asTx(h.db), as(customer(other.id)), { refundId: ref.id, settledAt: NOW })).rejects.toMatchObject({ code: "not_found" });
  });

  it("resyncCustomer: not_found for another person, enqueues the push for the customer's own party", async () => {
    const owner = await makePerson(h.db);
    const other = await makePerson(h.db);
    await h.db.insert(billitParties).values({ partyKey: `person:${owner.id}`, personId: owner.id });
    await expect(resyncCustomer(asTx(h.db), as(customer(other.id)), owner.id)).rejects.toMatchObject({ code: "not_found" });
    await resyncCustomer(asTx(h.db), as(customer(owner.id)), owner.id);
    await resyncCustomer(asTx(h.db), as({ kind: "system", jobId: "" }), owner.id);
    const rows = await h.db.query.jobs.findMany({ where: (j, { like }) => like(j.idempotencyKey, `billit:customer:person:${owner.id}:%`) });
    expect(rows).toHaveLength(1);
    expect(await jobByKey(h.db, rows[0]!.idempotencyKey)).toMatchObject({ kind: "billit.push_customer", payload: { partyKey: `person:${owner.id}` } });
  });
});

describe("finance actions and staff permissions (finance-P5)", () => {
  beforeEach(() => jar.clear());

  const billingB2b = { isCompany: true, legalName: "Acme Wellness BV", vatNumber: "BE0123456749", address: { line1: "Kerkstraat 1", postal_code: "9000", city: "Gent", country: "BE" } };
  const forbidden = { ok: false, error: { code: "forbidden" } };
  const unauthorized = { ok: false, error: { code: "unauthorized" } };

  /** Every staff action with valid input on real documents, with the permission it needs. */
  async function staffCalls(): Promise<[string, string, () => Promise<unknown>][]> {
    const paid = await paidB2c(h.db);
    const open = await openInvoice(h.db, { now: new Date() });
    const [req] = await h.db.insert(invoiceRequests).values({ invoiceId: paid.invoiceId, personId: paid.personId, billing: billingB2b }).returning();
    const today = new Date().toISOString().slice(0, 10);
    return [
      ["issueManualCreditNote", "invoices.issue", () => actions.issueManualCreditNote({ invoiceId: paid.invoiceId, reason: "Correction", noRefund: true })],
      ["reissueInvoice", "invoices.issue", () => actions.reissueInvoice({ invoiceId: paid.invoiceId, billing: billingB2b, reason: "Reissue" })],
      ["markInvoicePaid", "invoices.issue", () => actions.markInvoicePaid({ invoiceId: open.invoiceId, paidOn: today, note: "Bank statement" })],
      ["retryBillitSync", "invoices.issue", () => actions.retryBillitSync({ invoiceId: paid.invoiceId })],
      ["retryAllBillitFailed", "invoices.issue", () => actions.retryAllBillitFailed({})],
      ["runBillitReconcileNow", "invoices.issue", () => actions.runBillitReconcileNow({})],
      ["rerenderInvoicePdf", "invoices.issue", () => actions.rerenderInvoicePdf({ allBlocked: true })],
      ["resendInvoiceEmail", "invoices.issue", () => actions.resendInvoiceEmail({ invoiceId: paid.invoiceId })],
      ["sendPaymentReminder", "invoices.issue", () => actions.sendPaymentReminder({ invoiceId: open.invoiceId })],
      ["decideCompanyInvoiceRequest", "invoices.issue", () => actions.decideCompanyInvoiceRequest({ requestId: req!.id, decision: "reject" })],
      ["requestFinanceExport", "reports.finance", () => actions.requestFinanceExport({ kind: "invoices", from: "2026-10-01", to: "2026-10-31" })],
    ];
  }

  it.each(["reception", "marketing"] as const)("%s gets forbidden on every finance action and nothing is written", async (role) => {
    const calls = await staffCalls();
    const before = await h.db.select({ id: invoices.id }).from(invoices);
    await signInStaff(jar, h.db, role);
    for (const [label, , run] of calls) expect(await run(), label).toMatchObject(forbidden);
    expect(await h.db.select({ id: invoices.id }).from(invoices)).toHaveLength(before.length);
    expect(await h.db.select().from(financeExports)).toHaveLength(0);
  });

  it("each staff action refuses a staff user who lacks exactly its permission", async () => {
    const all = ["invoices.read", "invoices.issue", "reports.finance"];
    for (const [label, permission, run] of await staffCalls()) {
      jar.clear();
      await signInStaff(jar, h.db, "customer_service", all.filter((p) => p !== permission));
      expect(await run(), label).toMatchObject(forbidden);
    }
  });

  it("customer sessions are unauthorized on staff actions; staff sessions on customer actions", async () => {
    const calls = await staffCalls();
    await signInCustomer(jar, h.db);
    for (const [label, , run] of calls) expect(await run(), label).toMatchObject(unauthorized);
    jar.clear();
    await signInStaff(jar, h.db, "finance");
    const paid = await paidB2c(h.db);
    expect(await actions.requestCompanyInvoice({ invoiceId: paid.invoiceId, billing: billingB2b })).toMatchObject(unauthorized);
    expect(await actions.cancelCompanyInvoiceRequest({ requestId: randomUUID() })).toMatchObject(unauthorized);
  });

  it("with its permission a finance user passes, and a customer reaches only their own invoice and request", async () => {
    await signInStaff(jar, h.db, "finance");
    expect(await actions.requestFinanceExport({ kind: "vat_summary", from: "2026-01-01", to: "2026-03-31" })).toMatchObject({ ok: true });
    expect(await actions.requestFinanceExport({ kind: "invoices", from: "2025-01-01", to: "2026-03-31" })).toMatchObject({ ok: false, error: { code: "validation" } });

    const mine = await paidB2c(h.db, undefined, new Date());
    const theirs = await paidB2c(h.db, undefined, new Date());
    jar.clear();
    await signInCustomer(jar, h.db, mine.personId);
    expect(await actions.requestCompanyInvoice({ invoiceId: theirs.invoiceId, billing: billingB2b })).toMatchObject({ ok: false, error: { code: "not_found" } });
    const created = await actions.requestCompanyInvoice({ invoiceId: mine.invoiceId, billing: billingB2b });
    expect(created).toMatchObject({ ok: true });
    const requestId = (created as { data: { requestId: string } }).data.requestId;
    expect(await actions.requestCompanyInvoice({ invoiceId: mine.invoiceId, billing: billingB2b })).toMatchObject({ ok: false, error: { code: "conflict" } });

    jar.clear();
    await signInCustomer(jar, h.db, theirs.personId);
    expect(await actions.cancelCompanyInvoiceRequest({ requestId })).toMatchObject({ ok: false, error: { code: "not_found" } });
    jar.clear();
    await signInCustomer(jar, h.db, mine.personId);
    expect(await actions.cancelCompanyInvoiceRequest({ requestId })).toMatchObject({ ok: true });
    const [row] = await h.db.select().from(invoiceRequests).where(eq(invoiceRequests.id, requestId));
    expect(row!.status).toBe("cancelled");
  });
});
