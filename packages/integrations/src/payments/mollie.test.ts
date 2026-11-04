import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { IntegrationCallEntry } from "../_shared/types";
import { centsToMollieValue, createMollieProvider, mandateSummary, mapMollieStatus, mollieValueToCents } from "./mollie";

type Seen = { url: URL; method: string; headers: Headers; body: Record<string, unknown> | null };
type Reply = { status?: number; json?: unknown; text?: string };

/** An injected `fetch` that answers recorded Mollie JSON per `METHOD /path` and records each request. */
function recorder(routes: Record<string, Reply | ((seen: Seen) => Reply)>) {
  const seen: Seen[] = [];
  const fetch = (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const req: Seen = {
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    };
    seen.push(req);
    const route = routes[`${req.method} ${url.pathname.replace(/^\/v2/, "")}`];
    if (!route) return Promise.resolve(new Response(JSON.stringify({ status: 404, title: "Not Found" }), { status: 404 }));
    const r = typeof route === "function" ? route(req) : route;
    const status = r.status ?? 200;
    if (status === 204) return Promise.resolve(new Response(null, { status }));
    return Promise.resolve(new Response(r.text ?? JSON.stringify(r.json), { status, headers: { "content-type": "application/hal+json" } }));
  };
  return { fetch, seen };
}

function provider(routes: Parameters<typeof recorder>[0], extra: { webhookSecret?: string; webhookBaseUrl?: string } = {}) {
  const log: IntegrationCallEntry[] = [];
  const { fetch, seen } = recorder(routes);
  const p = createMollieProvider({ apiKey: "test_dHar4XY7LxsDOtmnkVtjNVWXLSlXsM", webhookBaseUrl: extra.webhookBaseUrl ?? "https://beam.example.com", onCall: (e) => void log.push(e), fetch, ...extra });
  return { p, seen, log };
}

/** Recorded Mollie payment, trimmed to the fields BEAM reads (Payments API v2). */
function molliePayment(over: Record<string, unknown> = {}) {
  return {
    resource: "payment",
    id: "tr_WDqYK6vllg",
    mode: "test",
    createdAt: "2026-11-04T09:12:41+00:00",
    amount: { value: "45.00", currency: "EUR" },
    description: "BEAM-7K3QX2",
    method: null,
    metadata: { orderId: "o1", paymentId: "p1" },
    status: "open",
    isCancelable: false,
    expiresAt: "2026-11-04T09:27:41+00:00",
    profileId: "pfl_QkEhN94Ba",
    sequenceType: "oneoff",
    redirectUrl: "https://beam.example.com/nl-BE/account/checkout/return",
    webhookUrl: "https://beam.example.com/api/webhooks/mollie?t=x",
    _links: {
      self: { href: "https://api.mollie.com/v2/payments/tr_WDqYK6vllg", type: "application/hal+json" },
      checkout: { href: "https://www.mollie.com/checkout/select-method/WDqYK6vllg", type: "text/html" },
    },
    ...over,
  };
}

const createInput = {
  amountCents: 4500,
  description: "BEAM-7K3QX2",
  redirectUrl: "/nl-BE/account/checkout/return",
  webhookUrl: "/api/webhooks/mollie?t=x",
  locale: "nl-BE" as const,
  sequenceType: "oneoff" as const,
  metadata: { orderId: "o1", paymentId: "p1" },
  idempotencyKey: "payment_create:p1",
};

describe("amounts", () => {
  it("converts cents to Mollie values and back exactly", () => {
    expect([0, 5, 99, 4500, 123456].map(centsToMollieValue)).toEqual(["0.00", "0.05", "0.99", "45.00", "1234.56"]);
    expect(["0.10", "45.00", "1234.56", "-5.00"].map(mollieValueToCents)).toEqual([10, 4500, 123456, -500]);
    expect(() => centsToMollieValue(1.5)).toThrow();
    expect(() => mollieValueToCents("45")).toThrow();
  });
});

