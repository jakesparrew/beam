/**
 * The Stripe adapter against recorded-shape Stripe JSON (no network): what it sends, how it reads
 * sessions, PaymentIntents, refunds, disputes and payment methods, and the webhook signature.
 */
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createStripeProvider, mapPaymentIntentStatus, stripeEventRef, stripeForm, stripeMandateSummary } from "./stripe";

type Call = { method: string; url: string; body: URLSearchParams; headers: Headers };

/** A fetch that answers by "METHOD path" and records every request. */
function fakeStripe(routes: Record<string, { status?: number; body: unknown } | ((c: Call) => { status?: number; body: unknown })>) {
  const calls: Call[] = [];
  const fetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const call: Call = { method: init?.method ?? "GET", url: url.toString(), body: new URLSearchParams(typeof init?.body === "string" ? init.body : ""), headers: new Headers(init?.headers) };
    calls.push(call);
    const route = routes[`${call.method} ${url.pathname}`];
    if (!route) return Promise.resolve(new Response(JSON.stringify({ error: { message: `no route ${call.method} ${url.pathname}` } }), { status: 404 }));
    const r = typeof route === "function" ? route(call) : route;
    return Promise.resolve(new Response(JSON.stringify(r.body), { status: r.status ?? 200 }));
  };
  return { calls, fetch };
}

const NOW = new Date("2026-11-22T10:00:00Z");
const provider = (fetch: ReturnType<typeof fakeStripe>["fetch"], extra: { webhookSecret?: string } = {}) =>
  createStripeProvider({ apiKey: "sk_test_abc", appBaseUrl: "https://beam.example", fetch, now: () => NOW, ...extra });

const charge = (over: Record<string, unknown> = {}) => ({
  id: "ch_1",
  amount: 12000,
  amount_refunded: 0,
  created: 1795341600,
  disputed: false,
  payment_method_details: { type: "bancontact", bancontact: { generated_sepa_debit: "pm_sepa1" } },
  ...over,
});
const paymentIntent = (over: Record<string, unknown> = {}) => ({
  id: "pi_1",
  object: "payment_intent",
  amount: 12000,
  status: "succeeded",
  customer: "cus_1",
  payment_method: "pm_bc1",
  setup_future_usage: null,
  latest_charge: charge(),
  last_payment_error: null,
  metadata: { orderId: "o1", paymentId: "p1" },
  ...over,
});

describe("stripeForm", () => {
  it("encodes nested params the Stripe way and leaves out empty values", () => {
    const s = stripeForm({ a: 1, b: { c: ["x", "y"], d: undefined }, e: null, f: { g: { h: true } } });
    expect(decodeURIComponent(s)).toBe("a=1&b[c][0]=x&b[c][1]=y&f[g][h]=true");
  });
});

