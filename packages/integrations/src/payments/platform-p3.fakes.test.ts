import { describe, expect, it } from "vitest";
import { fakeAdRows, createAdsFake } from "../ads";
import { createBillitFake } from "../billit";
import { createResendClient, createResendFake } from "../resend";
import { createSlackClient, createSlackFake } from "../slack";
import { createYouTubeFake } from "../youtube";
import { createPaymentsFake } from "./fake";

const payment = (key: string) => ({
  amountCents: 4500,
  description: "5-session package",
  redirectUrl: "http://localhost:3000/nl/account/checkout/return",
  webhookUrl: "http://localhost:3000/api/webhooks/mollie",
  locale: "nl-BE" as const,
  sequenceType: "oneoff" as const,
  metadata: { orderId: "o1", paymentId: "p1" },
  idempotencyKey: key,
});

describe("payments fake", () => {
  it("creates a payment with the dev pay page URL, idempotent per key, settles and refunds", async () => {
    const fake = createPaymentsFake({ appUrl: "http://localhost:3000", isolated: true });
    const a = await fake.createPayment(payment("payments.create:p1"));
    const b = await fake.createPayment(payment("payments.create:p1"));
    expect(a).toEqual(b);
    expect(a.checkoutUrl).toBe(`http://localhost:3000/api/dev/fake-pay/${a.providerPaymentId}`);
    expect(a.status).toBe("open");
    expect(fake.verifyWebhook({ headers: new Headers(), rawBody: `id=${a.providerPaymentId}`, url: new URL("http://x") })).toBe(true);
    expect(fake.verifyWebhook({ headers: new Headers(), rawBody: "id=tr_unknown", url: new URL("http://x") })).toBe(false);

    fake.settle(a.providerPaymentId, "paid");
    expect((await fake.getPayment(a.providerPaymentId)).status).toBe("paid");
    await fake.refund({ providerPaymentId: a.providerPaymentId, amountCents: 1500, description: "partial" });
    expect((await fake.getPayment(a.providerPaymentId)).status).toBe("partially_refunded");
    await expect(fake.refund({ providerPaymentId: a.providerPaymentId, amountCents: 9999, description: "too much" })).rejects.toMatchObject({ retryable: false, statusCode: 422 });
  });

  it("mandates are valid at once; recurring payments settle paid unless failNext was called", async () => {
    const fake = createPaymentsFake({ isolated: true });
    const { customerId } = await fake.createCustomer({ name: "Test Person", email: "member@example.com", locale: "en" });
    const { mandateId, status } = await fake.createMandate({ customerId, method: "directdebit", consumerName: "Test Person", iban: "BE68539007547034" });
    expect(status).toBe("valid");
    const base = { customerId, mandateId, amountCents: 5900, description: "Membership", webhookUrl: "http://x", metadata: {} };
    expect((await fake.createRecurringPayment({ ...base, idempotencyKey: "renewal:m1:2026-11-30" })).status).toBe("paid");
    fake.failNext();
    expect((await fake.createRecurringPayment({ ...base, idempotencyKey: "renewal:m1:2026-12-31" })).status).toBe("failed");
    fake.failNext("payments.get", { status: 503 });
    await expect(fake.getPayment("tr_x")).rejects.toMatchObject({ retryable: true, statusCode: 503 });
    await fake.revokeMandate({ customerId, mandateId });
    expect((await fake.getMandate({ customerId, mandateId })).status).toBe("invalid");
  });

  it("shares one store per process unless isolated", async () => {
    const a = createPaymentsFake();
    const b = createPaymentsFake();
    const created = await a.createPayment(payment(`shared:${Date.now()}`));
    expect(b.payment(created.providerPaymentId)?.amountCents).toBe(4500);
  });
});

describe("billit fake", () => {
  it("accepts parties and invoices, finds by reference, marks paid and sends Peppol", async () => {
    const fake = createBillitFake();
    const { partyId } = await fake.upsertParty({ Name: "Example BV", PartyType: "Customer", VATNumber: "BE0123456789", Email: "billing@example.com" });
    expect(partyId).toMatch(/^billit_\d+$/);
    const input = {
      OrderType: "Invoice" as const,
      OrderDirection: "Income" as const,
      OrderNumber: "BEAM-2026-000001",
      Reference: "BEAM-2026-000001",
      OrderDate: "2026-11-03",
      Customer: { PartyID: partyId },
      OrderLines: [{ Description: "10-session card", Quantity: 1, UnitPriceExcl: 100, VATPercentage: 21 }],
    };
    const { orderId } = await fake.createOrder(input);
    expect(await fake.findOrderByReference("BEAM-2026-000001")).toEqual({ orderId });
    expect((await fake.getOrder(orderId)).TotalIncl).toBe(121);
    fake.markPaid("BEAM-2026-000001", "2026-11-10", 5000);
    expect((await fake.getOrder(orderId)).Paid).toBe(false);
    fake.markPaid("BEAM-2026-000001", "2026-11-12");
    expect(await fake.getOrder(orderId)).toMatchObject({ Paid: true, PaidDate: "2026-11-12" });
    await fake.sendOrder(orderId, "Peppol");
    expect((await fake.getOrder(orderId)).PeppolStatus).toBe("sent");
    await fake.anonymiseCustomer(partyId);
    expect(fake.snapshot().parties[0]).toMatchObject({ Email: null, Name: "Example BV", anonymised: true });
  });

  it("a lost response creates once; a retry finds it by reference", async () => {
    const fake = createBillitFake();
    fake.loseResponseNext("createOrder");
    const input = {
      OrderType: "Invoice" as const,
      OrderDirection: "Income" as const,
      OrderNumber: "BEAM-2026-000002",
      Reference: "BEAM-2026-000002",
      OrderDate: "2026-11-03",
      Customer: { PartyID: "billit_1" },
      OrderLines: [],
    };
    await expect(fake.createOrder(input)).rejects.toMatchObject({ retryable: true, code: "timeout" });
    expect(await fake.findOrderByReference("BEAM-2026-000002")).not.toBeNull();
    await expect(fake.createOrder(input)).rejects.toMatchObject({ statusCode: 422 });
    expect(fake.snapshot().orders).toHaveLength(1);
  });
});

