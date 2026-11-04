/**
 * finance-P2 permissions: the finance permission facade, and the api functions refusing a
 * customer actor for another person's data (`not_found`, never `forbidden`, so ids cannot be
 * probed; finance spec 4.2 and rule 40). Staff permissions on finance's own actions are tested
 * with the actions (finance-P5).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { DbHandle } from "@beam/db";
import { billitParties } from "@beam/db/schema";
import type { Actor } from "@/lib/ctx";
import { PERMISSIONS } from "@/registry/permissions.generated";
import { issueCreditNote, issueInvoice, markCreditNoteSettled, resyncCustomer, setOrderBillingDetails } from "./api";
import { permissions } from "./permissions";
import { asTx, ctxAt, jobByKey, makePerson, NOW, paidOrder, payment, refund, setupDb } from "./service/__tests__/fixtures";

vi.mock("@/registry/jobs.generated", async (importOriginal) => {
  const { withFinanceJobStubs } = await import("./service/__tests__/fixtures");
  return withFinanceJobStubs(await importOriginal<{ JOB_BY_KIND: Record<string, unknown> }>());
});

let h: DbHandle;
beforeAll(async () => {
  h = await setupDb();
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
