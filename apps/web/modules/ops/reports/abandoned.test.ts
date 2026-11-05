/**
 * ops rule 40 (ops-P7): the abandoned checkout report. Abandoned count, recovered count (a paid
 * `recovered_order_id`), recovery rate, recovery revenue and failure share; tester persons are
 * left out, guest checkouts count; the table carries the recovery message status and the
 * outcome, never the email address; the CSV has exactly the table rows.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "@beam/db";
import { checkouts, emailMessages } from "@beam/db/schema";
import { createTestDb } from "@beam/db/testing";
import { makeOrder, makePaidOrder } from "@beam/db/testing/commerce-factories";
import { sql } from "@/lib/ctx";
import { resetRuntime, staffActor } from "@/lib/testing";
import { makeCustomer } from "../dashboard/ops-p3.fixtures";
import { getAbandonedCheckoutReport } from "../retention/queries";
import { computeAbandonedReport } from "./abandoned";
import { REPORT_CSV } from "./registry";

let h: DbHandle;
const NOW = new Date("2026-11-05T10:00:00Z");
const RANGE = { from: "2026-10-01", to: "2026-10-31" };
const oct = (day: number) => new Date(Date.UTC(2026, 9, day, 12));

beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  await h.db.execute(sql`update checkouts set abandoned_at = abandoned_at - interval '400 days' where abandoned_at is not null`);
});

type Reason = "left" | "payment_failed" | "payment_expired";

async function abandoned(input: { personId?: string; email?: string; at: Date; reason: Reason; totalCents: number; recoveredOrderId?: string; recoveryMessageId?: string; quantity?: number }) {
  const [row] = await h.db
    .insert(checkouts)
    .values({
      personId: input.personId ?? null,
      email: input.email ?? null,
      channel: "site",
      items: [{ productId: randomUUID(), quantity: input.quantity ?? 1 }],
      totalCents: input.totalCents,
      status: input.recoveredOrderId ? "completed" : "abandoned",
      abandonedAt: input.at,
      abandonedReason: input.reason,
      ...(input.recoveredOrderId ? { recoveredOrderId: input.recoveredOrderId, recoveredAt: new Date(input.at.getTime() + 3_600_000) } : {}),
      ...(input.recoveryMessageId ? { recoveryMessageId: input.recoveryMessageId } : {}),
    })
    .returning();
  return row!;
}

async function recoveryMessage(personId: string, status: "delivered" | "queued") {
  const [m] = await h.db
    .insert(emailMessages)
    .values({ personId, toEmail: "recover@example.com", kind: "transactional", locale: "nl-BE", idempotencyKey: `checkout-recovery:${randomUUID()}`, status })
    .returning();
  return m!;
}

describe("rule 40: getAbandonedCheckoutReport", () => {
  it("abandoned, recovered, rate, recovery revenue and failure share; testers out, guests in", async () => {
    const a = await makeCustomer(h.db);
    const b = await makeCustomer(h.db);
    const tester = await makeCustomer(h.db, { isTester: true });
    const { order: paid } = await makePaidOrder(h.db, { personId: a.id, lines: [{ lineTotalCents: 9_000, unitAmountCents: 9_000 }] });
    const unpaid = await makeOrder(h.db, { personId: b.id, status: "pending_payment" });
    const message = await recoveryMessage(a.id, "delivered");
    const recovered = await abandoned({ personId: a.id, at: oct(3), reason: "left", totalCents: 9_000, recoveredOrderId: paid.id, recoveryMessageId: message.id, quantity: 2 });
    const notPaid = await abandoned({ personId: b.id, at: oct(5), reason: "payment_failed", totalCents: 4_500, recoveredOrderId: unpaid.id });
    const guest = await abandoned({ email: "guest@example.com", at: oct(7), reason: "payment_expired", totalCents: 3_000 });
    await abandoned({ personId: b.id, at: oct(9), reason: "left", totalCents: 1_000 });
    await abandoned({ personId: tester.id, at: oct(9), reason: "payment_failed", totalCents: 99_000 });
    await abandoned({ personId: b.id, at: new Date(Date.UTC(2026, 8, 15, 12)), reason: "left", totalCents: 1_000 }); // September

    const r = await computeAbandonedReport(h.db, { range: RANGE });
    expect(r).toMatchObject({ abandoned: 4, recovered: 1, recoveryRate: 0.25, recoveryRevenueCents: 9_000, abandonedValueCents: 17_500, paymentFailures: 2, failureShare: 0.5 });
    expect(r.rows.map((x) => x.checkoutId)).toContain(guest.id);
    expect(r.rows.find((x) => x.checkoutId === recovered.id)).toMatchObject({ personId: a.id, itemCount: 2, valueCents: 9_000, recoveryStatus: "delivered", outcome: "recovered", recoveredRevenueCents: 9_000 });
    expect(r.rows.find((x) => x.checkoutId === notPaid.id)).toMatchObject({ outcome: "open", recoveredRevenueCents: null, hadPaymentFailure: true });
    expect(r.rows.find((x) => x.checkoutId === guest.id)).toMatchObject({ personId: null, name: null, hadPaymentFailure: true });
    expect(JSON.stringify(r)).not.toContain("guest@example.com");
  });

  it("is empty with null rates when nothing was abandoned", async () => {
    expect(await computeAbandonedReport(h.db, { range: { from: "2025-01-01", to: "2025-01-31" } })).toMatchObject({ abandoned: 0, recovered: 0, recoveryRate: null, failureShare: null, rows: [] });
  });

  it("needs reports.read, and the CSV has exactly the table rows", async () => {
    const p = await makeCustomer(h.db);
    const c = await abandoned({ personId: p.id, at: oct(12), reason: "left", totalCents: 2_500 });
    const ctx = { tx: h.db, actor: staffActor({ permissions: ["reports.read"] }), now: NOW, locale: "en" as const };
    const page = await getAbandonedCheckoutReport(ctx, RANGE);
    await expect(getAbandonedCheckoutReport({ ...ctx, actor: staffActor({ permissions: [] }) }, RANGE)).rejects.toMatchObject({ name: "ForbiddenError" });
    const rows: unknown[][] = [];
    for await (const row of REPORT_CSV["abandoned-checkouts"](ctx, RANGE)) rows.push(row);
    expect(rows.map((r) => r[0])).toEqual(page.rows.map((r) => r.checkoutId));
    expect(rows.find((r) => r[0] === c.id)).toEqual([c.id, p.id, oct(12).toISOString(), "left", 1, 2_500, false, "", "", "", "open"]);
  });
});