describe("createPayment", () => {
  it("creates a Checkout Session with the BEAM metadata, the pinned API version and the idempotency key", async () => {
    const s = fakeStripe({ "POST /v1/checkout/sessions": { body: { id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1", status: "open", payment_status: "unpaid", amount_total: 12000 } } });
    const r = await provider(s.fetch).createPayment({
      amountCents: 12000,
      description: "BO-ABC",
      redirectUrl: "/nl/account/checkout/return/o1",
      webhookUrl: "https://beam.example/api/webhooks/mollie",
      locale: "nl-BE",
      sequenceType: "oneoff",
      metadata: { orderId: "o1", paymentId: "p1" },
      idempotencyKey: "payment_create:p1",
    });
    expect(r).toEqual({ providerPaymentId: "cs_test_1", checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_1", status: "open" });
    const c = s.calls[0]!;
    expect(c.headers.get("authorization")).toBe("Bearer sk_test_abc");
    expect(c.headers.get("idempotency-key")).toBe("payment_create:p1");
    expect(c.body.get("mode")).toBe("payment");
    expect(c.body.get("line_items[0][price_data][unit_amount]")).toBe("12000");
    expect(c.body.get("line_items[0][price_data][currency]")).toBe("eur");
    expect(c.headers.get("stripe-version")).toBe("2026-11-18.endive");
    // Payment methods come from the dashboard: the request must not list them (API 2026-11-18).
    expect([...c.body.keys()].some((k) => k.startsWith("payment_method_types"))).toBe(false);
    expect(c.body.get("success_url")).toBe("https://beam.example/nl/account/checkout/return/o1");
    expect(c.body.get("locale")).toBe("nl");
    expect(c.body.get("metadata[paymentId]")).toBe("p1");
    expect(c.body.get("payment_intent_data[metadata][orderId]")).toBe("o1");
    expect(c.body.get("payment_intent_data[setup_future_usage]")).toBeNull();
  });

  it("a first payment saves the method for later debits and is tied to the customer", async () => {
    const s = fakeStripe({ "POST /v1/checkout/sessions": { body: { id: "cs_test_2", url: "https://checkout.stripe.com/x", status: "open", payment_status: "unpaid", amount_total: 39600 } } });
    await provider(s.fetch).createPayment({
      amountCents: 39600,
      description: "BO-MEM",
      redirectUrl: "https://beam.example/r",
      webhookUrl: "",
      locale: "fr-BE",
      customerId: "cus_1",
      sequenceType: "first",
      metadata: { orderId: "o2", paymentId: "p2" },
      idempotencyKey: "k",
    });
    const b = s.calls[0]!.body;
    expect(b.get("payment_intent_data[setup_future_usage]")).toBe("off_session");
    expect(b.get("customer")).toBe("cus_1");
    expect(b.get("locale")).toBe("fr");
  });
});

describe("getPayment", () => {
  it("an open session is open; an expired one is expired", async () => {
    const s = fakeStripe({
      "GET /v1/checkout/sessions/cs_open": { body: { id: "cs_open", status: "open", payment_status: "unpaid", amount_total: 12000, payment_intent: null, metadata: { paymentId: "p1" } } },
      "GET /v1/checkout/sessions/cs_gone": { body: { id: "cs_gone", status: "expired", payment_status: "unpaid", amount_total: 12000, payment_intent: null } },
    });
    const p = provider(s.fetch);
    expect(await p.getPayment("cs_open")).toMatchObject({ status: "open", amountCents: 12000, details: { beamPaymentId: "p1" } });
    expect((await p.getPayment("cs_gone")).status).toBe("expired");
  });

  it("a paid first payment by Bancontact gives the generated SEPA payment method as the mandate", async () => {
    const s = fakeStripe({
      "GET /v1/checkout/sessions/cs_paid": {
        body: { id: "cs_paid", status: "complete", payment_status: "paid", amount_total: 39600, customer: "cus_1", payment_intent: paymentIntent({ amount: 39600, setup_future_usage: "off_session", latest_charge: charge({ amount: 39600 }) }) },
      },
    });
    const r = await provider(s.fetch).getPayment("cs_paid");
    expect(r).toMatchObject({ providerPaymentId: "cs_paid", status: "paid", method: "bancontact", amountCents: 39600, mandateId: "pm_sepa1", customerId: "cus_1", chargebackCents: 0 });
    expect(r.paidAt?.toISOString()).toBe(new Date(1795341600 * 1000).toISOString());
    expect(r.details).toEqual({ paymentIntentId: "pi_1", checkoutSessionId: "cs_paid", beamPaymentId: "p1" });
  });

  it("a one-off card payment keeps no mandate and keeps card data out of the details", async () => {
    const s = fakeStripe({
      "GET /v1/payment_intents/pi_card": { body: paymentIntent({ id: "pi_card", latest_charge: charge({ payment_method_details: { type: "card", card: { brand: "visa", country: "BE", last4: "4242", fingerprint: "secret" } } }) }) },
    });
    const r = await provider(s.fetch).getPayment("pi_card");
    expect(r).toMatchObject({ status: "paid", method: "creditcard", mandateId: null });
    expect(r.details).toEqual({ paymentIntentId: "pi_card", beamPaymentId: "p1", cardLabel: "visa", cardCountryCode: "BE" });
  });

  it("reads refunds and open disputes", async () => {
    const s = fakeStripe({
      "GET /v1/payment_intents/pi_r": { body: paymentIntent({ id: "pi_r", latest_charge: charge({ amount_refunded: 2000, disputed: true }) }) },
      "GET /v1/refunds": { body: { data: [{ id: "re_1", amount: 2000, status: "succeeded" }] } },
      "GET /v1/disputes": { body: { data: [{ id: "dp_1", amount: 10000, status: "needs_response" }, { id: "dp_2", amount: 500, status: "won" }] } },
    });
    const r = await provider(s.fetch).getPayment("pi_r");
    expect(r.status).toBe("partially_refunded");
    expect(r.refunds).toEqual([{ providerRefundId: "re_1", amountCents: 2000, status: "refunded" }]);
    expect(r.chargebackCents).toBe(10000);
    expect(s.calls.map((c) => new URL(c.url).search)).toContain("?payment_intent=pi_r&limit=100");
  });
});

describe("mapPaymentIntentStatus", () => {
  it("maps Stripe's statuses onto BEAM's", () => {
    expect(mapPaymentIntentStatus({ status: "succeeded", last_payment_error: null })).toBe("paid");
    expect(mapPaymentIntentStatus({ status: "processing", last_payment_error: null })).toBe("pending");
    expect(mapPaymentIntentStatus({ status: "requires_capture", last_payment_error: null })).toBe("authorized");
    expect(mapPaymentIntentStatus({ status: "canceled", last_payment_error: null })).toBe("cancelled");
    expect(mapPaymentIntentStatus({ status: "requires_payment_method", last_payment_error: null })).toBe("open");
    expect(mapPaymentIntentStatus({ status: "requires_payment_method", last_payment_error: { code: "card_declined" } })).toBe("failed");
  });
});

describe("refunds, customers and mandates", () => {
  it("refunds a checkout payment through its PaymentIntent", async () => {
    const s = fakeStripe({
      "GET /v1/checkout/sessions/cs_paid": { body: { id: "cs_paid", status: "complete", payment_status: "paid", amount_total: 12000, payment_intent: "pi_1" } },
      "POST /v1/refunds": { body: { id: "re_9", amount: 5000, status: "pending" } },
    });
    const r = await provider(s.fetch).refund({ providerPaymentId: "cs_paid", amountCents: 5000, description: "Annulering", idempotencyKey: "refund:x" });
    expect(r).toEqual({ providerRefundId: "re_9", status: "pending" });
    const post = s.calls.find((c) => c.method === "POST")!;
    expect(post.body.get("payment_intent")).toBe("pi_1");
    expect(post.body.get("amount")).toBe("5000");
    expect(post.headers.get("idempotency-key")).toBe("refund:x");
  });

  it("creates a customer and an IBAN mandate with the customer's email", async () => {
    const s = fakeStripe({
      "POST /v1/customers": { body: { id: "cus_9", email: "lotte@example.com" } },
      "GET /v1/customers/cus_9": { body: { id: "cus_9", email: "lotte@example.com" } },
      "POST /v1/setup_intents": { body: { id: "seti_1", status: "processing", payment_method: "pm_sepa9" } },
    });
    const p = provider(s.fetch);
    expect(await p.createCustomer({ name: "Lotte Peeters", email: "lotte@example.com", locale: "nl-BE" })).toEqual({ customerId: "cus_9" });
    expect(await p.createMandate({ customerId: "cus_9", method: "directdebit", consumerName: "Lotte Peeters", iban: "BE68 5390 0754 7034" })).toEqual({ mandateId: "pm_sepa9", status: "pending" });
    const b = s.calls.find((c) => c.url.endsWith("/setup_intents"))!.body;
    expect(b.get("payment_method_data[sepa_debit][iban]")).toBe("BE68539007547034");
    expect(b.get("payment_method_data[billing_details][email]")).toBe("lotte@example.com");
    expect(b.get("mandate_data[customer_acceptance][type]")).toBe("offline");
    expect(b.get("automatic_payment_methods[allow_redirects]")).toBe("never");
  });

  it("a mandate is valid while the payment method stays attached to the customer", async () => {
    const s = fakeStripe({
      "GET /v1/payment_methods/pm_ok": { body: { id: "pm_ok", type: "sepa_debit", customer: "cus_1", sepa_debit: { country: "BE", last4: "7034" } } },
      "GET /v1/payment_methods/pm_other": { body: { id: "pm_other", type: "card", customer: null, card: { brand: "visa", last4: "4242" } } },
    });
    const p = provider(s.fetch);
    expect(await p.getMandate({ customerId: "cus_1", mandateId: "pm_ok" })).toEqual({ status: "valid", method: "directdebit", summary: "BE** **** **** 7034" });
    expect((await p.getMandate({ customerId: "cus_1", mandateId: "pm_other" })).status).toBe("invalid");
    expect((await p.getMandate({ customerId: "cus_1", mandateId: "pm_missing" })).status).toBe("invalid");
    expect(stripeMandateSummary({ type: "card", card: { brand: "visa", last4: "4242" }, sepa_debit: null })).toBe("visa **** 4242");
  });
});

describe("createRecurringPayment", () => {
  it("charges the saved method off-session; SEPA starts pending", async () => {
    const s = fakeStripe({ "POST /v1/payment_intents": { body: paymentIntent({ id: "pi_rec", status: "processing", latest_charge: null }) } });
    const r = await provider(s.fetch).createRecurringPayment({ customerId: "cus_1", mandateId: "pm_sepa1", amountCents: 39600, description: "Membership", webhookUrl: "", metadata: { paymentId: "p3" }, idempotencyKey: "rec:p3" });
    expect(r).toEqual({ providerPaymentId: "pi_rec", status: "pending" });
    const b = s.calls[0]!.body;
    expect([b.get("off_session"), b.get("confirm"), b.get("payment_method"), b.get("customer")]).toEqual(["true", "true", "pm_sepa1", "cus_1"]);
    expect([...b.keys()].some((k) => k.startsWith("payment_method_types"))).toBe(false);
  });

  it("a declined card answers 402 with the PaymentIntent: the debit failed", async () => {
    const s = fakeStripe({
      "POST /v1/payment_intents": { status: 402, body: { error: { type: "card_error", code: "card_declined", message: "Your card was declined.", payment_intent: paymentIntent({ id: "pi_dec", status: "requires_payment_method", last_payment_error: { code: "card_declined" } }) } } },
    });
    const r = await provider(s.fetch).createRecurringPayment({ customerId: "cus_1", mandateId: "pm_card", amountCents: 100, description: "x", webhookUrl: "", metadata: {}, idempotencyKey: "k" });
    expect(r).toEqual({ providerPaymentId: "pi_dec", status: "failed" });
  });
});

describe("cancelPayment", () => {
  it("expires an open session; a paid one is not cancelable", async () => {
    const s = fakeStripe({
      "POST /v1/checkout/sessions/cs_open/expire": { body: { id: "cs_open", status: "expired", payment_status: "unpaid", amount_total: 1 } },
      "POST /v1/checkout/sessions/cs_paid/expire": { status: 400, body: { error: { message: "Only Checkout Sessions with a status in [\"open\"] can be expired." } } },
    });
    const p = provider(s.fetch);
    expect(await p.cancelPayment("cs_open")).toEqual({ cancelled: true });
    expect(await p.cancelPayment("cs_paid")).toEqual({ cancelled: false });
  });
});

describe("webhooks", () => {
  const body = JSON.stringify({ id: "evt_1", type: "checkout.session.completed", data: { object: { id: "cs_paid", object: "checkout.session", payment_intent: "pi_1", metadata: { paymentId: "p1" } } } });
  const sign = (t: number, secret = "whsec_test") => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
  const ts = Math.floor(NOW.getTime() / 1000);
  const verify = (header: string | null, secret: string | null = "whsec_test") =>
    provider(fakeStripe({}).fetch, secret ? { webhookSecret: secret } : {}).verifyWebhook({ headers: new Headers(header ? { "stripe-signature": header } : {}), rawBody: body, url: new URL("https://beam.example/api/webhooks/stripe") });

  it("accepts a correct signature within 5 minutes", () => {
    expect(verify(sign(ts))).toBe(true);
    expect(verify(`${sign(ts)},v0=ignored`)).toBe(true);
  });

  it("refuses a wrong secret, an old timestamp, a missing header and a missing secret", () => {
    expect(verify(sign(ts, "whsec_other"))).toBe(false);
    expect(verify(sign(ts - 600))).toBe(false);
    expect(verify(null)).toBe(false);
    expect(verify(sign(ts), null)).toBe(false);
  });

  it("reads the event id and the payment it concerns", () => {
    expect(stripeEventRef(body)).toEqual({ eventId: "evt_1", type: "checkout.session.completed", objectId: "cs_paid", paymentIntentId: "pi_1", beamPaymentId: "p1" });
    expect(stripeEventRef(JSON.stringify({ id: "evt_2", type: "charge.dispute.created", data: { object: { id: "dp_1", payment_intent: "pi_1" } } }))).toEqual({
      eventId: "evt_2",
      type: "charge.dispute.created",
      objectId: "dp_1",
      paymentIntentId: "pi_1",
      beamPaymentId: null,
    });
    expect(stripeEventRef("not json")).toBeNull();
  });
});

describe("terminal", () => {
  it("is not offered through Stripe", async () => {
    await expect(provider(fakeStripe({}).fetch).createTerminalPayment({ terminalId: "t", amountCents: 1, description: "x", webhookUrl: "", metadata: {} })).rejects.toMatchObject({ code: "not_supported", retryable: false });
  });
});