describe("mollie adapter", () => {
  it("creates a payment with Idempotency-Key, EUR amount, locale, metadata and absolute URLs", async () => {
    const { p, seen } = provider({ "POST /payments": { status: 201, json: molliePayment() } });
    const res = await p.createPayment({ ...createInput, method: "bancontact" });
    expect(res).toEqual({ providerPaymentId: "tr_WDqYK6vllg", checkoutUrl: "https://www.mollie.com/checkout/select-method/WDqYK6vllg", status: "open" });
    const req = seen[0]!;
    expect(req.url.toString()).toBe("https://api.mollie.com/v2/payments");
    expect(req.headers.get("idempotency-key")).toBe("payment_create:p1");
    expect(req.headers.get("authorization")).toBe("Bearer test_dHar4XY7LxsDOtmnkVtjNVWXLSlXsM");
    expect(req.body).toEqual({
      amount: { currency: "EUR", value: "45.00" },
      description: "BEAM-7K3QX2",
      redirectUrl: "https://beam.example.com/nl-BE/account/checkout/return",
      webhookUrl: "https://beam.example.com/api/webhooks/mollie?t=x",
      locale: "nl_BE",
      method: "bancontact",
      sequenceType: "oneoff",
      metadata: { orderId: "o1", paymentId: "p1" },
    });
  });

  it("first payments carry the customer; a localhost webhook URL is left out (Mollie cannot reach it)", async () => {
    const { p, seen } = provider({ "POST /payments": { status: 201, json: molliePayment({ sequenceType: "first", customerId: "cst_8wmqcHMN4U" }) } }, { webhookBaseUrl: "http://localhost:3000" });
    await p.createPayment({ ...createInput, locale: "fr-BE", customerId: "cst_8wmqcHMN4U", sequenceType: "first" });
    expect(seen[0]!.body).toMatchObject({ customerId: "cst_8wmqcHMN4U", sequenceType: "first", locale: "fr_BE", redirectUrl: "http://localhost:3000/nl-BE/account/checkout/return" });
    expect(seen[0]!.body).not.toHaveProperty("webhookUrl");
  });

  it("maps every Mollie payment status, refunds, chargebacks and scrubs card and IBAN details", async () => {
    const cases: [string, Record<string, unknown>, string][] = [
      ["open", {}, "open"],
      ["pending", {}, "pending"],
      ["authorized", {}, "authorized"],
      ["canceled", {}, "cancelled"],
      ["expired", {}, "expired"],
      ["failed", {}, "failed"],
      ["paid", { paidAt: "2026-11-04T09:14:02+00:00" }, "paid"],
      ["paid", { paidAt: "2026-11-04T09:14:02+00:00", amountRefunded: { value: "15.00", currency: "EUR" } }, "partially_refunded"],
      ["paid", { paidAt: "2026-11-04T09:14:02+00:00", amountRefunded: { value: "45.00", currency: "EUR" } }, "refunded"],
    ];
    for (const [status, extra, expected] of cases) {
      const { p, seen } = provider({ "GET /payments/tr_WDqYK6vllg": { json: molliePayment({ status, ...extra }) } });
      expect((await p.getPayment("tr_WDqYK6vllg")).status, status).toBe(expected);
      expect(seen[0]!.url.searchParams.get("embed")).toBe("refunds,chargebacks");
    }

    const { p } = provider({
      "GET /payments/tr_WDqYK6vllg": {
        json: molliePayment({
          status: "paid",
          method: "creditcard",
          paidAt: "2026-11-04T09:14:02+00:00",
          mandateId: "mdt_pWUnw6pkBN",
          customerId: "cst_8wmqcHMN4U",
          amountRefunded: { value: "10.00", currency: "EUR" },
          details: { cardHolder: "T. Person", cardNumber: "6787", cardFingerprint: "Hd8sdf", cardLabel: "Mastercard", cardCountryCode: "BE", cardSecurity: "normal", feeRegion: "intra-eu", consumerAccount: "BE68539007547034" },
          _embedded: {
            refunds: [
              { resource: "refund", id: "re_4qqhO89gsT", amount: { value: "6.00", currency: "EUR" }, status: "refunded" },
              { resource: "refund", id: "re_5rrhO89gsU", amount: { value: "4.00", currency: "EUR" }, status: "queued" },
              { resource: "refund", id: "re_6sshO89gsV", amount: { value: "1.00", currency: "EUR" }, status: "failed" },
            ],
            chargebacks: [{ resource: "chargeback", id: "chb_n9z0tp", amount: { value: "45.00", currency: "EUR" } }],
          },
        }),
      },
    });
    const got = await p.getPayment("tr_WDqYK6vllg");
    expect(got).toEqual({
      providerPaymentId: "tr_WDqYK6vllg",
      status: "partially_refunded",
      method: "creditcard",
      amountCents: 4500,
      paidAt: new Date("2026-11-04T09:14:02Z"),
      mandateId: "mdt_pWUnw6pkBN",
      customerId: "cst_8wmqcHMN4U",
      refunds: [
        { providerRefundId: "re_4qqhO89gsT", amountCents: 600, status: "refunded" },
        { providerRefundId: "re_5rrhO89gsU", amountCents: 400, status: "pending" },
        { providerRefundId: "re_6sshO89gsV", amountCents: 100, status: "failed" },
      ],
      chargebackCents: 4500,
      details: { cardLabel: "Mastercard", cardCountryCode: "BE", cardSecurity: "normal", feeRegion: "intra-eu" },
    });
    expect(JSON.stringify(got)).not.toMatch(/T\. Person|6787|Hd8sdf|BE68539007547034/);
    expect(mapMollieStatus("paid", 100, 0)).toBe("paid");
  });

  it("creates refunds and maps refund statuses", async () => {
    const { p, seen } = provider({ "POST /payments/tr_WDqYK6vllg/refunds": { status: 201, json: { resource: "refund", id: "re_4qqhO89gsT", amount: { value: "15.00", currency: "EUR" }, status: "pending", paymentId: "tr_WDqYK6vllg" } } });
    expect(await p.refund({ providerPaymentId: "tr_WDqYK6vllg", amountCents: 1500, description: "Refund BEAM-7K3QX2", idempotencyKey: "refund_line:r1" })).toEqual({ providerRefundId: "re_4qqhO89gsT", status: "pending" });
    expect(seen[0]!.body).toEqual({ amount: { currency: "EUR", value: "15.00" }, description: "Refund BEAM-7K3QX2" });
    expect(seen[0]!.headers.get("idempotency-key")).toBe("refund_line:r1");
  });

  it("creates and deletes customers; creates, reads and revokes mandates", async () => {
    const { p, seen } = provider({
      "POST /customers": { status: 201, json: { resource: "customer", id: "cst_8wmqcHMN4U", mode: "test", name: "Test Person", email: "member@example.com", locale: "en_US" } },
      "DELETE /customers/cst_8wmqcHMN4U": { status: 204 },
      "DELETE /customers/cst_gone": { status: 404, json: { status: 404, title: "Not Found", detail: "No customer exists with token cst_gone." } },
      "POST /customers/cst_8wmqcHMN4U/mandates": { status: 201, json: { resource: "mandate", id: "mdt_pWUnw6pkBN", status: "valid", method: "directdebit", details: { consumerName: "Test Person", consumerAccount: "BE68539007547034", consumerBic: "BBRUBEBB" } } },
      "GET /customers/cst_8wmqcHMN4U/mandates/mdt_pWUnw6pkBN": { json: { resource: "mandate", id: "mdt_pWUnw6pkBN", status: "valid", method: "directdebit", details: { consumerName: "Test Person", consumerAccount: "BE68539007547034", consumerBic: "BBRUBEBB" } } },
      "DELETE /customers/cst_8wmqcHMN4U/mandates/mdt_pWUnw6pkBN": { status: 204 },
    });
    expect(await p.createCustomer({ name: "Test Person", email: "member@example.com", locale: "en", idempotencyKey: "customer:pe1" })).toEqual({ customerId: "cst_8wmqcHMN4U" });
    expect(seen[0]!.body).toEqual({ name: "Test Person", email: "member@example.com", locale: "en_US" });
    expect(seen[0]!.headers.get("idempotency-key")).toBe("customer:pe1");
    expect(await p.createMandate({ customerId: "cst_8wmqcHMN4U", method: "directdebit", consumerName: "Test Person", iban: "BE68 5390 0754 7034" })).toEqual({ mandateId: "mdt_pWUnw6pkBN", status: "valid" });
    expect(seen[1]!.body).toEqual({ method: "directdebit", consumerName: "Test Person", consumerAccount: "BE68539007547034" });
    expect(await p.getMandate({ customerId: "cst_8wmqcHMN4U", mandateId: "mdt_pWUnw6pkBN" })).toEqual({ status: "valid", method: "directdebit", summary: "BE** **** **** 7034" });
    expect(await p.getMandate({ customerId: "cst_8wmqcHMN4U", mandateId: "mdt_unknown" })).toEqual({ status: "invalid", method: "directdebit", summary: null });
    await expect(p.revokeMandate({ customerId: "cst_8wmqcHMN4U", mandateId: "mdt_pWUnw6pkBN" })).resolves.toBeUndefined();
    await expect(p.deleteCustomer("cst_8wmqcHMN4U")).resolves.toBeUndefined();
    await expect(p.deleteCustomer("cst_gone")).resolves.toBeUndefined();
    expect(mandateSummary("creditcard", { cardLabel: "Visa", cardNumber: "4242" })).toBe("Visa **** 4242");
  });

  it("creates recurring and terminal payments, cancels and creates payment links", async () => {
    const { p, seen } = provider({
      "POST /payments": (req) =>
        req.body?.method === "pointofsale"
          ? { status: 201, json: molliePayment({ id: "tr_terminal01", method: "pointofsale", _links: {} }) }
          : { status: 201, json: molliePayment({ id: "tr_recurring1", status: "pending", sequenceType: "recurring", method: "directdebit", _links: {} }) },
      "DELETE /payments/tr_WDqYK6vllg": { json: molliePayment({ status: "canceled" }) },
      "DELETE /payments/tr_paidalready": { status: 422, json: { status: 422, title: "Unprocessable Entity", detail: "The payment cannot be canceled" } },
      "POST /payment-links": { status: 201, json: { resource: "payment-link", id: "pl_4Y0eZitmBnQ6IDoMqZQKh", _links: { paymentLink: { href: "https://paymentlink.mollie.com/payment/4Y0eZitmBnQ6IDoMqZQKh/" } } } },
    });
    const rec = await p.createRecurringPayment({ customerId: "cst_8wmqcHMN4U", mandateId: "mdt_pWUnw6pkBN", amountCents: 8900, description: "BEAM-REN001", webhookUrl: "/api/webhooks/mollie?t=x", metadata: { orderId: "o2", paymentId: "p2" }, idempotencyKey: "charge_recurring:p2" });
    expect(rec).toEqual({ providerPaymentId: "tr_recurring1", status: "pending" });
    expect(seen[0]!.body).toMatchObject({ sequenceType: "recurring", customerId: "cst_8wmqcHMN4U", mandateId: "mdt_pWUnw6pkBN", amount: { currency: "EUR", value: "89.00" } });
    expect(seen[0]!.headers.get("idempotency-key")).toBe("charge_recurring:p2");

    const term = await p.createTerminalPayment({ terminalId: "term_7MgL4wea46qkRcoTZjWEH", amountCents: 4500, description: "BEAM-POS001", webhookUrl: "/api/webhooks/mollie?t=x", metadata: { orderId: "o3", paymentId: "p3" }, idempotencyKey: "payment_terminal:p3" });
    expect(term).toEqual({ providerPaymentId: "tr_terminal01", status: "open" });
    expect(seen[1]!.body).toMatchObject({ method: "pointofsale", terminalId: "term_7MgL4wea46qkRcoTZjWEH" });
    expect(seen[1]!.headers.get("idempotency-key")).toBe("payment_terminal:p3");

    expect(await p.cancelPayment("tr_WDqYK6vllg")).toEqual({ cancelled: true });
    expect(await p.cancelPayment("tr_paidalready")).toEqual({ cancelled: false });

    const link = await p.createPaymentLink({ amountCents: 2500, description: "Gift", expiresAt: new Date("2026-11-18T22:59:00Z"), redirectUrl: "/nl-BE/pay/done", webhookUrl: "/api/webhooks/mollie?t=x" });
    expect(link).toEqual({ linkId: "pl_4Y0eZitmBnQ6IDoMqZQKh", url: "https://paymentlink.mollie.com/payment/4Y0eZitmBnQ6IDoMqZQKh/" });
    expect(seen.at(-1)!.body).toMatchObject({ expiresAt: "2026-11-18T22:59:00+00:00", amount: { value: "25.00" } });
  });

  it("429 and 5xx are retryable, 422 and 401 permanent, with the Mollie detail scrubbed", async () => {
    const { p } = provider({
      "GET /payments/tr_slow0001": { status: 429, json: { status: 429, title: "Too Many Requests" } },
      "GET /payments/tr_down0001": { status: 503, text: "upstream down" },
      "POST /payments": { status: 422, json: { status: 422, title: "Unprocessable Entity", detail: "The amount is lower than the minimum", field: "amount" } },
      "GET /payments/tr_auth0001": { status: 401, json: { status: 401, title: "Unauthorized Request", detail: "Missing authentication" } },
    });
    await expect(p.getPayment("tr_slow0001")).rejects.toMatchObject({ provider: "mollie", operation: "payments.get", retryable: true, statusCode: 429 });
    await expect(p.getPayment("tr_down0001")).rejects.toMatchObject({ retryable: true, statusCode: 503 });
    await expect(p.createPayment(createInput)).rejects.toMatchObject({ retryable: false, statusCode: 422, message: expect.stringContaining("lower than the minimum") });
    await expect(p.getPayment("tr_auth0001")).rejects.toMatchObject({ retryable: false, statusCode: 401 });
  });

  it("network failures and timeouts are retryable", async () => {
    const failing = createMollieProvider({ apiKey: "k", webhookBaseUrl: "https://beam.example.com", fetch: () => Promise.reject(new TypeError("fetch failed")) });
    await expect(failing.getPayment("tr_WDqYK6vllg")).rejects.toMatchObject({ retryable: true, code: "network" });
    const hanging = createMollieProvider({ apiKey: "k", webhookBaseUrl: "https://beam.example.com", timeoutMs: 10, fetch: () => new Promise<Response>(() => undefined) });
    await expect(hanging.getPayment("tr_WDqYK6vllg")).rejects.toMatchObject({ retryable: true, code: "timeout" });
  });

  it("rejects malformed bodies with Zod as a permanent invalid_response", async () => {
    const { p } = provider({
      "GET /payments/tr_bad00001": { json: molliePayment({ id: "tr_bad00001", status: "weird" }) },
      "GET /payments/tr_bad00002": { json: molliePayment({ id: "tr_bad00002", amount: { value: "45", currency: "EUR" } }) },
      "GET /payments/tr_bad00003": { json: molliePayment({ id: "tr_bad00003", amount: { value: "45.00", currency: "USD" } }) },
      "GET /payments/tr_bad00004": { text: "<html>gateway</html>" },
      "POST /payments": { status: 201, json: molliePayment({ _links: {} }) },
      "POST /customers": { status: 201, json: { id: "not-a-customer" } },
    });
    for (const id of ["tr_bad00001", "tr_bad00002", "tr_bad00003", "tr_bad00004"]) {
      await expect(p.getPayment(id), id).rejects.toMatchObject({ retryable: false, code: "invalid_response" });
    }
    await expect(p.createPayment(createInput)).rejects.toMatchObject({ code: "invalid_response" });
    await expect(p.createCustomer({ name: "x", email: "x@example.com", locale: "en" })).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("reports every call to onCall with operation, digest, status and duration, never bodies or keys", async () => {
    const { p, log } = provider({
      "POST /payments": { status: 201, json: molliePayment() },
      "GET /payments/tr_WDqYK6vllg": { json: molliePayment() },
      "GET /payments/tr_other0001": { json: molliePayment({ id: "tr_other0001" }) },
      "POST /customers": { status: 422, json: { status: 422, title: "Unprocessable Entity", detail: "Invalid email member@example.com" } },
    });
    await p.createPayment(createInput);
    await p.getPayment("tr_WDqYK6vllg");
    await p.getPayment("tr_other0001");
    await p.createCustomer({ name: "Test Person", email: "member@example.com", locale: "en" }).catch(() => undefined);
    expect(log.map((e) => [e.provider, e.operation, e.statusCode, e.ok])).toEqual([
      ["mollie", "payments.create", 201, true],
      ["mollie", "payments.get", 200, true],
      ["mollie", "payments.get", 200, true],
      ["mollie", "customers.create", 422, false],
    ]);
    expect(log[1]!.requestDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(log[1]!.requestDigest).toBe(log[2]!.requestDigest); // the path template, not the id
    for (const e of log) expect(e.durationMs).toBeGreaterThanOrEqual(0);
    const text = JSON.stringify(log);
    expect(text).not.toMatch(/BEAM-7K3QX2|Test Person|member@example\.com|test_dHar4XY7|45\.00|orderId/);
    expect(log[3]!.error).toContain("[email]");
  });

  it("verifies webhooks: a well-formed tr_ id, plus the query token or HMAC signature when a secret is set", () => {
    const req = (body: string, url = "https://beam.example.com/api/webhooks/mollie", headers: Record<string, string> = {}) => ({ headers: new Headers(headers), rawBody: body, url: new URL(url) });
    const open = createMollieProvider({ apiKey: "k", webhookBaseUrl: "https://beam.example.com" });
    expect(open.verifyWebhook(req("id=tr_WDqYK6vllg"))).toBe(true);
    expect(open.verifyWebhook(req("id=re_4qqhO89gsT"))).toBe(false);
    expect(open.verifyWebhook(req("id=tr_bad%27%3B"))).toBe(false);
    expect(open.verifyWebhook(req(""))).toBe(false);

    const secret = "whsec_test_0123456789abcdef";
    const signed = createMollieProvider({ apiKey: "k", webhookBaseUrl: "https://beam.example.com", webhookSecret: secret });
    expect(signed.verifyWebhook(req("id=tr_WDqYK6vllg", `https://beam.example.com/api/webhooks/mollie?t=${secret}`))).toBe(true);
    expect(signed.verifyWebhook(req("id=tr_WDqYK6vllg", "https://beam.example.com/api/webhooks/mollie?t=wrong"))).toBe(false);
    expect(signed.verifyWebhook(req("id=tr_WDqYK6vllg"))).toBe(false);
    const hmac = createHmac("sha256", secret).update("id=tr_WDqYK6vllg").digest("hex");
    expect(signed.verifyWebhook(req("id=tr_WDqYK6vllg", undefined, { "x-mollie-signature": `sha256=${hmac}` }))).toBe(true);
    expect(signed.verifyWebhook(req("id=tr_WDqYK6vllg", undefined, { "x-mollie-signature": hmac }))).toBe(true);
    expect(signed.verifyWebhook(req("id=tr_OTHERvllg", undefined, { "x-mollie-signature": `sha256=${hmac}` }))).toBe(false);
  });
});
