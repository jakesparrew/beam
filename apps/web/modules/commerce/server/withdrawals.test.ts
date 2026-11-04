/**
 * commerce-P6 withdrawals (rule 54, edge case 32): unused package units are refunded at once with
 * reason `withdrawal`, used units are deducted; a membership line becomes a customer-service task;
 * dated services are exempt; after the 14-day deadline `withdrawal_expired`; POS sales have no
 * withdrawal right; only the order's owner can withdraw.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson, makeProduct, makeUser } from "@beam/db/testing";
import { makePaidOrder } from "@beam/db/testing/commerce-factories";
import type { DbHandle, Tx } from "@beam/db";
import { activityEvents, payments, refunds } from "@beam/db/schema";

vi.mock("next/headers", () => ({ cookies: () => Promise.resolve({ get: () => undefined }), headers: () => Promise.resolve(new Headers()) }));
vi.mock("next/server", () => ({ after: () => undefined }));

const getGrantUsage = vi.fn<(...a: unknown[]) => unknown>();
const revokeGrantRemainder = vi.fn<(...a: unknown[]) => unknown>();
vi.mock("@/modules/credits/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getGrantUsage: (...a: unknown[]) => getGrantUsage(...a),
  revokeGrantRemainder: (...a: unknown[]) => revokeGrantRemainder(...a),
}));
vi.mock("@/modules/finance/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getInvoiceForOrder: () => Promise.resolve(null),
  markCreditNoteSettled: () => Promise.resolve(undefined),
}));
const createTask = vi.fn<(...a: unknown[]) => unknown>();
vi.mock("@/modules/crm/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createTask: (...a: unknown[]) => createTask(...a),
}));

const { withdrawOrder, withdrawalBlocker } = await import("./withdrawals");
const { createCtx, eq, and } = await import("@/lib/ctx");
const { makeCtx, resetRuntime, createFakeIntegrations } = await import("@/lib/testing");

let h: DbHandle;
let userId: string;

beforeAll(async () => {
  h = await createTestDb();
  makeCtx(h.db, { integrations: createFakeIntegrations() });
  userId = (await makeUser(h.db)).id;
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(() => {
  getGrantUsage.mockReset().mockResolvedValue({ grants: [] });
  revokeGrantRemainder.mockReset().mockResolvedValue({ revokedUnits: 0, grants: [] });
  createTask.mockReset().mockResolvedValue({ taskId: randomUUID(), created: true });
});

const NOW = new Date("2026-11-04T10:00:00.000Z");
const PAID_AT = new Date("2026-10-30T10:00:00.000Z");
const DAY = 86_400_000;

function asCustomer<T>(personId: string, fn: (tx: Tx, ctx: ReturnType<typeof createCtx>) => Promise<T>, now = NOW): Promise<T> {
  return h.db.transaction((tx) => fn(tx, createCtx({ tx, actor: { kind: "customer", userId, personId }, durableMode: "immediate", now })));
}

async function onlineOrder(personId: string, lines: Parameters<typeof makePaidOrder>[1]["lines"], total: number, channel: "portal" | "pos" = "portal") {
  const { order, lines: rows } = await makePaidOrder(h.db, { personId, lines, order: { channel, paidAt: PAID_AT, withdrawalUntilAt: channel === "pos" ? null : new Date(PAID_AT.getTime() + 14 * DAY) } });
  await h.db.insert(payments).values({ orderId: order.id, provider: "cash", status: "paid", amountCents: total, paidAt: PAID_AT });
  return { order, lines: rows };
}

describe("withdrawOrder (rule 54)", () => {
  it("refunds the unused units of a package with reason withdrawal and deducts the used ones", async () => {
    const person = await makePerson(h.db);
    const product = await makeProduct(h.db, { kind: "package" });
    const { order, lines } = await onlineOrder(person.id, [{ productId: product.id, productKind: "package", unitAmountCents: 20_000 }], 20_000);
    getGrantUsage.mockResolvedValue({ grants: [{ grantId: "g1", unitsGranted: 5, usedUnits: 2, remainingUnits: 3, status: "active", unitValueCents: 4000 }] });
    const out = await asCustomer(person.id, (tx, ctx) => withdrawOrder(tx, ctx, { orderId: order.id, lineIds: [lines[0]!.id] }, { personId: person.id }));
    expect(out.amountCents).toBe(12_000);
    expect(out.refundIds).toHaveLength(1);
    const [refund] = await h.db.select().from(refunds).where(eq(refunds.id, out.refundIds[0]!));
    expect(refund).toMatchObject({ reason: "withdrawal", amountCents: 12_000, status: "refunded", createdByUserId: userId });
    expect(revokeGrantRemainder).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ orderLineId: lines[0]!.id, grantIds: ["g1"] }));
    const events = await h.db.select().from(activityEvents).where(and(eq(activityEvents.kind, "order.withdrawn"), eq(activityEvents.personId, person.id)));
    expect(events).toHaveLength(1);
  });

  it("turns a membership line into a customer-service task and refunds nothing itself", async () => {
    const person = await makePerson(h.db);
    const product = await makeProduct(h.db, { kind: "membership" });
    const { order, lines } = await onlineOrder(person.id, [{ productId: product.id, productKind: "membership", unitAmountCents: 8900 }], 8900);
    const out = await asCustomer(person.id, (tx, ctx) => withdrawOrder(tx, ctx, { orderId: order.id, lineIds: [lines[0]!.id] }, { personId: person.id }));
    expect(out.refundIds).toEqual([]);
    expect(createTask).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ kind: "payment", ownerRole: "customer_service", personId: person.id, dedupeKey: `withdrawal:${lines[0]!.id}` }),
    );
    expect(await h.db.select().from(refunds).where(eq(refunds.orderId, order.id))).toHaveLength(0);
  });

  it("exempts dated services", async () => {
    const person = await makePerson(h.db);
    const { order, lines } = await onlineOrder(person.id, [{ productKind: "session", unitAmountCents: 4500, data: { booking_ids: [randomUUID()] } }], 4500);
    await expect(asCustomer(person.id, (tx, ctx) => withdrawOrder(tx, ctx, { orderId: order.id, lineIds: [lines[0]!.id] }, { personId: person.id }))).rejects.toMatchObject({
      message: "nothing_to_withdraw",
    });
  });

  it("refuses after the deadline, for POS sales and for another person's order", async () => {
    const person = await makePerson(h.db);
    const product = await makeProduct(h.db, { kind: "package" });
    const { order, lines } = await onlineOrder(person.id, [{ productId: product.id, productKind: "package", unitAmountCents: 20_000 }], 20_000);
    const late = new Date(PAID_AT.getTime() + 15 * DAY);
    await expect(asCustomer(person.id, (tx, ctx) => withdrawOrder(tx, ctx, { orderId: order.id, lineIds: [lines[0]!.id] }, { personId: person.id }), late)).rejects.toMatchObject({
      message: "withdrawal_expired",
    });
    const other = await makePerson(h.db);
    await expect(asCustomer(other.id, (tx, ctx) => withdrawOrder(tx, ctx, { orderId: order.id, lineIds: [lines[0]!.id] }, { personId: other.id }))).rejects.toMatchObject({
      message: "order_not_found",
    });

    const pos = await onlineOrder(person.id, [{ productId: product.id, productKind: "package", unitAmountCents: 20_000 }], 20_000, "pos");
    await expect(asCustomer(person.id, (tx, ctx) => withdrawOrder(tx, ctx, { orderId: pos.order.id, lineIds: [pos.lines[0]!.id] }, { personId: person.id }))).rejects.toMatchObject({
      message: "not_withdrawable",
    });
    expect(withdrawalBlocker(pos.order, NOW)).toBe("not_online");
    expect(withdrawalBlocker(order, NOW)).toBeNull();
  });
});
