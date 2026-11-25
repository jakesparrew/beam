/**
 * Provider selection (commerce rule 29): `settings.payment_provider_by_channel[channel]` names
 * the provider; the environment decides between the real adapter and the payments fake with the
 * rule of runbook section 1.5, restricted to payments:
 *   1. `APP_ENV=production` or `staging`: always the real adapter.
 *   2. `INTEGRATIONS=fake` or `PAYMENTS_FAKE=1`: the payments fake (D49: `PAYMENTS_FAKE` switches
 *      payments only; every other provider keeps its own switch, and in production platform's
 *      `/api/health` `config` check fails with 503 while it is set).
 *   3. Otherwise the real adapters exactly when `STRIPE_API_KEY` or `MOLLIE_API_KEY` is present,
 *      else the fake. `INTEGRATIONS_REAL=payments` keeps payments real under `INTEGRATIONS=fake`
 *      (a local test against Stripe's test mode while every other provider stays fake).
 * Stripe is a real adapter; Viva is a stub. A provider without its keys is refused
 * (`IntegrationError` `not_configured`), and `unconfiguredChannels` lets the settings validation
 * refuse selecting it (decision 37).
 */
import type { OnlinePaymentProvider, OrderChannel, PaymentProviderByChannelValue } from "@beam/core/commerce";
import type { FetchLike, OnCall } from "../_shared/types";
import { createPaymentsFake } from "./fake";
import { createMollieProvider } from "./mollie";
import { notConfiguredError, type PaymentProvider } from "./provider";
import { createStripeProvider, isStripeConfigured, STRIPE_ENV_KEYS } from "./stripe";
import { createVivaProvider, isVivaConfigured, VIVA_ENV_KEYS } from "./viva";

/** The environment: `process.env` or a plain record (tests). */
export type ProviderEnv = Readonly<Record<string, string | undefined>>;

export type SelectProviderOptions = {
  onCall?: OnCall;
  fetch?: FetchLike;
  /** The fake to return in fake mode; defaults to the process-wide payments fake (shared store). */
  fake?: PaymentProvider;
};

/** The environment variables each online provider needs before it may be selected. */
export const PAYMENT_PROVIDER_ENV_KEYS: Record<OnlinePaymentProvider, readonly string[]> = {
  mollie: ["MOLLIE_API_KEY"],
  stripe: STRIPE_ENV_KEYS,
  viva: VIVA_ENV_KEYS,
};

/** `INTEGRATIONS_REAL` lists `payments`: payments stay real under `INTEGRATIONS=fake` (local tests). */
export function paymentsForcedReal(env: ProviderEnv): boolean {
  return (env.INTEGRATIONS_REAL ?? "").split(",").map((s) => s.trim()).includes("payments");
}

/**
 * Real or fake payments for this environment, the same rule as platform's
 * `integrationMode('payments', ...)`. Reads only `APP_ENV`, `INTEGRATIONS`, `INTEGRATIONS_REAL`,
 * `PAYMENTS_FAKE`, `STRIPE_API_KEY` and `MOLLIE_API_KEY`; no other provider's switch is read.
 */
export function paymentsMode(env: ProviderEnv): "real" | "fake" {
  const appEnv = env.APP_ENV;
  if (appEnv === "production" || appEnv === "staging") return "real";
  if (env.PAYMENTS_FAKE === "1") return "fake";
  if (env.INTEGRATIONS === "fake" && !paymentsForcedReal(env)) return "fake";
  return isProviderConfigured("stripe", env) || isProviderConfigured("mollie", env) ? "real" : "fake";
}

export function isProviderConfigured(provider: OnlinePaymentProvider, env: ProviderEnv): boolean {
  if (provider === "stripe") return isStripeConfigured(env);
  if (provider === "viva") return isVivaConfigured(env);
  return PAYMENT_PROVIDER_ENV_KEYS.mollie.every((k) => !!env[k]);
}

/**
 * The channels whose configured provider cannot run here: a Stripe or Viva stub without its
 * keys (outside fake mode). The settings validation of `payment_provider_by_channel` refuses a
 * value for which this is not empty.
 */
export function unconfiguredChannels(settings: PaymentProviderByChannelValue, env: ProviderEnv): OrderChannel[] {
  return (Object.keys(settings) as OrderChannel[]).filter((channel) => {
    const provider = settings[channel];
    if (provider === "mollie") return false;
    return paymentsMode(env) === "real" && !isProviderConfigured(provider, env);
  });
}

/** The provider that serves `channel`: the real adapter or the payments fake. */
export function selectProvider(
  channel: OrderChannel,
  settings: PaymentProviderByChannelValue,
  env: ProviderEnv,
  options: SelectProviderOptions = {},
): PaymentProvider {
  const provider = settings[channel];
  if (!provider) throw notConfiguredError("mollie", `select.${channel}`);
  if (paymentsMode(env) === "fake") return options.fake ?? createPaymentsFake({ ...(options.onCall ? { onCall: options.onCall } : {}), isolated: false });

  if (provider === "stripe") {
    if (!isProviderConfigured("stripe", env)) throw notConfiguredError("stripe", `select.${channel}`);
    return createStripeProvider({
      apiKey: env.STRIPE_API_KEY!,
      appBaseUrl: env.APP_URL ?? "http://localhost:3000",
      ...(env.STRIPE_WEBHOOK_SECRET ? { webhookSecret: env.STRIPE_WEBHOOK_SECRET } : {}),
      ...(options.onCall ? { onCall: options.onCall } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }
  if (provider === "viva") {
    // A stub in V1: refused while its keys are absent; with keys every call still refuses.
    if (!isProviderConfigured("viva", env)) throw notConfiguredError("viva", `select.${channel}`);
    return createVivaProvider();
  }

  const apiKey = env.MOLLIE_API_KEY;
  if (!apiKey) throw notConfiguredError("mollie", `select.${channel}`);
  return createMollieProvider({
    apiKey,
    webhookBaseUrl: env.APP_URL ?? "http://localhost:3000",
    ...(env.MOLLIE_WEBHOOK_SECRET ? { webhookSecret: env.MOLLIE_WEBHOOK_SECRET } : {}),
    ...(options.onCall ? { onCall: options.onCall } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}
