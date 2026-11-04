/**
 * commerce-P7 POS day summary and day close (rule 55, edge case 31): the expected cash is the
 * float plus the day's cash payments minus its cash refunds; a difference needs a note; a
 * difference above EUR 20 opens one finance task, also after a reopen and a second close;
 * reopening needs `commerce.refund`.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makeProduct, makeUser } from "@beam/db/testing";
import type { DbHandle, Tx } from "@beam/db";
import { auditLog, payments, posDayCloses, refunds, tasks } from "@beam/db/schema";

vi.mock("next/headers", () => ({ cookies: () => Promise.resolve({ get: () => undefined }), headers: () => Promise.resolve(new Headers()) }));
vi.mock("next/server", () => ({ after: () => undefined }));
const issueInvoice = vi.fn<(...a: unknown[]) => unknown>();
vi.mock("@/modules/finance/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  issueInvoice: (...a: unknown[]) => issueInvoice(...a),
}));

const { closePosDay, reopenPosDay, getPosDaySummary, businessDayOf, businessDayRange } = await import("./pos-day");
const { posSell } = await import("./pos");
const { createCtx, eq, and } = await import("@/lib/ctx");
const { makeCtx, resetRuntime, createFakeIntegrations, staffActor } = await import("@/lib/testing");

let h: DbHandle;
let staffUserId: string;
type Ctx = ReturnType<typeof createCtx>;
const FLOAT = 15_000;

beforeAll(async () => {
  h = await createTestDb();
  makeCtx(h.db, { integrations: createFakeIntegrations() });
  staffUserId = (await makeUser(h.db)).id;
  // crm's createTask gives a finance task to a user with the finance role.
  await makeUser(h.db, { roleKey: "finance" });
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(() => {
  issueInvoice.mockReset().mockResolvedValue({ status: "issued", invoiceId: randomUUID(), number: "BEAM-2026-000001" });
});

/** A business day `n` days after today (prices valid now apply; days never overlap between tests). */
function dayAhead(n: number): { day: string; at: (hhmm: string) => Date } {
  const day = businessDayOf(new Date(Date.now() + n * 86_400_000));
  const { from } = businessDayRange(day);
  return { day, at: (hhmm) => new Date(from.getTime() + (Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3))) * 60_000) };
}

function asStaff<T>(fn: (tx: Tx, ctx: Ctx) => Promise<T>, now: Date, permissions: string[] = ["commerce.sell"]): Promise<T> {
  return h.db.transaction((tx) => fn(tx, createCtx({ tx, actor: staffActor({ userId: staffUserId, permissions }), durableMode: "immediate", now })));
}

async function cashSale(at: Date, priceCents: number) {
  const product = await makeProduct(h.db, { kind: "item", priceCents, itemCategory: "merchandise" });
  return asStaff((tx, ctx) => posSell(tx, ctx, { items: [{ productId: product.id, quantity: 1 }], method: "cash", cashReceivedCents: priceCents, clientKey: randomUUID() }), at);
}

describe("getPosDaySummary (rule 55)", () => {
  it("counts the float, cash, terminal and cash refunds of the day into the expected cash", async () => {
    const { day, at } = dayAhead(3);
    const a = await cashSale(at("10:00"), 4500);
    await cashSale(at("11:00"), 2000);
    // A terminal sale paid that day.
    const product = await makeProduct(h.db, { kind: "item", priceCents: 3000, itemCategory: "merchandise" });
    const term = await asStaff((tx, ctx) => posSell(tx, ctx, { items: [{ productId: product.id, quantity: 1 }], method: "terminal", terminalId: "term_xxx", clientKey: randomUUID() }), at("12:00"));
    await h.db.update(payments).set({ status: "paid", paidAt: at("12:01") }).where(eq(payments.orderId, term.orderId));
    // A cash refund of 10 euro on the first sale, the same day.
    const [cash] = await h.db.select().from(payments).where(eq(payments.orderId, a.orderId));
    await h.db.insert(refunds).values({
      paymentId: cash!.id,
      orderId: a.orderId,
      amountCents: 1000,
      reason: "damaged item",
      lines: [],
      creditAction: "none",
      status: "refunded",
      createdByUserId: staffUserId,
      createdAt: at("15:00"),
    });

    const summary = await getPosDaySummary(h.db, { day });
    expect(summary.totals).toMatchObject({ cash: 6500, terminal: 3000, refunds: 1000, cash_refunds: 1000, refund_count: 1, orders: 3, float: FLOAT });
    expect(summary.expectedCashCents).toBe(FLOAT + 6500 - 1000);
    expect(summary.close).toMatchObject({ status: "open", countedCashCents: null, frozen: null });
    // Another day sees none of it.
    expect((await getPosDaySummary(h.db, { day: dayAhead(30).day })).totals).toMatchObject({ cash: 0, terminal: 0, orders: 0 });
  });
});

