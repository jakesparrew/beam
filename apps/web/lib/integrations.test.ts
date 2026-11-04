import { describe, expect, it, vi } from "vitest";
import { buildIntegrations, integrationMode, withIntegrationLog, createFakeIntegrations } from "./integrations";

describe("integrationMode (runbook 1.5)", () => {
  it("production and staging are always real", () => {
    expect(integrationMode("resend", "RESEND_API_KEY", { APP_ENV: "production", INTEGRATIONS: "fake" })).toBe("real");
    expect(integrationMode("payments", "MOLLIE_API_KEY", { APP_ENV: "staging", PAYMENTS_FAKE: "1" })).toBe("real");
  });

  it("elsewhere INTEGRATIONS=fake, PAYMENTS_FAKE=1 for payments, else real exactly when the key is present", () => {
    expect(integrationMode("resend", "RESEND_API_KEY", { APP_ENV: "local", INTEGRATIONS: "fake", RESEND_API_KEY: "re_x" })).toBe("fake");
    expect(integrationMode("payments", "MOLLIE_API_KEY", { APP_ENV: "preview", PAYMENTS_FAKE: "1", MOLLIE_API_KEY: "test_x" })).toBe("fake");
    expect(integrationMode("resend", "RESEND_API_KEY", { APP_ENV: "preview", PAYMENTS_FAKE: "1", RESEND_API_KEY: "re_x" })).toBe("real");
    expect(integrationMode("slack", "SLACK_WEBHOOK_URL", { APP_ENV: "local" })).toBe("fake");
  });

  it("production without a key gives a client that fails permanently with not_configured", async () => {
    const clients = buildIntegrations({ APP_ENV: "production" });
    await expect(clients.slack.postMessage({ text: "x" })).rejects.toThrow(/not_configured/);
    await expect(clients.payments.getPayment("tr_1")).rejects.toThrow(/not_configured/);
  });

  it("real payments with MOLLIE_API_KEY build the Mollie adapter (key, APP_URL, webhook secret, routed onCall)", async () => {
    const calls: { url: string; auth: string | null }[] = [];
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: input instanceof Request ? input.url : input.toString(), auth: new Headers(init?.headers).get("authorization") });
      return Promise.resolve(new Response(JSON.stringify({ detail: "recorded failure" }), { status: 404, headers: { "content-type": "application/json" } }));
    });
    try {
      const env = { APP_ENV: "local", MOLLIE_API_KEY: "test_fixture_key", APP_URL: "https://beam.example.com", MOLLIE_WEBHOOK_SECRET: "whsec_fixture" };
      const clients = buildIntegrations(env);
      expect(clients.payments.name).toBe("mollie");

      // The webhook secret is passed through: a body id alone is refused, the token makes it valid.
      const rawBody = "id=tr_abcd1234";
      const headers = new Headers();
      expect(clients.payments.verifyWebhook({ headers, rawBody, url: new URL("https://beam.example.com/api/webhooks/mollie") })).toBe(false);
      expect(clients.payments.verifyWebhook({ headers, rawBody, url: new URL("https://beam.example.com/api/webhooks/mollie?t=whsec_fixture") })).toBe(true);

      // Calls go to Mollie with the key and are reported through the routed onCall.
      const seen: string[] = [];
      await withIntegrationLog(
        (e) => void seen.push(`${e.provider}:${e.ok}`),
        () => clients.payments.getPayment("tr_abcd1234").catch(() => undefined),
      );
      expect(calls[0]?.url.split("?")[0]).toBe("https://api.mollie.com/v2/payments/tr_abcd1234");
      expect(calls[0]?.auth).toBe("Bearer test_fixture_key");
      expect(seen).toEqual(["mollie:false"]);

      // Production and staging are real too; without a secret any well-formed id passes to the fetch-by-id check.
      const prod = buildIntegrations({ APP_ENV: "production", MOLLIE_API_KEY: "live_fixture_key", APP_URL: "https://beam.example.com" });
      expect(prod.payments.name).toBe("mollie");
      expect(prod.payments.verifyWebhook({ headers, rawBody, url: new URL("https://beam.example.com/api/webhooks/mollie") })).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("INTEGRATIONS=fake or PAYMENTS_FAKE=1 keep the payments fake outside production and staging, even with a key", () => {
    expect(buildIntegrations({ APP_ENV: "local", MOLLIE_API_KEY: "test_fixture_key", PAYMENTS_FAKE: "1" }).payments.name).toBe("fake");
    expect(buildIntegrations({ APP_ENV: "preview", MOLLIE_API_KEY: "test_fixture_key", INTEGRATIONS: "fake" }).payments.name).toBe("fake");
    expect(buildIntegrations({ APP_ENV: "local" }).payments.name).toBe("fake");
    expect(buildIntegrations({ APP_ENV: "staging", MOLLIE_API_KEY: "test_fixture_key", PAYMENTS_FAKE: "1" }).payments.name).toBe("mollie");
  });

  it("fake mode routes each call to the running job's log", async () => {
    const fakes = createFakeIntegrations();
    const seen: string[] = [];
    await withIntegrationLog((e) => void seen.push(`${e.provider}:${e.operation}:${e.ok}`), () => fakes.slack.postMessage({ text: "hello" }));
    expect(seen).toEqual(["slack:webhook.post:true"]);
    expect(buildIntegrations({ APP_ENV: "local", INTEGRATIONS: "fake" }).anthropic).toHaveProperty("script");
  });
});
