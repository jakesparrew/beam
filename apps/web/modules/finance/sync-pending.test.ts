/**
 * finance-P4 `billit.sync_pending` (finance rules 26, 28, 34, 35; edge cases 7, 11, 12): Billit's
 * paid status settles open invoices through commerce once, partial payments stay open, stuck
 * pushes are re-queued, and the failing alert fires once per invoice per hour.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { jobs } from "@beam/db/schema";
import { eq } from "@/lib/ctx";
import { createFakeIntegrations, type FakeIntegrations } from "@/lib/testing";
import { jobsOf, openInvoice, paidB2c, runJob, slackJobs } from "./finance-p4.helpers";
import { eventsOf, invoiceRow, setupDb } from "./service/__tests__/fixtures";

const commerce = vi.hoisted(() => ({ recordBankTransferPaid: vi.fn(() => Promise.resolve({ applied: true })) }));
vi.mock("@/modules/commerce/api", async (importOriginal) => ({ ...(await importOriginal<object>()), recordBankTransferPaid: commerce.recordBankTransferPaid }));

let h: DbHandle;
const fakes: FakeIntegrations = createFakeIntegrations();
beforeAll(async () => {
  h = await setupDb();
});
afterAll(() => h.close());
beforeEach(() => commerce.recordBankTransferPaid.mockClear());

const minutesFromNow = (m: number) => new Date(Date.now() + m * 60_000);
const sync = (now: Date = minutesFromNow(0), payload: unknown = {}) => runJob(h.db, "billit.sync_pending", payload, { integrations: fakes, now });
const pushNow = (invoiceId: string) => runJob(h.db, "billit.push_invoice", { invoiceId }, { integrations: fakes });

/** Leaves only the invoices of this test open in Billit's eyes: earlier tests' open invoices are settled first. */
async function openPushed(totalCents = 12_100) {
  const doc = await openInvoice(h.db, { totalCents });
  expect((await pushNow(doc.invoiceId)).result).toMatchObject({ status: "synced" });
  return doc;
}

describe("settlement from Billit", () => {
  it("fake markPaid -> invoice paid via billit at 12:00 Brussels, commerce settles once", async () => {
    const doc = await openPushed();
    fakes.billit.markPaid(doc.number, "2026-11-10");
    expect((await sync()).result).toMatchObject({ status: "ok", settled: 1 });
    const inv = await invoiceRow(h.db, doc.invoiceId);
    expect(inv).toMatchObject({ status: "paid", settledVia: "billit", billitPaymentStatus: "not_applicable" });
    expect(inv.paidAt).toEqual(new Date("2026-11-10T11:00:00Z"));
    expect(commerce.recordBankTransferPaid).toHaveBeenCalledTimes(1);
    expect(commerce.recordBankTransferPaid.mock.calls[0]![2]).toEqual({ orderId: doc.orderId, paidOn: "2026-11-10", reference: doc.number });
    const paidEvents = async () => (await eventsOf(h.db, "invoice.paid")).filter((e) => (e.data as { invoice_id: string }).invoice_id === doc.invoiceId);
    expect(await paidEvents()).toHaveLength(1);
    expect(await jobsOf(h.db, "billit.push_payment", doc.invoiceId)).toHaveLength(0);

    await sync();
    expect(commerce.recordBankTransferPaid).toHaveBeenCalledTimes(1);
    expect(await paidEvents()).toHaveLength(1);
  });

  it("a partial payment leaves the invoice open and commerce untouched", async () => {
    const doc = await openPushed(20_000);
    fakes.billit.markPaid(doc.number, "2026-11-10", 5_000);
    expect((await sync()).result).toMatchObject({ settled: 0, partial: 1 });
    expect((await invoiceRow(h.db, doc.invoiceId)).status).toBe("open");
    expect(commerce.recordBankTransferPaid).not.toHaveBeenCalled();

    fakes.billit.markPaid(doc.number, "2026-11-12", 15_000);
    expect((await sync()).result).toMatchObject({ settled: 1 });
    expect(await invoiceRow(h.db, doc.invoiceId)).toMatchObject({ status: "paid", settledVia: "billit" });
    expect(commerce.recordBankTransferPaid).toHaveBeenCalledTimes(1);
  });

  it("continues with an offset when more than one page is open", async () => {
    const result = await sync(minutesFromNow(0), { offset: 0 });
    expect(result.result).toMatchObject({ status: "ok" });
    const page = await runJob(h.db, "billit.sync_pending", { offset: 10_000 }, { integrations: fakes, now: minutesFromNow(0), key: "schedule:billit.sync_pending:x:o10000" });
    expect(page.result).toMatchObject({ requeued: 0, alerted: 0 });
  });
});