describe("closePosDay (rule 55)", () => {
  it("requires a note when the counted cash differs, freezes the totals and audits the close", async () => {
    const { day, at } = dayAhead(4);
    await cashSale(at("09:30"), 2500);
    const expected = FLOAT + 2500;
    await expect(asStaff((tx, ctx) => closePosDay(tx, ctx, { businessDayOn: day, countedCashCents: expected + 100 }), at("20:00"))).rejects.toMatchObject({
      fields: { note: "required" },
    });
    const out = await asStaff((tx, ctx) => closePosDay(tx, ctx, { businessDayOn: day, countedCashCents: expected + 100, note: "one euro coin extra" }), at("20:00"));
    expect(out).toMatchObject({ differenceCents: 100, expectedCashCents: expected, taskId: null });
    const [row] = await h.db.select().from(posDayCloses).where(eq(posDayCloses.businessDayOn, day));
    expect(row).toMatchObject({ status: "closed", countedCashCents: expected + 100, differenceCents: 100, note: "one euro coin extra", closedByUserId: staffUserId });
    expect(row!.totals).toMatchObject({ cash: 2500, float: FLOAT });
    expect(await h.db.select().from(auditLog).where(and(eq(auditLog.entityId, row!.id), eq(auditLog.action, "pos.day_closed")))).toHaveLength(1);
    expect((await getPosDaySummary(h.db, { day })).close).toMatchObject({ status: "closed", differenceCents: 100 });
    // A closed day cannot be closed twice.
    await expect(asStaff((tx, ctx) => closePosDay(tx, ctx, { businessDayOn: day, countedCashCents: expected }), at("20:05"))).rejects.toMatchObject({ message: "invalid_transition" });
  });

  it("closes without a note when the count matches and refuses a day in the future", async () => {
    const { day, at } = dayAhead(5);
    expect(await asStaff((tx, ctx) => closePosDay(tx, ctx, { businessDayOn: day, countedCashCents: FLOAT }), at("18:00"))).toMatchObject({ differenceCents: 0, taskId: null });
    const later = dayAhead(6).day;
    await expect(asStaff((tx, ctx) => closePosDay(tx, ctx, { businessDayOn: later, countedCashCents: FLOAT }), at("18:00"))).rejects.toMatchObject({
      fields: { businessDayOn: "in_the_future" },
    });
  });

  it("opens one finance task for a difference above 20 euro, also after a reopen and a second close", async () => {
    const { day, at } = dayAhead(7);
    await cashSale(at("10:00"), 5000);
    const expected = FLOAT + 5000;
    const first = await asStaff((tx, ctx) => closePosDay(tx, ctx, { businessDayOn: day, countedCashCents: expected - 2500, note: "short in the drawer" }), at("19:00"));
    expect(first.differenceCents).toBe(-2500);
    expect(first.taskId).not.toBeNull();
    await asStaff((tx, ctx) => reopenPosDay(tx, ctx, { businessDayOn: day, reason: "recount the drawer" }), at("19:10"), ["commerce.sell", "commerce.refund"]);
    const second = await asStaff((tx, ctx) => closePosDay(tx, ctx, { businessDayOn: day, countedCashCents: expected - 3000, note: "still short" }), at("19:20"));
    expect(second.taskId).toBe(first.taskId);
    expect(await h.db.select().from(tasks).where(eq(tasks.dedupeKey, `pos_close:${day}`))).toHaveLength(1);
  });

  it("opens no task for a difference of exactly 20 euro", async () => {
    const { day, at } = dayAhead(8);
    const out = await asStaff((tx, ctx) => closePosDay(tx, ctx, { businessDayOn: day, countedCashCents: FLOAT + 2000, note: "found a note" }), at("19:00"));
    expect(out.taskId).toBeNull();
    expect(await h.db.select().from(tasks).where(eq(tasks.dedupeKey, `pos_close:${day}`))).toHaveLength(0);
  });
});

describe("reopenPosDay (rule 55)", () => {
  it("needs commerce.refund, audits the reopen and takes cash again", async () => {
    const { day, at } = dayAhead(9);
    await asStaff((tx, ctx) => closePosDay(tx, ctx, { businessDayOn: day, countedCashCents: FLOAT }), at("18:00"));
    await expect(cashSale(at("18:30"), 1000)).rejects.toMatchObject({ message: "day_closed" });
    await expect(asStaff((tx, ctx) => reopenPosDay(tx, ctx, { businessDayOn: day, reason: "late customer" }), at("18:40"))).rejects.toMatchObject({ name: "ForbiddenError" });
    expect(await asStaff((tx, ctx) => reopenPosDay(tx, ctx, { businessDayOn: day, reason: "late customer" }), at("18:40"), ["commerce.sell", "commerce.refund"])).toEqual({ ok: true });
    const [row] = await h.db.select().from(posDayCloses).where(eq(posDayCloses.businessDayOn, day));
    expect(row).toMatchObject({ status: "open", countedCashCents: null, closedAt: null });
    expect(await h.db.select().from(auditLog).where(and(eq(auditLog.entityId, row!.id), eq(auditLog.action, "pos.day_reopened")))).toHaveLength(1);
    expect((await cashSale(at("18:45"), 1000)).status).toBe("paid");
    // Reopening an open day is refused.
    await expect(asStaff((tx, ctx) => reopenPosDay(tx, ctx, { businessDayOn: day, reason: "again" }), at("18:50"), ["commerce.sell", "commerce.refund"])).rejects.toMatchObject({
      message: "invalid_transition",
    });
  });
});
