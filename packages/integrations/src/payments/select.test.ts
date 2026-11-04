import { describe, expect, it } from "vitest";
import { ORDER_CHANNELS, PAYMENT_PROVIDER_BY_CHANNEL_DEFAULTS, type PaymentProviderByChannelValue } from "@beam/core/commerce";
import { createPaymentsFake } from "./fake";
import { isProviderConfigured, paymentsMode, selectProvider, unconfiguredChannels, type ProviderEnv } from "./select";

const defaults = PAYMENT_PROVIDER_BY_CHANNEL_DEFAULTS;
const mixed: PaymentProviderByChannelValue = { portal: "mollie", site: "stripe", admin: "viva", pos: "mollie", link: "mollie", recurring: "mollie" };
const live = { MOLLIE_API_KEY: "test_abcdefghijklmnop", APP_URL: "https://beam.example.com" };

describe("selectProvider", () => {
  it("serves each channel with the provider its setting names", () => {
    const env = { ...live, STRIPE_API_KEY: "sk_test_x", VIVA_CLIENT_ID: "id", VIVA_CLIENT_SECRET: "secret" };
    const names = Object.fromEntries(ORDER_CHANNELS.map((c) => [c, selectProvider(c, mixed, env).name]));
    expect(names).toEqual({ portal: "mollie", site: "stripe", admin: "viva", pos: "mollie", link: "mollie", recurring: "mollie" });
    for (const c of ORDER_CHANNELS) expect(selectProvider(c, defaults, live).name).toBe("mollie");
  });

  it("the real Mollie adapter is wired with the environment's base URL, onCall and fetch", async () => {
    const urls: string[] = [];
    const entries: string[] = [];
    const p = selectProvider("portal", defaults, live, {
      onCall: (e) => void entries.push(e.operation),
      fetch: (input) => {
        urls.push(String(input));
        return Promise.resolve(new Response(JSON.stringify({ status: 404, title: "Not Found" }), { status: 404 }));
      },
    });
    await expect(p.getPayment("tr_unknown01")).rejects.toMatchObject({ statusCode: 404, retryable: false });
    expect(urls).toEqual(["https://api.mollie.com/v2/payments/tr_unknown01?embed=refunds,chargebacks"]);
    expect(entries).toEqual(["payments.get"]);
  });

  it("refuses a Stripe or Viva stub without its keys, outside fake mode", () => {
    expect(() => selectProvider("site", mixed, live)).toThrow(expect.objectContaining({ provider: "stripe", retryable: false, code: "not_configured" }));
    expect(() => selectProvider("admin", mixed, { ...live, VIVA_CLIENT_ID: "id" })).toThrow(expect.objectContaining({ provider: "viva", code: "not_configured" }));
    expect(() => selectProvider("site", mixed, { ...live, APP_ENV: "production" })).toThrow(expect.objectContaining({ code: "not_configured" }));
    expect(unconfiguredChannels(mixed, live)).toEqual(["site", "admin"]);
    expect(unconfiguredChannels(mixed, { ...live, STRIPE_API_KEY: "sk_test_x" })).toEqual(["admin"]);
    expect(unconfiguredChannels(defaults, live)).toEqual([]);
    expect(isProviderConfigured("viva", { VIVA_CLIENT_ID: "id", VIVA_CLIENT_SECRET: "s" })).toBe(true);
  });

  it("a configured stub is selected and still refuses every call", async () => {
    const p = selectProvider("site", mixed, { ...live, STRIPE_API_KEY: "sk_test_x" });
    await expect(p.getPayment("x")).rejects.toMatchObject({ provider: "stripe", message: "not_configured" });
  });

  it("without a Mollie key outside production the payments fake serves; in production Mollie is refused", () => {
    expect(selectProvider("portal", defaults, {}).name).toBe("fake");
    expect(() => selectProvider("portal", defaults, { APP_ENV: "production" })).toThrow(expect.objectContaining({ provider: "mollie", code: "not_configured" }));
    expect(selectProvider("portal", defaults, { APP_ENV: "staging", ...live }).name).toBe("mollie");
  });

  it("INTEGRATIONS=fake gives the fake for every provider, stubs included", () => {
    const fake = createPaymentsFake({ isolated: true });
    for (const c of ORDER_CHANNELS) expect(selectProvider(c, mixed, { ...live, INTEGRATIONS: "fake" }, { fake })).toBe(fake);
    expect(unconfiguredChannels(mixed, { INTEGRATIONS: "fake" })).toEqual([]);
  });
});

describe("PAYMENTS_FAKE=1", () => {
  it("selects the payments fake even with a Mollie key", () => {
    const env = { ...live, PAYMENTS_FAKE: "1" };
    for (const c of ORDER_CHANNELS) expect(selectProvider(c, defaults, env).name).toBe("fake");
    expect(paymentsMode(env)).toBe("fake");
    expect(paymentsMode({ ...live, PAYMENTS_FAKE: "0" })).toBe("real");
  });

  it("the default fake is the process-wide one, so the dev pay page and the webhook see one store", async () => {
    const a = selectProvider("portal", defaults, { PAYMENTS_FAKE: "1" });
    const b = createPaymentsFake();
    const { providerPaymentId } = await a.createPayment({
      amountCents: 100,
      description: "x",
      redirectUrl: "http://localhost:3000/x",
      webhookUrl: "http://localhost:3000/api/webhooks/mollie",
      locale: "en",
      sequenceType: "oneoff",
      metadata: { orderId: "o", paymentId: "p" },
      idempotencyKey: `select:${Date.now()}`,
    });
    expect(b.payment(providerPaymentId)).toBeDefined();
  });

  it("leaves every other provider switch alone: it reads only payment variables and writes none", () => {
    const read = new Set<string>();
    const values: Record<string, string> = { ...live, PAYMENTS_FAKE: "1", RESEND_API_KEY: "re_x", BILLIT_API_KEY: "b", ANTHROPIC_API_KEY: "a", SLACK_WEBHOOK_URL: "https://hooks.slack.com/x" };
    const env = new Proxy(values, {
      get(target, prop: string) {
        read.add(prop);
        return target[prop];
      },
      set() {
        throw new Error("selectProvider must not write the environment");
      },
    }) as ProviderEnv;
    for (const c of ORDER_CHANNELS) selectProvider(c, mixed, env, { fake: createPaymentsFake({ isolated: true }) });
    unconfiguredChannels(mixed, env);
    const allowed = new Set(["APP_ENV", "INTEGRATIONS", "PAYMENTS_FAKE", "MOLLIE_API_KEY", "MOLLIE_WEBHOOK_SECRET", "APP_URL", "STRIPE_API_KEY", "VIVA_CLIENT_ID", "VIVA_CLIENT_SECRET"]);
    expect([...read].filter((k) => !allowed.has(k))).toEqual([]);
    expect(values.INTEGRATIONS).toBeUndefined();
    expect(Object.keys(values).sort()).toEqual(["ANTHROPIC_API_KEY", "APP_URL", "BILLIT_API_KEY", "MOLLIE_API_KEY", "PAYMENTS_FAKE", "RESEND_API_KEY", "SLACK_WEBHOOK_URL"]);
  });

  it("does not override production or staging, where the real adapter always runs", () => {
    expect(paymentsMode({ ...live, APP_ENV: "production", PAYMENTS_FAKE: "1" })).toBe("real");
    expect(selectProvider("portal", defaults, { ...live, APP_ENV: "production", PAYMENTS_FAKE: "1" }).name).toBe("mollie");
  });
});
