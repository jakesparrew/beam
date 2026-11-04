/**
 * finance-P4 reconcile (finance rule 13, section 4.5 `billit.reconcile`, edge cases 11, 25): every
 * issue type against the Billit fake, and one `billit_reconcile_runs` row per day.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@beam/db";
import { billitReconcileRuns, invoiceSequences } from "@beam/db/schema";
import type { ReconcileIssue } from "@beam/core/finance";
import { and, eq, sql } from "@/lib/ctx";
import { createFakeIntegrations, type FakeIntegrations } from "@/lib/testing";
import { issueInvoice } from "../api";
import { openInvoice, paidB2c, runJob, slackJobs } from "../finance-p4.helpers";
import { asTx, ctxAt, NOW, paidOrder, payment, setupDb } from "./__tests__/fixtures";
import { reconcile } from "./reconcile";
import { markInvoicePaidInternal } from "./settle";

let h: DbHandle;
const fakes: FakeIntegrations = createFakeIntegrations();
const LATER = new Date(NOW.getTime() + 2 * 3_600_000);
const WINDOW = { from: "2026-10-01", to: "2026-11-04", now: LATER };

type Docs = Record<"ok" | "missing" | "mismatch" | "partial" | "paidHere" | "noPdf", { invoiceId: string; number: string }>;
let docs: Docs;
let issues: ReconcileIssue[];

const push = (invoiceId: string) => runJob(h.db, "billit.push_invoice", { invoiceId }, { integrations: fakes, now: NOW });
const of = (type: ReconcileIssue["type"], number?: string) => issues.filter((i) => i.type === type && (number === undefined || i.number === number));

beforeAll(async () => {
  h = await setupDb();
  const ok = await paidB2c(h.db);
  await push(ok.invoiceId);

  const missing = await paidB2c(h.db);

  const mismatch = await paidB2c(h.db);
  await fakes.billit.createOrder({
    OrderType: "Invoice",
    OrderDirection: "Income",
    OrderNumber: mismatch.number,
    Reference: mismatch.number,
    OrderDate: "2026-11-04",
    Customer: { PartyID: "billit_x" },
    OrderLines: [{ Description: "wrong", Quantity: 1, UnitPriceExcl: 10, VATPercentage: 21 }],
    Paid: true,
    PaidDate: "2026-11-04",
  });

  const partial = await openInvoice(h.db, { totalCents: 20_000 });
  await push(partial.invoiceId);
  fakes.billit.markPaid(partial.number, "2026-11-04", 5_000);

  const paidHere = await openInvoice(h.db);
  await push(paidHere.invoiceId);
  await markInvoicePaidInternal(asTx(h.db), ctxAt(h.db), { invoiceId: paidHere.invoiceId, paidAt: NOW, settledVia: "manual" });

  const { order } = await paidOrder(h.db);
  await payment(h.db, order.id, { amountCents: order.totalCents });
  const noPdf = await issueInvoice(asTx(h.db), ctxAt(h.db), { orderId: order.id });
  if (noPdf.status !== "issued") throw new Error("not issued");

  await fakes.billit.createOrder({
    OrderType: "Invoice",
    OrderDirection: "Income",
    OrderNumber: "MANUAL-0001",
    Reference: "MANUAL-0001",
    OrderDate: "2026-11-03",
    Customer: { PartyID: "billit_x" },
    OrderLines: [{ Description: "typed in Billit", Quantity: 1, UnitPriceExcl: 50, VATPercentage: 21 }],
  });

  docs = { ok, missing, mismatch, partial, paidHere, noPdf };
  issues = await reconcile(h.db, fakes.billit, WINDOW);
});
afterAll(() => h.close());

describe("reconcile issues", () => {
  it("a document Billit does not know is missing_in_billit", () => {
    expect(of("missing_in_billit", docs.missing.number)).toHaveLength(1);
    expect(of("missing_in_billit", docs.ok.number)).toHaveLength(0);
  });

  it("an order BEAM never issued is unknown_in_billit", () => {
    expect(of("unknown_in_billit", "MANUAL-0001")).toEqual([expect.objectContaining({ number: "MANUAL-0001", billit_id: expect.any(String) })]);
    expect(of("unknown_in_billit").map((i) => i.number)).toEqual(["MANUAL-0001"]);
  });

  it("a different Billit total is amount_mismatch", () => {
    expect(of("amount_mismatch", docs.mismatch.number)).toHaveLength(1);
    expect(of("amount_mismatch", docs.ok.number)).toHaveLength(0);
  });

  it("a partial Billit payment and a BEAM-only payment are paid_mismatch", () => {
    expect(of("paid_mismatch", docs.partial.number)[0]!.detail).toContain("partial payment in Billit: 5000 of 20000");
    expect(of("paid_mismatch", docs.paidHere.number)[0]!.detail).toBe("paid in BEAM, not paid in Billit");
    expect(of("paid_mismatch", docs.ok.number)).toHaveLength(0);
  });

  it("a document without PDF an hour after issue is pdf_missing", () => {
    expect(of("pdf_missing", docs.noPdf.number)).toHaveLength(1);
    expect(of("pdf_missing", docs.ok.number)).toHaveLength(0);
  });

  it("no personal data in issues", () => {
    expect(JSON.stringify(issues)).not.toMatch(/@example\.com|Kerkstraat/);
  });

  it("a sequence whose count differs from last_number is sequence_gap; a fresh hour has no stale or missing", async () => {
    expect(of("sequence_gap")).toHaveLength(0);
    const where = and(eq(invoiceSequences.kind, "invoice"), eq(invoiceSequences.year, 2026));
    await h.db.update(invoiceSequences).set({ lastNumber: sql`${invoiceSequences.lastNumber} + 1` }).where(where);
    const gaps = (await reconcile(h.db, fakes.billit, WINDOW)).filter((i) => i.type === "sequence_gap");
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.detail).toMatch(/^invoice 2026: last_number \d+, \d+ documents/);
    const early = await reconcile(h.db, fakes.billit, { ...WINDOW, now: NOW });
    expect(early.filter((i) => i.type === "missing_in_billit" || i.type === "pdf_missing")).toHaveLength(0);
    await h.db.update(invoiceSequences).set({ lastNumber: sql`${invoiceSequences.lastNumber} - 1` }).where(where);
  });

  it("a document unsynced after 24 hours is stale_pending", async () => {
    const late = await reconcile(h.db, fakes.billit, { ...WINDOW, now: new Date(NOW.getTime() + 25 * 3_600_000) });
    expect(late.filter((i) => i.type === "stale_pending" && i.number === docs.missing.number)).toHaveLength(1);
  });
});

describe("billit.reconcile job", () => {
  it("upserts one run per day, alerts with the run_on fingerprint", async () => {
    const first = await runJob(h.db, "billit.reconcile", {}, { integrations: fakes, now: LATER });
    expect(first.result).toMatchObject({ status: "issues" });
    const second = await runJob(h.db, "billit.reconcile", {}, { integrations: fakes, now: new Date(LATER.getTime() + 60_000) });
    expect(second.result).toMatchObject({ status: "issues" });
    const runs = await h.db.select().from(billitReconcileRuns);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ runOn: "2026-11-04", status: "issues" });
    expect(runs[0]!.issuesCount).toBe(runs[0]!.issues.length);
    expect(runs[0]!.checkedCount).toBeGreaterThanOrEqual(6);
    expect((await slackJobs(h.db, "billit-reconcile:2026-11-04")).map((j) => (j.payload as { severity: string }).severity)).toEqual(["high"]);
  });

  it("Billit unreachable: the run is failed and the job retries", async () => {
    fakes.billit.failNext(null, { status: 503 });
    const r = await runJob(h.db, "billit.reconcile", {}, { integrations: fakes, now: new Date("2026-11-05T05:15:00Z") });
    expect(r.error).toMatchObject({ retryable: true });
    const [run] = await h.db.select().from(billitReconcileRuns).where(eq(billitReconcileRuns.runOn, "2026-11-05"));
    expect(run).toMatchObject({ status: "failed", issuesCount: 0 });
  });

  it("a sequence gap raises sequence-gap:<year>:<kind>", async () => {
    const where = and(eq(invoiceSequences.kind, "invoice"), eq(invoiceSequences.year, 2026));
    await h.db.update(invoiceSequences).set({ lastNumber: sql`${invoiceSequences.lastNumber} + 1` }).where(where);
    await runJob(h.db, "billit.reconcile", {}, { integrations: fakes, now: LATER });
    expect(await slackJobs(h.db, "sequence-gap:2026:invoice")).toHaveLength(1);
    await h.db.update(invoiceSequences).set({ lastNumber: sql`${invoiceSequences.lastNumber} - 1` }).where(where);
  });
});