describe("re-queue of stuck pushes", () => {
  it("re-queues a pending document older than 15 minutes once while its job is live", async () => {
    const doc = await paidB2c(h.db);
    expect(await jobsOf(h.db, "billit.push_invoice", doc.invoiceId)).toHaveLength(0);
    await sync(minutesFromNow(5));
    expect(await jobsOf(h.db, "billit.push_invoice", doc.invoiceId)).toHaveLength(0);

    await sync(minutesFromNow(20));
    const queued = await jobsOf(h.db, "billit.push_invoice", doc.invoiceId);
    expect(queued.map((j) => j.idempotencyKey)).toEqual([`billit:invoice:${doc.invoiceId}`]);
    await sync(minutesFromNow(21));
    expect(await jobsOf(h.db, "billit.push_invoice", doc.invoiceId)).toHaveLength(1);

    // The job exhausted its attempts (Billit down for hours): a new attempt with a retry key.
    await h.db.update(jobs).set({ status: "dead", attempts: 6 }).where(eq(jobs.id, queued[0]!.id));
    await sync(minutesFromNow(40));
    expect((await jobsOf(h.db, "billit.push_invoice", doc.invoiceId)).map((j) => j.idempotencyKey)).toContain(`billit:invoice:${doc.invoiceId}:r1`);
  });

  it("leaves a document whose push died permanently (4xx) to staff's Retry", async () => {
    const doc = await paidB2c(h.db);
    await sync(minutesFromNow(20));
    const [job] = await jobsOf(h.db, "billit.push_invoice", doc.invoiceId);
    await h.db.update(jobs).set({ status: "dead", attempts: 1 }).where(eq(jobs.id, job!.id));
    await sync(minutesFromNow(40));
    expect(await jobsOf(h.db, "billit.push_invoice", doc.invoiceId)).toHaveLength(1);
  });
});

describe("failing alert (rule 35)", () => {
  it("raises billit-failing:<id> after 60 minutes, once per hour", async () => {
    const doc = await paidB2c(h.db);
    fakes.billit.failNext("createOrder", { status: 503 });
    await pushNow(doc.invoiceId);
    expect((await invoiceRow(h.db, doc.invoiceId)).billitFailedSince).not.toBeNull();

    await sync(minutesFromNow(30));
    expect(await slackJobs(h.db, `billit-failing:${doc.invoiceId}`)).toHaveLength(0);

    const later = minutesFromNow(61);
    await sync(later);
    await sync(later);
    expect(await slackJobs(h.db, `billit-failing:${doc.invoiceId}`)).toHaveLength(1);
    await sync(new Date(later.getTime() + 3_600_000));
    expect(await slackJobs(h.db, `billit-failing:${doc.invoiceId}`)).toHaveLength(2);
  });

  it("is silent while Billit is disabled", async () => {
    const { setFinanceSettings } = await import("./finance-p4.helpers");
    await setFinanceSettings(h.db, { billit_enabled: false });
    expect((await sync(minutesFromNow(500))).result).toEqual({ status: "disabled" });
    const { settings } = await import("@beam/db/schema");
    await h.db.delete(settings).where(eq(settings.key, "finance"));
  });
});