describe("resend", () => {
  const mail = { from: "BEAM <noreply@mail.beam.be>", to: "customer1@example.com", subject: "Hi", html: "<p>Hi</p>", text: "Hi", headers: {}, idempotencyKey: "email:m1" };

  it("fake returns fake_<uuid>, the same id for the same key, and records messages", async () => {
    const fake = createResendFake();
    const a = await fake.sendEmail(mail);
    const b = await fake.sendEmail(mail);
    expect(a.id).toMatch(/^fake_[0-9a-f-]{36}$/);
    expect(b).toEqual(a);
    expect(fake.sentTo("CUSTOMER1@example.com")).toHaveLength(1);
  });

  it("client posts with the Idempotency-Key header and base64 attachments", async () => {
    let seen: { headers: Headers; body: Record<string, unknown> } | undefined;
    const client = createResendClient({
      apiKey: "re_fake_key_123",
      fetch: (_url, init) => {
        seen = { headers: new Headers(init?.headers), body: JSON.parse(init?.body as string) as Record<string, unknown> };
        return Promise.resolve(Response.json({ id: "re_1" }));
      },
    });
    const res = await client.sendEmail({ ...mail, attachments: [{ filename: "a.txt", content: new TextEncoder().encode("hi"), contentType: "text/plain" }] });
    expect(res).toEqual({ id: "re_1" });
    expect(seen?.headers.get("idempotency-key")).toBe("email:m1");
    expect(seen?.body).toMatchObject({ to: ["customer1@example.com"], attachments: [{ filename: "a.txt", content: "aGk=", content_type: "text/plain" }] });
    const failing = createResendClient({ apiKey: "x", fetch: () => Promise.resolve(new Response("slow down", { status: 429 })) });
    await expect(failing.sendEmail(mail)).rejects.toMatchObject({ provider: "resend", retryable: true, statusCode: 429 });
  });
});

describe("slack", () => {
  it("fake records messages; client maps a 500 to retryable", async () => {
    const fake = createSlackFake();
    await fake.postMessage({ text: "one" });
    await fake.postMessage({ text: "two" });
    expect(fake.last(1).map((m) => m.text)).toEqual(["two"]);
    const client = createSlackClient({ webhookUrl: "https://hooks.slack.com/services/fake", fetch: () => Promise.resolve(new Response("x", { status: 500 })) });
    await expect(client.postMessage({ text: "x" })).rejects.toMatchObject({ provider: "slack", retryable: true });
  });
});

describe("youtube fake", () => {
  it("runs the lifecycle and yields a recording on complete", async () => {
    const fake = createYouTubeFake();
    const { broadcastId } = await fake.createBroadcast({ title: "Webinar", description: "beam-webinar:w1", scheduledStartAt: new Date("2027-01-10T18:00:00Z") });
    expect(broadcastId).toMatch(/^fake_/);
    expect(await fake.findBroadcastByMarker("beam-webinar:w1")).toMatchObject({ broadcastId });
    fake.setLifecycle(broadcastId, "ready");
    fake.setLifecycle(broadcastId, "live", new Date("2027-01-10T18:00:00Z"));
    const done = fake.setLifecycle(broadcastId, "complete", new Date("2027-01-10T19:00:00Z"));
    expect(done.recordingVideoId).toBe(broadcastId);
    expect(await fake.getVideo(broadcastId)).toMatchObject({ processed: false });
    fake.markProcessed(broadcastId, 3600);
    expect(await fake.getVideo(broadcastId)).toMatchObject({ processed: true, durationSec: 3600 });
    expect(() => fake.setLifecycle(broadcastId, "live")).toThrow();
    fake.failNext("createBroadcast", { status: 403 });
    await expect(fake.createBroadcast({ title: "x", description: "", scheduledStartAt: new Date() })).rejects.toMatchObject({ retryable: false });
  });
});

describe("ads fake", () => {
  it("returns three deterministic campaigns per platform and day", async () => {
    const fake = createAdsFake();
    const a = await fake.meta.getCampaignInsights({ accountId: "act_1", day: "2026-11-02" });
    const b = await fake.meta.getCampaignInsights({ accountId: "act_1", day: "2026-11-02" });
    expect(a).toHaveLength(3);
    expect(a).toEqual(b);
    expect(fakeAdRows("meta", "act_1", "2026-11-03")).not.toEqual(a);
    expect(await fake.google.getCampaignStats({ customerId: "123", day: "2026-11-02" })).toHaveLength(3);
    fake.failNext("google", { retryable: false });
    await expect(fake.google.getCampaignStats({ customerId: "123", day: "2026-11-02" })).rejects.toMatchObject({ retryable: false, statusCode: 401 });
  });
});
