/**
 * finance-P4 `finance.scan_overdue` (finance rule 29, edge cases 13 and 20): `invoice.overdue` and
 * one `payment` task once at day 7, the task due the next business day at 10:00 Brussels, and for
 * an erased person's invoice a task without an event.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@beam/db";
import { invoices, tasks } from "@beam/db/schema";
import { reduceSnapshot } from "@beam/core/finance";
import { eq, sql } from "@/lib/ctx";
import { createFakeIntegrations } from "@/lib/testing";
import { financeUser, openInvoice, runJob } from "./finance-p4.helpers";
import { eventsOf, invoiceRow, setupDb } from "./service/__tests__/fixtures";

let h: DbHandle;
let financeUserId: string;
const fakes = createFakeIntegrations();
beforeAll(async () => {
  h = await setupDb();
  financeUserId = (await financeUser(h.db)).id;
});
afterAll(() => h.close());

/** An open invoice issued 14 days before `dueOn` (the default payment terms). */
async function dueOn(day: string, personId?: string | null) {
  const issued = new Date(`${day}T10:00:00Z`);
  issued.setUTCDate(issued.getUTCDate() - 14);
  return openInvoice(h.db, { now: issued, dueOn: day, ...(personId === undefined ? {} : { personId }) });
}

const scan = (now: Date) => runJob(h.db, "finance.scan_overdue", {}, { integrations: fakes, now });
const overdueEvents = async (invoiceId: string) => (await eventsOf(h.db, "invoice.overdue")).filter((e) => (e.data as { invoice_id: string }).invoice_id === invoiceId);
const taskOf = (invoiceId: string) => h.db.select().from(tasks).where(eq(tasks.dedupeKey, `invoice:${invoiceId}:overdue_task`));

describe("finance.scan_overdue", () => {
  it("day 6 does nothing; day 7 records the event and the payment task once", async () => {
    const doc = await dueOn("2026-10-28");
    expect((await invoiceRow(h.db, doc.invoiceId)).dueOn).toBe("2026-10-28");

    await scan(new Date("2026-11-03T06:40:00Z")); // day 6
    expect(await overdueEvents(doc.invoiceId)).toHaveLength(0);
    expect(await taskOf(doc.invoiceId)).toHaveLength(0);

    const now = new Date("2026-11-04T06:40:00Z"); // Wednesday, day 7
    await scan(now);
    await scan(now);
    await scan(new Date("2026-11-05T06:40:00Z"));
    const events = await overdueEvents(doc.invoiceId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ personId: doc.personId, data: { invoice_id: doc.invoiceId, number: doc.number, days_overdue: 7, total_cents: 12_100 } });
    const t = await taskOf(doc.invoiceId);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({
      kind: "payment",
      priority: "high",
      title: `Follow up overdue invoice ${doc.number}`,
      source: "system",
      refType: "invoice",
      refId: doc.invoiceId,
      personId: doc.personId,
      ownerUserId: financeUserId,
    });
    expect(t[0]!.dueAt).toEqual(new Date("2026-11-05T09:00:00Z")); // Thursday 10:00 Brussels
  });

  it("when day 7 is a Saturday the task is due Monday 10:00 Brussels", async () => {
    const doc = await dueOn("2026-10-31");
    await scan(new Date("2026-11-07T06:40:00Z")); // Saturday
    const [t] = await taskOf(doc.invoiceId);
    expect(t!.dueAt).toEqual(new Date("2026-11-09T09:00:00Z"));
  });

  it("an erased person's invoice gets the task with its ref only and no event", async () => {
    const doc = await dueOn("2026-10-20");
    const inv = await invoiceRow(h.db, doc.invoiceId);
    await h.db.transaction(async (tx) => {
      await tx.execute(sql`set local beam.allow_rewrite = 'on'`);
      await tx.update(invoices).set({ personId: null, customerSnapshot: reduceSnapshot(inv.customerSnapshot) }).where(eq(invoices.id, doc.invoiceId));
    });
    await scan(new Date("2026-11-04T06:40:00Z"));
    expect(await overdueEvents(doc.invoiceId)).toHaveLength(0);
    const [t] = await taskOf(doc.invoiceId);
    expect(t).toMatchObject({ kind: "payment", personId: null, companyId: null, refType: "invoice", refId: doc.invoiceId });
  });

  it("a later run finds the overdue invoices again but creates no second task", async () => {
    const result = (await scan(new Date("2026-11-04T06:40:00Z"))).result as { scanned: number; tasks: number };
    expect(result.tasks).toBe(0);
    expect(result.scanned).toBeGreaterThan(0);
  });
});
