/**
 * commerce-P6 staff orders (rules 22a, 22b, 43): `createStaffOrder` writes a draft without expiry
 * or promotion reservation; `choosePaymentPath` moves it to `pending_payment` on each path (POS,
 * payment link with the terms version, bank transfer with its open invoice); bank transfer is
 * refused with session lines; the staff cancel is refused while a provider payment is live; a
 * cancelled bank-transfer order credits its open invoice.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson, makeProduct, makeSession, makeUser } from "@beam/db/testing";
import { ensureTermsVersion } from "@beam/db/testing/commerce-factories";
import type { DbHandle, Tx } from "@beam/db";
import { auditLog, orders, payments, promotionRedemptions, promotions } from "@beam/db/schema";

vi.mock("next/headers", () => ({ cookies: () => Promise.resolve({ get: () => undefined }), headers: () => Promise.resolve(new Headers()) }));
vi.mock("next/server", () => ({ after: () => undefined }));

const issueInvoice = vi.fn<(...a: unknown[]) => unknown>();
const getInvoiceForOrder = vi.fn<(...a: unknown[]) => unknown>();
const issueCreditNote = vi.fn<(...a: unknown[]) => unknown>();
vi.mock("@/modules/finance/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  issueInvoice: (...a: unknown[]) => issueInvoice(...a),
  getInvoiceForOrder: (...a: unknown[]) => getInvoiceForOrder(...a),
  issueCreditNote: (...a: unknown[]) => issueCreditNote(...a),
}));

const { createStaffOrder, choosePaymentPath, staffCancelOrder } = await import("./staff-orders");
const { createCtx, eq } = await import("@/lib/ctx");
const { makeCtx, resetRuntime, createFakeIntegrations, staffActor } = await import("@/lib/testing");

let h: DbHandle;
let staffUserId: string;

beforeAll(async () => {
  h = await createTestDb();
  makeCtx(h.db, { integrations: createFakeIntegrations() });
  staffUserId = (await makeUser(h.db)).id;
  await ensureTermsVersion(h.db);
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(() => {
  issueInvoice.mockReset().mockResolvedValue({ status: "issued", invoiceId: randomUUID(), number: "BEAM-2026-000001" });
  getInvoiceForOrder.mockReset().mockResolvedValue(null);
  issueCreditNote.mockReset().mockResolvedValue({ creditNoteId: randomUUID(), number: "CN-2026-000001", totalCents: -4500 });
});

function asStaff<T>(fn: (tx: Tx, ctx: ReturnType<typeof createCtx>) => Promise<T>): Promise<T> {
  return h.db.transaction((tx) => fn(tx, createCtx({ tx, actor: staffActor({ userId: staffUserId, permissions: ["commerce.sell"] }), durableMode: "immediate" })));
}

const orderRow = async (id: string) => (await h.db.select().from(orders).where(eq(orders.id, id)))[0]!;

async function draftFor(kind: "item" | "package" = "item", promoCode?: string) {
  const person = await makePerson(h.db);
  const product = await makeProduct(h.db, { kind, priceCents: 4500, ...(kind === "item" ? { itemCategory: "merchandise" } : {}) });
  const out = await asStaff((tx, ctx) => createStaffOrder(tx, ctx, { personId: person.id, items: [{ productId: product.id, quantity: 1 }], ...(promoCode ? { promoCode } : {}) }));
  return { person, product, ...out };
}

describe("createStaffOrder and choosePaymentPath (rule 22a)", () => {
  it("writes a draft without expiry or promotion reservation and audits it", async () => {
    const code = `STAFF${randomUUID().replace(/[^0-9A-F]/gi, "").slice(0, 6).toUpperCase()}`;
    await h.db.insert(promotions).values({ code, name: { en: "Ten off", "nl-BE": "Tien eraf", "fr-BE": "Dix de moins" }, kind: "fixed", value: 1000, startsAt: new Date("2026-01-01"), createdByUserId: staffUserId });
    const { orderId, totalCents } = await draftFor("item", code);
    const order = await orderRow(orderId);
    expect(order).toMatchObject({ status: "draft", channel: "admin", expiresAt: null, createdByUserId: staffUserId });
    expect(totalCents).toBe(3500);
    expect(await h.db.select().from(promotionRedemptions).where(eq(promotionRedemptions.orderId, orderId))).toHaveLength(0);
    expect(await h.db.select().from(auditLog).where(eq(auditLog.entityId, orderId))).toHaveLength(1);

    // Choosing the POS path reserves the promotion and moves the draft to pending_payment.
    expect(await asStaff((tx, ctx) => choosePaymentPath(tx, ctx, { orderId, path: "pos" }))).toEqual({ status: "pending_payment" });
    const after = await orderRow(orderId);
    expect(after.status).toBe("pending_payment");
    expect(after.expiresAt).not.toBeNull();
    expect(after.version).toBe(order.version + 1);
    expect(await h.db.select().from(promotionRedemptions).where(eq(promotionRedemptions.orderId, orderId))).toHaveLength(1);
    // A second choice is refused: the order is no longer a draft.
    await expect(asStaff((tx, ctx) => choosePaymentPath(tx, ctx, { orderId, path: "link" }))).rejects.toMatchObject({ message: "invalid_transition" });
  });

  it("the link path makes a link order with the terms version", async () => {
    const { orderId } = await draftFor();
    expect(await asStaff((tx, ctx) => choosePaymentPath(tx, ctx, { orderId, path: "link" }))).toEqual({ status: "pending_payment" });
    const order = await orderRow(orderId);
    expect(order.channel).toBe("link");
    expect(order.termsVersionId).not.toBeNull();
  });

  it("the bank-transfer path opens the transfer and its open invoice", async () => {
    const { orderId } = await draftFor("package");
    const out = await asStaff((tx, ctx) => choosePaymentPath(tx, ctx, { orderId, path: "bank_transfer" }));
    expect(out.status).toBe("pending_payment");
    expect(out.dueOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const pays = await h.db.select().from(payments).where(eq(payments.orderId, orderId));
    expect(pays).toMatchObject([{ provider: "bank_transfer", status: "open", amountCents: 4500 }]);
    expect(issueInvoice).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ orderId, status: "open", dueOn: out.dueOn }));
    expect((await orderRow(orderId)).expiresAt).toBeNull();

    // Cancelling it credits the open invoice in the same transaction.
    getInvoiceForOrder.mockResolvedValue({ id: randomUUID(), kind: "invoice", number: "BEAM-2026-000002", issuedOn: "2026-11-04", status: "open", totalCents: 4500, isCompany: false, pdfReady: false });
    await asStaff((tx, ctx) => staffCancelOrder(tx, ctx, { orderId, reason: "customer changed mind" }));
    expect(issueCreditNote).toHaveBeenCalledWith(expect.anything(), expect.anything(), { orderId, reason: "customer changed mind", noRefund: true });
    expect((await orderRow(orderId)).status).toBe("cancelled");
  });

  it("refuses bank transfer for an order with a session line", async () => {
    const person = await makePerson(h.db);
    const product = await makeProduct(h.db, { kind: "session", priceCents: 4500 });
    const session = await makeSession(h.db);
    const { orderId } = await asStaff((tx, ctx) =>
      createStaffOrder(tx, ctx, { personId: person.id, items: [{ productId: product.id, quantity: 1, sessionId: session.id, bookingIds: [randomUUID()] }] }),
    );
    await expect(asStaff((tx, ctx) => choosePaymentPath(tx, ctx, { orderId, path: "bank_transfer" }))).rejects.toMatchObject({ message: "bank_transfer_not_allowed" });
    expect((await orderRow(orderId)).status).toBe("draft");
  });

  it("refuses the staff cancel while a provider payment is live", async () => {
    const { orderId } = await draftFor();
    await asStaff((tx, ctx) => choosePaymentPath(tx, ctx, { orderId, path: "pos" }));
    await h.db.insert(payments).values({ orderId, provider: "mollie", status: "open", amountCents: 4500, providerPaymentId: `tr_${randomUUID().slice(0, 8)}` });
    await expect(asStaff((tx, ctx) => staffCancelOrder(tx, ctx, { orderId, reason: "wrong product" }))).rejects.toMatchObject({ message: "payment_in_progress" });
    expect((await orderRow(orderId)).status).toBe("pending_payment");
  });
});
