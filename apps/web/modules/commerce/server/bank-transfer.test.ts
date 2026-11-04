/**
 * commerce-P4b bank transfers (rules 43, 43a; finance rules 2, 2a): the placement passes `dueOn`
 * = the payment's `expires_at` date (today + 14 days, 23:59 Brussels) to
 * `issueInvoice({status: 'open'})`; `recordBankTransferPaid({orderId, paidOn, reference})` twice
 * settles once; a cancelled order ignores it; orders with a session line cannot wait 14 days.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@beam/db/testing";
import { makeOrder, makeOrderLine } from "@beam/db/testing/commerce-factories";
import type { DbHandle, Tx } from "@beam/db";
import { orders, payments } from "@beam/db/schema";

vi.mock("next/headers", () => ({ cookies: () => Promise.resolve({ get: () => undefined }), headers: () => Promise.resolve(new Headers()) }));
vi.mock("next/server", () => ({ after: () => undefined }));
const issueInvoice = vi.fn<(...a: unknown[]) => unknown>();
vi.mock("@/modules/finance/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  issueInvoice: (...a: unknown[]) => issueInvoice(...a),
}));

const { startBankTransfer, recordBankTransferPaid, bankTransferDue } = await import("./bank-transfer");
const { createCtx, eq } = await import("@/lib/ctx");
const { makeCtx, resetRuntime, createFakeIntegrations } = await import("@/lib/testing");

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
  makeCtx(h.db, { integrations: createFakeIntegrations() });
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(() => {
  issueInvoice.mockReset().mockImplementation((_tx: unknown, _ctx: unknown, input: { status?: string }) =>
    Promise.resolve({ status: input.status === "paid" ? "existing" : "issued", invoiceId: randomUUID(), number: "BEAM-2026-000042" }),
  );
});

const NOW = new Date("2026-11-04T10:00:00.000Z");

function inTx<T>(fn: (tx: Tx, ctx: ReturnType<typeof createCtx>) => Promise<T>, now = NOW): Promise<T> {
  return h.db.transaction((tx) => fn(tx, createCtx({ tx, actor: { kind: "system", jobId: "" }, durableMode: "immediate", now })));
}

async function itemOrder() {
  const order = await makeOrder(h.db, { channel: "admin", expiresAt: new Date(NOW.getTime() + 30 * 60_000) });
  await makeOrderLine(h.db, { orderId: order.id });
  return order;
}

describe("bankTransferDue", () => {
  it("is today + 14 days at 23:59 Brussels, across the DST change", () => {
    expect(bankTransferDue(new Date("2026-11-04T10:00:00Z"), 14)).toEqual({ dueOn: "2026-11-18", expiresAt: new Date("2026-11-18T22:59:00Z") });
    expect(bankTransferDue(new Date("2026-10-20T22:30:00Z"), 14)).toEqual({ dueOn: "2026-11-04", expiresAt: new Date("2026-11-04T22:59:00Z") });
  });
});

describe("startBankTransfer", () => {
  it("opens the transfer and issues the open invoice with the payment's due date", async () => {
    const order = await itemOrder();
    const r = await inTx((tx, ctx) => startBankTransfer(tx, ctx, { orderId: order.id }));
    expect(r.dueOn).toBe("2026-11-18");
    const [p] = await h.db.select().from(payments).where(eq(payments.id, r.paymentId));
    expect(p).toMatchObject({ provider: "bank_transfer", method: "banktransfer", status: "open", amountCents: 4500 });
    expect(p!.expiresAt!.toISOString()).toBe("2026-11-18T22:59:00.000Z");
    expect(issueInvoice).toHaveBeenCalledWith(expect.anything(), expect.anything(), { orderId: order.id, status: "open", dueOn: "2026-11-18", paymentId: r.paymentId });
    expect((await h.db.select().from(orders).where(eq(orders.id, order.id)))[0]!.expiresAt).toBeNull();

    // A second call returns the same open transfer.
    const again = await inTx((tx, ctx) => startBankTransfer(tx, ctx, { orderId: order.id }), new Date(NOW.getTime() + 86_400_000));
    expect(again.paymentId).toBe(r.paymentId);
    expect(again.dueOn).toBe("2026-11-18");
    expect(await h.db.select().from(payments).where(eq(payments.orderId, order.id))).toHaveLength(1);
  });

  it("is refused for an order with a session line", async () => {
    const order = await makeOrder(h.db, { channel: "admin" });
    await makeOrderLine(h.db, { orderId: order.id, productKind: "session", data: { booking_ids: [randomUUID()] } });
    await expect(inTx((tx, ctx) => startBankTransfer(tx, ctx, { orderId: order.id }))).rejects.toMatchObject({ code: "conflict", message: "bank_transfer_not_allowed" });
    expect(issueInvoice).not.toHaveBeenCalled();
  });
});

describe("recordBankTransferPaid", () => {
  it("settles the open transfer once and runs the paid transaction", async () => {
    const order = await itemOrder();
    const { paymentId } = await inTx((tx, ctx) => startBankTransfer(tx, ctx, { orderId: order.id }));
    issueInvoice.mockClear();

    const input = { orderId: order.id, paidOn: "2026-11-10", reference: "BEAM-2026-000042" };
    expect(await inTx((tx, ctx) => recordBankTransferPaid(tx, ctx, input))).toEqual({ applied: true });
    const [o] = await h.db.select().from(orders).where(eq(orders.id, order.id));
    expect(o!.status).toBe("paid");
    const [p] = await h.db.select().from(payments).where(eq(payments.id, paymentId));
    expect(p).toMatchObject({ status: "paid", amountCents: 4500, raw: { reference: "BEAM-2026-000042" } });
    expect(p!.paidAt!.toISOString()).toBe("2026-11-10T11:00:00.000Z"); // 12:00 Brussels
    expect(issueInvoice).toHaveBeenCalledTimes(1);
    expect(issueInvoice).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ orderId: order.id, status: "paid", paymentId }));

    expect(await inTx((tx, ctx) => recordBankTransferPaid(tx, ctx, input))).toEqual({ applied: false });
    expect(issueInvoice).toHaveBeenCalledTimes(1);
  });

  it("ignores a cancelled order", async () => {
    const order = await makeOrder(h.db, { channel: "admin", status: "cancelled", expiresAt: null });
    await makeOrderLine(h.db, { orderId: order.id });
    const [p] = await h.db.insert(payments).values({ orderId: order.id, provider: "bank_transfer", status: "cancelled", amountCents: 4500 }).returning();
    expect(await inTx((tx, ctx) => recordBankTransferPaid(tx, ctx, { orderId: order.id, paidOn: "2026-11-10", reference: "BEAM-2026-000043" }))).toEqual({ applied: false });
    expect((await h.db.select().from(payments).where(eq(payments.id, p!.id)))[0]!.status).toBe("cancelled");
    expect((await h.db.select().from(orders).where(eq(orders.id, order.id)))[0]!.status).toBe("cancelled");
    expect(issueInvoice).not.toHaveBeenCalled();
  });
});
