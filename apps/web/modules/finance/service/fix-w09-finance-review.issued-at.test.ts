/**
 * fix-w09-finance-review finding 3 (rule 12): the issue instant is fixed under the sequence
 * lock, so an issuer whose context was created earlier but who reaches the lock later never
 * gets an earlier `issued_at` or `issued_on` than the lower number.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { issueCreditNote, issueInvoice } from "../api";
import { asTx, ctxAt, invoiceRow, paidOrder, payment, setupDb } from "./__tests__/fixtures";

vi.mock("@/registry/jobs.generated", async (importOriginal) => {
  const { withFinanceJobStubs } = await import("./__tests__/fixtures");
  return withFinanceJobStubs(await importOriginal<{ JOB_BY_KIND: Record<string, unknown> }>());
});

let h: DbHandle;
beforeAll(async () => {
  h = await setupDb();
});
afterAll(() => h.close());

/** 2026-11-05 00:00:01 Brussels (CET, UTC+1). */
const LATER = new Date("2026-11-04T23:00:01Z");
/** 2026-11-04 23:59:58 Brussels: a context created before LATER that reaches the lock after it. */
const EARLIER = new Date("2026-11-04T22:59:58Z");

async function issued(now: Date) {
  const { order } = await paidOrder(h.db);
  const pay = await payment(h.db, order.id, { amountCents: order.totalCents });
  const result = await issueInvoice(asTx(h.db), ctxAt(h.db, now), { orderId: order.id, paymentId: pay.id });
  if (result.status !== "issued") throw new Error(`not issued: ${result.status}`);
  return invoiceRow(h.db, result.invoiceId);
}

describe("issued_at under the sequence lock", () => {
  it("clamps an invoice whose context is older than the previous number's issue instant", async () => {
    const first = await issued(LATER);
    const second = await issued(EARLIER);
    expect(second.sequenceNumber).toBe(first.sequenceNumber + 1);
    expect(second.issuedAt.getTime()).toBeGreaterThanOrEqual(first.issuedAt.getTime());
    expect(second.issuedOn).toBe("2026-11-05");
    expect(second.issuedOn >= first.issuedOn).toBe(true);
  });

  it("keeps ctx.now when there is no inversion", async () => {
    const at = new Date("2026-11-06T09:00:00Z");
    const inv = await issued(at);
    expect(inv.issuedAt.toISOString()).toBe(at.toISOString());
    expect(inv.issuedOn).toBe("2026-11-06");
  });

  it("clamps credit notes the same way", async () => {
    const inv = await issued(new Date("2026-11-07T09:00:00Z"));
    const orderLineId = inv.lines[0]!.order_line_id!;
    const input = { invoiceId: inv.id, reason: "Goodwill", noRefund: true, lines: [{ orderLineId, amountCents: 100 }] };
    const a = await issueCreditNote(asTx(h.db), ctxAt(h.db, new Date("2026-11-07T10:00:00Z")), input);
    const b = await issueCreditNote(asTx(h.db), ctxAt(h.db, new Date("2026-11-07T09:30:00Z")), input);
    const [na, nb] = [await invoiceRow(h.db, a.creditNoteId), await invoiceRow(h.db, b.creditNoteId)];
    expect(nb.sequenceNumber).toBe(na.sequenceNumber + 1);
    expect(nb.issuedAt.getTime()).toBeGreaterThanOrEqual(na.issuedAt.getTime());
  });
});
