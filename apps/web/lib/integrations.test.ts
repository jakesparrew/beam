import { describe, expect, it } from "vitest";
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

  it("fake mode routes each call to the running job's log", async () => {
    const fakes = createFakeIntegrations();
    const seen: string[] = [];
    await withIntegrationLog((e) => void seen.push(`${e.provider}:${e.operation}:${e.ok}`), () => fakes.slack.postMessage({ text: "hello" }));
    expect(seen).toEqual(["slack:webhook.post:true"]);
    expect(buildIntegrations({ APP_ENV: "local", INTEGRATIONS: "fake" }).anthropic).toHaveProperty("script");
  });
});
