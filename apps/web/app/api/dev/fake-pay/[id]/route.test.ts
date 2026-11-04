/**
 * The runtime payments fake's pay page (runbook BS-9): 404 in production and for unknown ids;
 * the page shows the amount and the three outcome buttons; a click settles the fake payment,
 * posts the webhook exactly as Mollie does and redirects to the payment's `redirectUrl`.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { webhookEvents } from "@beam/db/schema";
import { createPaymentsFake } from "@beam/integrations/payments";

vi.mock("next/headers", () => ({ cookies: () => Promise.resolve({ get: () => undefined }), headers: () => Promise.resolve(new Headers()) }));
vi.mock("next/server", () => ({ after: () => undefined }));

const { GET, POST } = await import("./route");
const { setAppDb } = await import("@/lib/ctx");
const { resetRuntime } = await import("@/lib/testing");
const { setIntegrations, createFakeIntegrations } = await import("@/lib/integrations");

let h: DbHandle;
const SECRET = "whsec_fakepay_0123456789";
const fake = createPaymentsFake();

beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
  // The route reads the process-wide fake store; the webhook route verifies with the same fake.
  setIntegrations({ ...createFakeIntegrations(), payments: fake });
  process.env.MOLLIE_WEBHOOK_SECRET = SECRET;
});
afterEach(() => {
  delete process.env.APP_ENV;
});
afterAll(async () => {
  delete process.env.MOLLIE_WEBHOOK_SECRET;
  resetRuntime();
  await h.close();
});

async function fakePayment() {
  return fake.createPayment({
    amountCents: 4500,
    description: "BO-FAKEPAY1",
    redirectUrl: "http://localhost:3000/nl/account/checkout/return/abc",
    webhookUrl: `http://localhost:3000/api/webhooks/mollie?t=${SECRET}`,
    locale: "nl-BE",
    sequenceType: "oneoff",
    metadata: { orderId: randomUUID(), paymentId: randomUUID() },
    idempotencyKey: `fakepay:${randomUUID()}`,
  });
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe("GET /api/dev/fake-pay/[id]", () => {
  it("shows the amount and the Pay, Fail and Cancel buttons", async () => {
    const p = await fakePayment();
    const res = await GET(new Request(`http://localhost:3000/api/dev/fake-pay/${p.providerPaymentId}`), ctx(p.providerPaymentId));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("45,00");
    for (const outcome of ["paid", "failed", "cancelled"]) expect(html).toContain(`data-testid="fake-pay-${outcome}"`);
    const terminal = await GET(new Request(`http://localhost:3000/api/dev/fake-pay/${p.providerPaymentId}?kind=terminal`), ctx(p.providerPaymentId));
    expect(await terminal.text()).toContain("Fake terminal payment");
  });

  it("answers 404 in production and for unknown ids", async () => {
    const p = await fakePayment();
    expect((await GET(new Request("http://localhost:3000/api/dev/fake-pay/tr_nope"), ctx("tr_nope"))).status).toBe(404);
    process.env.APP_ENV = "production";
    expect((await GET(new Request(`http://localhost:3000/api/dev/fake-pay/${p.providerPaymentId}`), ctx(p.providerPaymentId))).status).toBe(404);
    const post = new Request(`http://localhost:3000/api/dev/fake-pay/${p.providerPaymentId}`, { method: "POST", body: "outcome=paid" });
    expect((await POST(post, ctx(p.providerPaymentId))).status).toBe(404);
    expect(fake.payment(p.providerPaymentId)!.status).toBe("open");
  });
});

describe("POST /api/dev/fake-pay/[id]", () => {
  it("settles the payment, posts the webhook and redirects to the return page", async () => {
    const p = await fakePayment();
    const res = await POST(
      new Request(`http://localhost:3000/api/dev/fake-pay/${p.providerPaymentId}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "outcome=paid",
      }),
      ctx(p.providerPaymentId),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("http://localhost:3000/nl/account/checkout/return/abc");
    expect(fake.payment(p.providerPaymentId)!.status).toBe("paid");
    const events = (await h.db.select().from(webhookEvents)).filter((e) => (e.payload as { id?: string }).id === p.providerPaymentId);
    expect(events).toHaveLength(1);
    expect(events[0]!.provider).toBe("mollie");
  });

  it("refuses an unknown outcome", async () => {
    const p = await fakePayment();
    const res = await POST(new Request(`http://localhost:3000/api/dev/fake-pay/${p.providerPaymentId}`, { method: "POST", body: "outcome=refunded" }), ctx(p.providerPaymentId));
    expect(res.status).toBe(400);
    expect(fake.payment(p.providerPaymentId)!.status).toBe("open");
  });
});
