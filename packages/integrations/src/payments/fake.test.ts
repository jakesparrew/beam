import { describe, expect, it } from "vitest";
import type { IntegrationCallEntry } from "../_shared/types";
import { createPaymentsFake, type FakePaymentProvider } from "./fake";
import { createStubProvider, type PaymentProvider } from "./provider";

const checkout = (key: string) => ({
  amountCents: 4500,
  description: "BEAM-7K3QX2",
  redirectUrl: "http://localhost:3000/nl-BE/account/checkout/return",
  webhookUrl: "http://localhost:3000/api/webhooks/mollie",
  locale: "nl-BE" as const,
  sequenceType: "oneoff" as const,
  metadata: { orderId: "o1", paymentId: "p1" },
  idempotencyKey: key,
});

describe("payments fake (commerce-P2)", () => {
  it("is a PaymentProvider named fake", () => {
    const fake: PaymentProvider = createPaymentsFake({ isolated: true });
    expect(fake.name).toBe("fake");
  });

  it("settle drives every outcome; paid sets paidAt and a method", async () => {
    const fake: FakePaymentProvider = createPaymentsFake({ isolated: true });
    const at = new Date("2026-11-04T10:00:00Z");
    for (const outcome of ["paid", "failed", "expired", "cancelled"] as const) {
      const { providerPaymentId } = await fake.createPayment(checkout(`payment_create:${outcome}`));
      fake.settle(providerPaymentId, outcome, at);
      const p = await fake.getPayment(providerPaymentId);
      expect(p.status).toBe(outcome);
      expect(p.paidAt).toEqual(outcome === "paid" ? at : null);
      if (outcome === "paid") expect(p.method).toBe("bancontact");
    }
    expect(() => fake.settle("tr_missing", "paid")).toThrow();
  });

  it("chargeback accumulates cents on the payment", async () => {
    const fake = createPaymentsFake({ isolated: true });
    const { providerPaymentId } = await fake.createPayment(checkout("payment_create:cb"));
    fake.settle(providerPaymentId, "paid");
    fake.chargeback(providerPaymentId, 1000);
    fake.chargeback(providerPaymentId, 500);
    expect((await fake.getPayment(providerPaymentId)).chargebackCents).toBe(1500);
  });

  it("failNext fails one call of one operation with the given status, then recovers", async () => {
    const fake = createPaymentsFake({ isolated: true });
    fake.failNext("payments.create", { status: 422 });
    await expect(fake.createPayment(checkout("payment_create:f1"))).rejects.toMatchObject({ retryable: false, statusCode: 422 });
    await expect(fake.createPayment(checkout("payment_create:f1"))).resolves.toMatchObject({ status: "open" });
    fake.failNext("refunds.create", { status: 503 });
    await expect(fake.refund({ providerPaymentId: "tr_x", amountCents: 1, description: "x" })).rejects.toMatchObject({ retryable: true, statusCode: 503 });
    fake.failNext(undefined, { status: 500 });
    await expect(fake.createCustomer({ name: "x", email: "x@example.com", locale: "en" })).rejects.toMatchObject({ retryable: true });
  });

  it("refunds, customers, mandates, terminal payments and links honour their idempotency keys", async () => {
    const fake = createPaymentsFake({ isolated: true });
    const { providerPaymentId } = await fake.createPayment(checkout("payment_create:k"));
    fake.settle(providerPaymentId, "paid");
    const r1 = await fake.refund({ providerPaymentId, amountCents: 1000, description: "r", idempotencyKey: "refund_line:r1" });
    const r2 = await fake.refund({ providerPaymentId, amountCents: 1000, description: "r", idempotencyKey: "refund_line:r1" });
    expect(r2).toEqual(r1);
    expect((await fake.getPayment(providerPaymentId)).refunds).toHaveLength(1);

    const c1 = await fake.createCustomer({ name: "Test Person", email: "member@example.com", locale: "en", idempotencyKey: "customer:pe1" });
    expect(await fake.createCustomer({ name: "Test Person", email: "member@example.com", locale: "en", idempotencyKey: "customer:pe1" })).toEqual(c1);
    expect(await fake.createCustomer({ name: "Test Person", email: "member@example.com", locale: "en" })).not.toEqual(c1);

    const mandate = { customerId: c1.customerId, method: "directdebit" as const, consumerName: "Test Person", iban: "BE68539007547034", idempotencyKey: "mandate:pe1" };
    expect(await fake.createMandate(mandate)).toEqual(await fake.createMandate(mandate));

    const terminal = { terminalId: "term_xxx", amountCents: 4500, description: "BEAM-POS001", webhookUrl: "http://x", metadata: { orderId: "o3", paymentId: "p3" }, idempotencyKey: "payment_terminal:p3" };
    const t1 = await fake.createTerminalPayment(terminal);
    expect(await fake.createTerminalPayment(terminal)).toEqual(t1);
    expect(fake.payment(t1.providerPaymentId)?.kind).toBe("terminal");
    fake.settle(t1.providerPaymentId, "paid");
    expect((await fake.getPayment(t1.providerPaymentId)).method).toBe("pointofsale");

    const link = { amountCents: 2500, description: "Gift", expiresAt: new Date("2026-11-18T23:00:00Z"), redirectUrl: "http://x", webhookUrl: "http://x", idempotencyKey: "pay_link:o4:1" };
    expect(await fake.createPaymentLink(link)).toEqual(await fake.createPaymentLink(link));
  });

  it("cancelPayment cancels an open payment and refuses a settled one", async () => {
    const fake = createPaymentsFake({ isolated: true });
    const a = await fake.createPayment(checkout("payment_create:c1"));
    expect(await fake.cancelPayment(a.providerPaymentId)).toEqual({ cancelled: true });
    expect((await fake.getPayment(a.providerPaymentId)).status).toBe("cancelled");
    const b = await fake.createPayment(checkout("payment_create:c2"));
    fake.settle(b.providerPaymentId, "paid");
    expect(await fake.cancelPayment(b.providerPaymentId)).toEqual({ cancelled: false });
  });

  it("latency injection delays every call until turned off", async () => {
    const fake = createPaymentsFake({ isolated: true, latencyMs: 30 });
    let t = Date.now();
    await fake.createPayment(checkout("payment_create:l1"));
    expect(Date.now() - t).toBeGreaterThanOrEqual(25);
    fake.setLatency(0);
    t = Date.now();
    await fake.createPayment(checkout("payment_create:l2"));
    expect(Date.now() - t).toBeLessThan(25);
  });

  it("reports calls through onCall without bodies and records them on calls", async () => {
    const log: IntegrationCallEntry[] = [];
    const fake = createPaymentsFake({ isolated: true, onCall: (e) => void log.push(e) });
    await fake.createPayment(checkout("payment_create:o1"));
    fake.failNext("payments.get", { status: 404 });
    await fake.getPayment("tr_x").catch(() => undefined);
    expect(log.map((e) => [e.operation, e.ok, e.statusCode])).toEqual([
      ["payments.create", true, 200],
      ["payments.get", false, 404],
    ]);
    expect(JSON.stringify(log)).not.toContain("BEAM-7K3QX2");
    expect(fake.calls.map((c) => c.operation)).toEqual(["payments.create", "payments.get"]);
  });

  it("reset clears payments, keys, failures and latency", async () => {
    const fake = createPaymentsFake({ isolated: true });
    const a = await fake.createPayment(checkout("payment_create:r"));
    fake.failNext("payments.create");
    fake.setLatency(1000);
    fake.reset();
    expect(fake.payment(a.providerPaymentId)).toBeUndefined();
    expect(fake.calls).toHaveLength(0);
    const b = await fake.createPayment(checkout("payment_create:r"));
    expect(b.providerPaymentId).not.toBe(a.providerPaymentId);
  });
});

describe("stub provider", () => {
  it("rejects every call with a permanent not_configured IntegrationError and verifies no webhook", async () => {
    for (const name of ["stripe", "viva"] as const) {
      const stub = createStubProvider(name);
      expect(stub.name).toBe(name);
      await expect(stub.createPayment(checkout("payment_create:s"))).rejects.toMatchObject({ provider: name, retryable: false, message: "not_configured", code: "not_configured" });
      await expect(stub.getPayment("x")).rejects.toMatchObject({ retryable: false, message: "not_configured" });
      await expect(stub.refund({ providerPaymentId: "x", amountCents: 1, description: "x" })).rejects.toMatchObject({ message: "not_configured" });
      await expect(stub.createRecurringPayment({ customerId: "c", mandateId: "m", amountCents: 1, description: "x", webhookUrl: "x", metadata: {}, idempotencyKey: "k" })).rejects.toMatchObject({ message: "not_configured" });
      await expect(stub.cancelPayment("x")).rejects.toMatchObject({ message: "not_configured" });
      expect(stub.verifyWebhook({ headers: new Headers(), rawBody: "id=tr_x", url: new URL("http://x") })).toBe(false);
    }
  });
});
