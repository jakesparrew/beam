/**
 * commerce-P4a `POST /api/webhooks/mollie` and the `mollie` webhook handler (spec section 4.4,
 * rule 30, edge cases 2 and 28): a bad token answers 401 and stores nothing; a duplicate delivery
 * gets its own inbox row but syncs once in effect; ids that are not payments, or that the provider
 * does not know, are ignored; a payment the database does not hold yet throws `RetryableError`.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson, makeProduct } from "@beam/db/testing";
import { makeOrder, makeOrderLine } from "@beam/db/testing/commerce-factories";
import type { Db, DbHandle } from "@beam/db";
import { activityEvents, jobs, orders, payments, webhookEvents } from "@beam/db/schema";
import { RetryableError } from "@beam/core/errors";
import type { WebhookHandlerDefinition } from "@/lib/webhooks";

vi.mock("next/headers", () => ({ cookies: () => Promise.resolve({ get: () => undefined }), headers: () => Promise.resolve(new Headers()) }));
vi.mock("next/server", () => ({ after: () => undefined }));
const issueInvoice = vi.fn();
vi.mock("@/modules/finance/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  issueInvoice: (...a: unknown[]) => issueInvoice(...a),
}));

const { POST } = await import("@/app/api/webhooks/mollie/route");
const { WEBHOOK_HANDLERS } = await import("@/registry/webhooks.generated");
const { eq, and } = await import("@/lib/ctx");
const { makeCtx, makeJobCtx, resetRuntime, createFakeIntegrations } = await import("@/lib/testing");

let h: DbHandle;
let fake: ReturnType<typeof createFakeIntegrations>;
const SECRET = "whsec_test_0123456789";
const handler = () => (WEBHOOK_HANDLERS as unknown as Record<string, WebhookHandlerDefinition>).mollie!;

beforeAll(async () => {
  h = await createTestDb();
});
beforeEach(() => {
  fake = createFakeIntegrations();
  makeCtx(h.db, { integrations: fake });
  process.env.MOLLIE_WEBHOOK_SECRET = SECRET;
  issueInvoice.mockReset().mockResolvedValue({ status: "issued", invoiceId: randomUUID(), number: "2026-000001" });
});
afterEach(() => {
  delete process.env.MOLLIE_WEBHOOK_SECRET;
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

const post = (id: string, token: string | null) =>
  POST(
    new Request(`http://localhost:3000/api/webhooks/mollie${token === null ? "" : `?t=${token}`}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `id=${id}`,
    }),
  );

/** Runs the registered handler in its own transaction, like `webhook.process`. */
async function handle(id: string): Promise<void> {
  await h.db.transaction(async (tx) => {
    const ctx = makeJobCtx(h.db as Db, "webhook.process", { integrations: fake, tx });
    await handler().handle(ctx, { id: randomUUID(), payload: { id } });
  });
}

/** An open order with a provider payment created in the fake. */
async function orderWithProviderPayment(amountCents = 4500) {
  const person = await makePerson(h.db);
  const product = await makeProduct(h.db, { kind: "item", priceCents: amountCents });
  const order = await makeOrder(h.db, { personId: person.id, channel: "portal", subtotalCents: amountCents, totalCents: amountCents });
  await makeOrderLine(h.db, { orderId: order.id, productId: product.id, unitAmountCents: amountCents });
  const [payment] = await h.db.insert(payments).values({ orderId: order.id, provider: "mollie", status: "open", amountCents }).returning();
  const created = await fake.payments.createPayment({
    amountCents,
    description: order.reference,
    redirectUrl: "http://localhost:3000/nl/account/checkout/return/x",
    webhookUrl: `http://localhost:3000/api/webhooks/mollie?t=${SECRET}`,
    locale: "nl-BE",
    sequenceType: "oneoff",
    metadata: { orderId: order.id, paymentId: payment!.id },
    idempotencyKey: `payment_create:${payment!.id}`,
  });
  await h.db.update(payments).set({ providerPaymentId: created.providerPaymentId, checkoutUrl: created.checkoutUrl }).where(eq(payments.id, payment!.id));
  return { person, order, paymentId: payment!.id, providerPaymentId: created.providerPaymentId };
}

describe("POST /api/webhooks/mollie", () => {
  it("answers 401 for a bad or missing token and stores nothing", async () => {
    const { providerPaymentId } = await orderWithProviderPayment();
    const before = (await h.db.select().from(webhookEvents)).length;
    expect((await post(providerPaymentId, "wrong")).status).toBe(401);
    expect((await post("", SECRET)).status).toBe(401);
    expect((await h.db.select().from(webhookEvents)).length).toBe(before);
  });

  it("stores each delivery and enqueues webhook.process", async () => {
    const { providerPaymentId } = await orderWithProviderPayment();
    const res = await post(providerPaymentId, SECRET);
    expect(res.status).toBe(200);
    const rows = (await h.db.select().from(webhookEvents)).filter((r) => (r.payload as { id?: string }).id === providerPaymentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.externalEventId).toMatch(new RegExp(`^${providerPaymentId}:\\d+$`));
    expect(await h.db.select().from(jobs).where(and(eq(jobs.kind, "webhook.process"), eq(jobs.id, rows[0]!.jobId!)))).toHaveLength(1);
  });
});

describe("the mollie webhook handler", () => {
  it("syncs a duplicate delivery once in effect (edge cases 2 and 28)", async () => {
    const { person, order, paymentId, providerPaymentId } = await orderWithProviderPayment();
    fake.payments.settle(providerPaymentId, "paid");
    await handle(providerPaymentId);
    await handle(providerPaymentId);
    const [p] = await h.db.select().from(payments).where(eq(payments.id, paymentId));
    expect(p!.status).toBe("paid");
    expect(p!.statusHistory.filter((s) => s.status === "paid")).toHaveLength(1);
    expect((await h.db.select().from(orders).where(eq(orders.id, order.id)))[0]!.status).toBe("paid");
    expect(issueInvoice).toHaveBeenCalledTimes(1);
    expect(await h.db.select().from(activityEvents).where(and(eq(activityEvents.kind, "order.paid"), eq(activityEvents.personId, person.id)))).toHaveLength(1);
  });

  it("ignores ids that are not payment ids and ids the provider does not know", async () => {
    await expect(handle("ord_123")).resolves.toBeUndefined();
    await expect(handle("tr_unknown123")).resolves.toBeUndefined();
  });

  it("throws RetryableError for a payment the database does not hold yet (platform edge case 8)", async () => {
    const created = await fake.payments.createPayment({
      amountCents: 1000,
      description: "BO-RACE0001",
      redirectUrl: "http://localhost:3000/",
      webhookUrl: "http://localhost:3000/api/webhooks/mollie",
      locale: "nl-BE",
      sequenceType: "oneoff",
      metadata: { orderId: randomUUID(), paymentId: randomUUID() },
      idempotencyKey: `race:${randomUUID()}`,
    });
    await expect(handle(created.providerPaymentId)).rejects.toBeInstanceOf(RetryableError);
  });
});
