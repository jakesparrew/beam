/**
 * finance-P5 `getFinanceDigest` (finance spec 4.1, rules 16 and 35; SLA "Billit sync failing"):
 * counts of failed and failing Billit documents, pending pushes, PDF failures, overdue open
 * invoices, the last reconcile run and documents issued in the nl-BE fallback. The section holds
 * counts and amounts only, never a customer's name or email.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@beam/db";
import { billitReconcileRuns, persons } from "@beam/db/schema";
import { makePaidOrder } from "@beam/db/testing/commerce-factories";
import { getFinanceDigest } from "../api";
import { openInvoice, paidB2c } from "../finance-p4.helpers";
import { asTx, ctxAt, makePerson, NOW, payment, setupDb } from "./__tests__/fixtures";
import { financeDigestCounts } from "./digest";
import { updateInvoiceState } from "./invoice-state";
import { issueInvoice } from "./issue-invoice";

let h: DbHandle;
const DAY = "2026-11-04";

beforeAll(async () => {
  h = await setupDb();
});
afterAll(() => h.close());

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

describe("getFinanceDigest", () => {
  it("is all zero on an empty database, with a warning that no reconcile ran", async () => {
    const section = await getFinanceDigest(h.db, DAY);
    expect(section.title).toBe("Finance");
    expect(section.lines.find((l) => l.label === "Last Billit reconcile")).toMatchObject({ value: "never", level: "warn" });
    expect(section.lines.filter((l) => l.label !== "Last Billit reconcile").every((l) => l.level === "ok")).toBe(true);
  });

  it("counts Billit failures, failing documents, PDF failures, overdue invoices, the last reconcile and nl-BE fallbacks", async () => {
    await paidB2c(h.db); // pending in Billit
    const failing = await paidB2c(h.db);
    await updateInvoiceState(asTx(h.db), failing.invoiceId, { billitStatus: "failed", billitAttempts: 4, billitFailedSince: minutesAgo(120), billitLastError: "HTTP 503" });
    const recent = await paidB2c(h.db);
    await updateInvoiceState(asTx(h.db), recent.invoiceId, { billitStatus: "failed", billitAttempts: 1, billitFailedSince: minutesAgo(10), billitLastError: "HTTP 503" });

    const noPdfPerson = await makePerson(h.db);
    const { order } = await makePaidOrder(h.db, { personId: noPdfPerson.id });
    await payment(h.db, order.id, { amountCents: order.totalCents });
    const noPdf = await issueInvoice(asTx(h.db), ctxAt(h.db), { orderId: order.id });
    if (noPdf.status !== "issued") throw new Error("not issued");
    await updateInvoiceState(asTx(h.db), noPdf.invoiceId, { pdfStatus: "failed" });

    await openInvoice(h.db, { totalCents: 12_100, dueOn: "2026-10-01" });
    await openInvoice(h.db, { totalCents: 5_000, dueOn: "2099-01-01" });

    const french = await makePerson(h.db, { locale: "fr-BE" });
    const { order: frOrder } = await makePaidOrder(h.db, { personId: french.id, lines: [{ description: { "nl-BE": "Alleen Nederlands" } }] });
    const fr = await issueInvoice(asTx(h.db), ctxAt(h.db, NOW), { orderId: frOrder.id });
    expect(fr.status).toBe("issued");

    await h.db.insert(billitReconcileRuns).values({ runOn: "2026-11-03", startedAt: NOW, finishedAt: NOW, status: "issues", checkedCount: 12, issuesCount: 2, issues: [] });

    const counts = await financeDigestCounts(h.db, DAY);
    expect(counts).toMatchObject({
      billitFailed: 2,
      billitFailing: 1,
      billitPending: 5,
      pdfFailed: 1,
      overdueCount: 1,
      overdueCents: 12_100,
      fallbackCount: 1,
      lastReconcile: { runOn: "2026-11-03", status: "issues", issuesCount: 2 },
    });

    const section = await getFinanceDigest(h.db, DAY);
    const line = (label: string) => section.lines.find((l) => l.label === label);
    expect(line("Billit documents failed")).toEqual({ label: "Billit documents failed", value: "2", level: "warn" });
    expect(line("Billit failing for over the alert time")).toMatchObject({ value: "1", level: "alert" });
    expect(line("Invoice PDF failures")).toMatchObject({ value: "1", level: "alert" });
    expect(line("Overdue open invoices")?.value).toMatch(/^1 \(.*121\.00\)$/);
    expect(line("Last Billit reconcile")).toMatchObject({ value: "2026-11-03: issues, 2 issues", level: "warn" });
    expect(line("Invoices rendered in nl-BE fallback")).toMatchObject({ value: "1", level: "warn" });
    // Another day: the fallback line counts only documents issued on that day.
    expect((await financeDigestCounts(h.db, "2026-11-05")).fallbackCount).toBe(0);
  });

  it("holds no names or emails", async () => {
    const section = JSON.stringify(await getFinanceDigest(h.db, DAY));
    const people = await h.db.select({ firstName: persons.firstName, lastName: persons.lastName, email: persons.email }).from(persons);
    expect(people.length).toBeGreaterThan(0);
    for (const p of people) {
      if (p.email) expect(section).not.toContain(p.email);
      if (p.lastName) expect(section).not.toContain(p.lastName);
    }
    expect(section).not.toMatch(/@/);
  });
});
