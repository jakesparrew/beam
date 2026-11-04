/**
 * finance-P6 customer portal (finance rules 20 and 40, spec 4.2 to 4.4): a customer sees only
 * their own documents (another person's id is `not_found` from the query and 404 from the PDF
 * route), requests a company invoice inside the window only and once while one is pending, and
 * the staff decision either reissues (credit note plus company invoice, visible in the portal)
 * or rejects with a note, both notifying the customer. site's `getLegalLinks` is mocked so the
 * decision email can be queued inside the action's transaction on PGlite (OD-15).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { activityEvents, emailMessages, invoiceRequests, invoices } from "@beam/db/schema";
import { seedCommerceCatalogue } from "@beam/db/seed/commerce";
import { makePerson } from "@beam/db/testing";
import { and, eq, setAppDb } from "@/lib/ctx";
import { resetRuntime } from "@/lib/testing";
import { paidB2c, setFinanceSettings } from "./finance-p4.helpers";
import { signInCustomer, signInStaff } from "./finance-p5.helpers";
import { invoiceRow, setupDb } from "./service/__tests__/fixtures";

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
vi.mock("@/modules/site/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getLegalLinks: () => Promise.resolve({ privacy: null, terms: null, cookies: null, accessibility: null }),
}));

const actions = await import("./actions");
const queries = await import("./queries");
const pdfRoute = await import("../../app/[locale]/(portal)/account/invoices/[id]/pdf/route");
const { runFinanceDemoSeed } = await import("./seed");

let h: DbHandle;
beforeAll(async () => {
  h = await setupDb();
  setAppDb(h.db);
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(() => jar.clear());

const now = () => new Date();
const DAY_MS = 86_400_000;
const billing = { isCompany: true, legalName: "Studio Noord BV", vatNumber: "BE0123456749", address: { line1: "Noordlaan 5", postal_code: "2000", city: "Antwerpen", country: "BE" } };
const ok = <T>(r: { ok: boolean; data?: T; error?: unknown }): T => {
  if (!r.ok) throw new Error(`action failed: ${JSON.stringify(r.error)}`);
  return r.data as T;
};
const getPdf = (id: string) => pdfRoute.GET(new Request(`http://localhost/nl/account/invoices/${id}/pdf`), { params: Promise.resolve({ locale: "nl", id }) });

describe("portal reads", () => {
  it("lists only the customer's own documents and hides another person's", async () => {
    const mine = await paidB2c(h.db, undefined, now());
    const theirs = await paidB2c(h.db, undefined, now());
    const list = await queries.listMyInvoices(h.db, { personId: mine.personId });
    expect(list.map((r) => r.id)).toEqual([mine.invoiceId]);
    expect(list[0]).toMatchObject({ number: mine.number, status: "paid", kind: "invoice", pdfReady: true });

    const own = await queries.getMyInvoice(h.db, { personId: mine.personId, id: mine.invoiceId });
    expect(own).toMatchObject({ id: mine.invoiceId, number: mine.number, totalCents: mine.totalCents, canRequestCompanyInvoice: true });
    expect(own!.lines.length).toBeGreaterThan(0);
    expect(own!.vatBreakdown.length).toBeGreaterThan(0);
    expect(await queries.getMyInvoice(h.db, { personId: mine.personId, id: theirs.invoiceId })).toBeNull();
    expect(await queries.getMyInvoice(h.db, { personId: mine.personId, id: "not-a-uuid" })).toBeNull();
    expect(await queries.getMyInvoicePdf(h.db, { personId: mine.personId, id: theirs.invoiceId })).toBeNull();
  });

  it("the PDF route streams the customer's own PDF and answers 404 for anyone else's", async () => {
    const mine = await paidB2c(h.db, undefined, now());
    const theirs = await paidB2c(h.db, undefined, now());

    expect((await getPdf(mine.invoiceId)).status).toBe(404); // signed out

    await signInCustomer(jar, h.db, mine.personId);
    const res = await getPdf(mine.invoiceId);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe(`inline; filename="${mine.number}.pdf"`);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(new TextDecoder().decode(new Uint8Array(await res.arrayBuffer())).startsWith("%PDF")).toBe(true);

    const other = await getPdf(theirs.invoiceId);
    expect(other.status).toBe(404);
    expect((await getPdf("00000000-0000-4000-8000-000000000000")).status).toBe(404);
  });
});

describe("demo seed", () => {
  it("gives the seed customer three paid invoices, one open bank-transfer invoice and one credit note; a second run adds nothing", async () => {
    await seedCommerceCatalogue(h.db, { now: now(), staffUserId: null });
    const person = await makePerson(h.db);
    const ids = new Map([["platform.person.customer2", person.id]]);
    const first = await runFinanceDemoSeed({ db: h.db, now: now(), ids });
    expect(first.created).toBe(5);
    const list = await queries.listMyInvoices(h.db, { personId: person.id });
    expect(list.filter((r) => r.kind === "invoice" && r.status === "paid")).toHaveLength(3);
    expect(list.filter((r) => r.kind === "invoice" && r.status === "open")).toHaveLength(1);
    expect(list.filter((r) => r.kind === "credit_note")).toHaveLength(1);
    const open = list.find((r) => r.status === "open")!;
    expect((await queries.getMyInvoice(h.db, { personId: person.id, id: open.id }))!.bank).toMatchObject({ paymentReference: expect.stringMatching(/^\+\+\+\d{3}\/\d{4}\/\d{5}\+\+\+$/) });
    expect(await runFinanceDemoSeed({ db: h.db, now: now(), ids })).toEqual({ created: 0, skipped: 1 });
  });
});

describe("company invoice requests", () => {
  it("accepts a request inside the window and refuses one outside it", async () => {
    await setFinanceSettings(h.db, { company_request_window_days: 30 });
    const inside = await paidB2c(h.db, undefined, now());
    await signInCustomer(jar, h.db, inside.personId);
    const { requestId } = ok(await actions.requestCompanyInvoice({ invoiceId: inside.invoiceId, billing }));
    const [row] = await h.db.select().from(invoiceRequests).where(eq(invoiceRequests.id, requestId));
    expect(row).toMatchObject({ status: "requested", personId: inside.personId, billing: expect.objectContaining({ legalName: "Studio Noord BV", vatNumber: "BE0123456749" }) });
    expect(await h.db.select().from(activityEvents).where(and(eq(activityEvents.kind, "invoice.company_requested" as never), eq(activityEvents.personId, inside.personId)))).toHaveLength(1);

    const outside = await paidB2c(h.db, undefined, new Date(now().getTime() - 2 * DAY_MS));
    await setFinanceSettings(h.db, { company_request_window_days: 1 });
    await signInCustomer(jar, h.db, outside.personId);
    expect((await queries.getMyInvoice(h.db, { personId: outside.personId, id: outside.invoiceId }))!.canRequestCompanyInvoice).toBe(false);
    expect(await actions.requestCompanyInvoice({ invoiceId: outside.invoiceId, billing })).toMatchObject({ ok: false, error: { code: "conflict", message: "finance.errors.request_window_closed" } });
    await setFinanceSettings(h.db, { company_request_window_days: 30 });
  });

  it("refuses another person's invoice with not_found and an invalid VAT number with a field error", async () => {
    const mine = await paidB2c(h.db, undefined, now());
    const theirs = await paidB2c(h.db, undefined, now());
    await signInCustomer(jar, h.db, mine.personId);
    expect(await actions.requestCompanyInvoice({ invoiceId: theirs.invoiceId, billing })).toMatchObject({ ok: false, error: { code: "not_found" } });
    const bad = await actions.requestCompanyInvoice({ invoiceId: mine.invoiceId, billing: { ...billing, vatNumber: "BE0123456700" } });
    expect(bad).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(Object.values((bad as { error: { fields?: Record<string, string> } }).error.fields ?? {})).toContain("finance.billing.vat_number_checksum");
  });

  it("allows one pending request per invoice; a withdrawn request frees the invoice again", async () => {
    const doc = await paidB2c(h.db, undefined, now());
    await signInCustomer(jar, h.db, doc.personId);
    const first = ok(await actions.requestCompanyInvoice({ invoiceId: doc.invoiceId, billing }));
    expect(await actions.requestCompanyInvoice({ invoiceId: doc.invoiceId, billing })).toMatchObject({ ok: false, error: { code: "conflict", message: "finance.errors.request_pending" } });
    const detail = await queries.getMyInvoice(h.db, { personId: doc.personId, id: doc.invoiceId });
    expect(detail).toMatchObject({ canRequestCompanyInvoice: false, pendingRequest: { id: first.requestId, legalName: "Studio Noord BV", status: "requested" } });

    // Another customer cannot withdraw it.
    const stranger = await paidB2c(h.db, undefined, now());
    await signInCustomer(jar, h.db, stranger.personId);
    expect(await actions.cancelCompanyInvoiceRequest({ requestId: first.requestId })).toMatchObject({ ok: false, error: { code: "not_found" } });

    await signInCustomer(jar, h.db, doc.personId);
    ok(await actions.cancelCompanyInvoiceRequest({ requestId: first.requestId }));
    expect((await h.db.select().from(invoiceRequests).where(eq(invoiceRequests.id, first.requestId)))[0]!.status).toBe("cancelled");
    expect((await queries.getMyInvoice(h.db, { personId: doc.personId, id: doc.invoiceId }))!.canRequestCompanyInvoice).toBe(true);
    ok(await actions.requestCompanyInvoice({ invoiceId: doc.invoiceId, billing }));
  });

  it("approval yields a credit note plus a company invoice, both in the portal, and notifies the customer", async () => {
    const doc = await paidB2c(h.db, undefined, now());
    await signInCustomer(jar, h.db, doc.personId);
    const { requestId } = ok(await actions.requestCompanyInvoice({ invoiceId: doc.invoiceId, billing }));

    jar.clear();
    await signInStaff(jar, h.db, "finance");
    const out = ok(await actions.decideCompanyInvoiceRequest({ requestId, decision: "approve" }));
    expect(out.status).toBe("approved");

    const original = await invoiceRow(h.db, doc.invoiceId);
    expect(original.status).toBe("cancelled");
    const [cn] = await h.db.select().from(invoices).where(eq(invoices.reversesInvoiceId, doc.invoiceId));
    expect(cn).toMatchObject({ kind: "credit_note", totalCents: -doc.totalCents });
    const reissued = await invoiceRow(h.db, out.newInvoiceId!);
    expect(reissued).toMatchObject({ kind: "invoice", isCompany: true, replacesInvoiceId: doc.invoiceId, totalCents: doc.totalCents });
    expect(reissued.customerSnapshot).toMatchObject({ kind: "company", name: "Studio Noord BV", vat_number: "BE0123456749" });

    const list = await queries.listMyInvoices(h.db, { personId: doc.personId });
    expect(list.map((r) => r.id).sort()).toEqual([doc.invoiceId, cn!.id, out.newInvoiceId!].sort());
    const detail = await queries.getMyInvoice(h.db, { personId: doc.personId, id: doc.invoiceId });
    expect(detail).toMatchObject({ status: "cancelled", replacedBy: { id: out.newInvoiceId }, creditNotes: [{ id: cn!.id }], canRequestCompanyInvoice: false, pendingRequest: null });
    expect(detail!.requests[0]).toMatchObject({ id: requestId, status: "approved" });
    const cnDetail = await queries.getMyInvoice(h.db, { personId: doc.personId, id: cn!.id });
    expect(cnDetail).toMatchObject({ kind: "credit_note", reverses: { id: doc.invoiceId }, requestWindowUntil: null });

    expect(await h.db.select().from(emailMessages).where(eq(emailMessages.idempotencyKey, `invoice_request:${requestId}:decided`))).toHaveLength(1);
    expect(await h.db.select().from(activityEvents).where(and(eq(activityEvents.kind, "invoice.company_request_decided" as never), eq(activityEvents.personId, doc.personId)))).toHaveLength(1);
  });

  it("rejection keeps the invoice, shows the note in the portal and notifies the customer", async () => {
    const doc = await paidB2c(h.db, undefined, now());
    await signInCustomer(jar, h.db, doc.personId);
    const { requestId } = ok(await actions.requestCompanyInvoice({ invoiceId: doc.invoiceId, billing }));

    jar.clear();
    await signInStaff(jar, h.db, "finance");
    ok(await actions.decideCompanyInvoiceRequest({ requestId, decision: "reject", note: "The VAT number belongs to another company" }));

    expect((await invoiceRow(h.db, doc.invoiceId)).status).toBe("paid");
    const detail = await queries.getMyInvoice(h.db, { personId: doc.personId, id: doc.invoiceId });
    expect(detail!.requests[0]).toMatchObject({ status: "rejected", decisionNote: "The VAT number belongs to another company" });
    expect(detail!.canRequestCompanyInvoice).toBe(true);
    const mails = await h.db.select().from(emailMessages).where(eq(emailMessages.idempotencyKey, `invoice_request:${requestId}:decided`));
    expect(mails).toHaveLength(1);
    expect(mails[0]!.personId).toBe(doc.personId);
    expect(await h.db.select().from(activityEvents).where(and(eq(activityEvents.kind, "invoice.company_request_decided" as never), eq(activityEvents.personId, doc.personId)))).toHaveLength(1);
  });
});
