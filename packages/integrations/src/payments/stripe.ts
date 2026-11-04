/**
 * The Stripe adapter: a stub in V1 (commerce spec section 6, decision 37). Every method rejects
 * with `IntegrationError { provider: 'stripe', retryable: false, message: 'not_configured' }`;
 * `selectProvider` refuses Stripe while `STRIPE_API_KEY` is absent, and the settings validation
 * of `payment_provider_by_channel` uses `unconfiguredChannels` (select.ts) to refuse selecting it.
 */
import { createStubProvider, type PaymentProvider } from "./provider";

/** The environment variables a configured Stripe adapter needs. */
export const STRIPE_ENV_KEYS = ["STRIPE_API_KEY"] as const;

export function isStripeConfigured(env: Readonly<Record<string, string | undefined>>): boolean {
  return STRIPE_ENV_KEYS.every((k) => !!env[k]);
}

export function createStripeProvider(): PaymentProvider {
  return createStubProvider("stripe");
}
