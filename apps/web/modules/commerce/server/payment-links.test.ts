/**
 * commerce-P6 payment links and the pay page (rules 26a and 41): a token opens exactly its own
 * order; after its expiry or after payment the page shows the state, never a payment form; a link
 * order needs the terms checkbox and records the acceptance; `sendPaymentLink` enqueues
 * `payments.create_link`, which sends `commerce.payment_link` with the same URL.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson, makeProduct, makeUser } from "@beam/db/testing";
import { makeOrder, makeOrderLine } from "@beam/db/testing/commerce-factories";
import type { DbHandle, Tx } from "@beam/db";
import { activityEvents, emailMessages, jobs, orders, payments, termsAcceptances } from "@beam/db/schema";

vi.mock("next/headers", () => ({ cookies: () => Promise.resolve({ get: () => undefined }), headers: () => Promise.resolve(new Headers()) }));
vi.mock("next/server", () => ({ after: () => undefined }));

process.env.VOUCHER_CODE_SECRET = "test-pay-secret";

const { getPayLinkForOrder, getPayOrderByToken, payByToken, sendPaymentLink, createPayLinkJob } = await import("./payment-links");
const { createCtx, eq, and } = await import("@/lib/ctx");
const { makeCtx, resetRuntime, createFakeIntegrations, staffActor } = await import("@/lib/testing");

let h: DbHandle;
let staffUserId: string;

beforeAll(async () => {
  h = await createTestDb();
  makeCtx(h.db, { integrations: createFakeIntegrations() });
  staffUserId = (await makeUser(h.db)).id;
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

const DAY = 86_400_000;
type Ctx = ReturnType<typeof createCtx>;

function run<T>(fn: (tx: Tx, ctx: Ctx) => Promise<T>, opts: { now?: Date; staff?: boolean } = {}): Promise<T> {
  return h.db.transaction((tx) =>
    fn(tx, createCtx({ tx, actor: opts.staff ? staffActor({ userId: staffUserId, permissions: ["commerce.sell"] }) : { kind: "public" }, durableMode: "immediate", ...(opts.now ? { now: opts.now } : {}) })),
  );
}

async function linkOrder() {
  const person = await makePerson(h.db, { email: `pay-${Math.random().toString(36).slice(2)}@example.com` });
  const product = await makeProduct(h.db, { kind: "item", itemCategory: "merchandise" });
  const order = await makeOrder(h.db, { personId: person.id, channel: "link", expiresAt: new Date(Date.now() + 14 * DAY) });
  await makeOrderLine(h.db, { orderId: order.id, productId: product.id, unitAmountCents: 4500 });
  const link = await run((tx, ctx) => getPayLinkForOrder(tx, ctx, { orderId: order.id }));
  const token = link.payUrl.split("/pay/")[1]!;
  return { person, order, link, token };
}

describe("the pay page (rule 41)", () => {
  it("opens exactly the order its token names", async () => {
    const a = await linkOrder();
    const b = await linkOrder();
    expect(a.token).not.toBe(b.token);
    const viewA = await getPayOrderByToken(h.db, a.token);
    expect(viewA).toMatchObject({ state: "payable", orderId: a.order.id, reference: a.order.reference, totalCents: 4500, dueCents: 4500, needsTerms: true });
    expect((await getPayOrderByToken(h.db, b.token)).orderId).toBe(b.order.id);
    expect((await getPayOrderByToken(h.db, `${a.token.slice(0, -2)}xx`)).state).toBe("invalid");
    expect((await getPayOrderByToken(h.db, "short")).state).toBe("invalid");
  });

  it("shows the expired state after the link's expiry and refuses to pay", async () => {
    const { token, link } = await linkOrder();
    const later = new Date(link.expiresAt.getTime() + 1000);
    expect((await getPayOrderByToken(h.db, token, later)).state).toBe("expired");
    await expect(run((tx, ctx) => payByToken(tx, ctx, { token, clientKey: crypto.randomUUID(), acceptTerms: true }), { now: later })).rejects.toMatchObject({ message: "order_expired" });
  });

  it("shows the paid state, never a form, once the order is paid", async () => {
    const { order, token } = await linkOrder();
    await h.db.update(orders).set({ status: "paid", paidAt: new Date() }).where(eq(orders.id, order.id));
    const view = await getPayOrderByToken(h.db, token);
    expect(view.state).toBe("paid");
    expect(view.needsTerms).toBe(false);
    const out = await run((tx, ctx) => payByToken(tx, ctx, { token, clientKey: crypto.randomUUID() }));
    expect(out.redirectUrl).toContain(`/pay/${token}`);
  });

  it("needs the terms for a link order, records the acceptance and starts the payment", async () => {
    const { order, person, token } = await linkOrder();
    await expect(run((tx, ctx) => payByToken(tx, ctx, { token, clientKey: crypto.randomUUID() }))).rejects.toMatchObject({ code: "validation" });
    const out = await run((tx, ctx) => payByToken(tx, ctx, { token, clientKey: crypto.randomUUID(), acceptTerms: true }));
    expect(out.orderId).toBe(order.id);
    const accepted = await h.db.select().from(termsAcceptances).where(eq(termsAcceptances.personId, person.id));
    expect(accepted).toHaveLength(1);
    const pays = await h.db.select().from(payments).where(eq(payments.orderId, order.id));
    expect(pays).toHaveLength(1);
    expect(pays[0]!.providerPaymentId).toMatch(/^tr_/);
  });
});

describe("sendPaymentLink and payments.create_link", () => {
  it("enqueues the email job with the same link and writes payment_link.sent", async () => {
    const { order, person, link } = await linkOrder();
    const out = await run((tx, ctx) => sendPaymentLink(tx, ctx, { orderId: order.id }), { staff: true });
    expect(out.payUrl).toBe(link.payUrl);
    const key = `pay_link:${order.id}:${order.version}`;
    const [job] = await h.db.select().from(jobs).where(eq(jobs.idempotencyKey, key));
    expect(job).toMatchObject({ kind: "payments.create_link" });
    const events = await h.db.select().from(activityEvents).where(and(eq(activityEvents.kind, "payment_link.sent"), eq(activityEvents.personId, person.id)));
    expect(events).toHaveLength(1);

    const sent = await run((tx, ctx) => createPayLinkJob({ ...ctx, tx } as Ctx, job!.payload as { orderId: string; email: string; version: number }));
    expect(sent).toMatchObject({ payUrl: link.payUrl });
    const mails = await h.db.select().from(emailMessages).where(eq(emailMessages.idempotencyKey, key));
    expect(mails).toHaveLength(1);
    expect(mails[0]!.toEmail).toBe(person.email);
  });
});
