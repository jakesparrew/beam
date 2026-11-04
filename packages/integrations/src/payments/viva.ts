/**
 * The Viva Wallet adapter: a stub in V1 (commerce spec section 6, decision 37). Every method
 * rejects with `IntegrationError { provider: 'viva', retryable: false, message: 'not_configured' }`;
 * `selectProvider` refuses Viva while `VIVA_CLIENT_ID` or `VIVA_CLIENT_SECRET` is absent, and the
 * settings validation of `payment_provider_by_channel` uses `unconfiguredChannels` (select.ts).
 */
import { createStubProvider, type PaymentProvider } from "./provider";

/** The environment variables a configured Viva adapter needs. */
export const VIVA_ENV_KEYS = ["VIVA_CLIENT_ID", "VIVA_CLIENT_SECRET"] as const;

export function isVivaConfigured(env: Readonly<Record<string, string | undefined>>): boolean {
  return VIVA_ENV_KEYS.every((k) => !!env[k]);
}

export function createVivaProvider(): PaymentProvider {
  return createStubProvider("viva");
}
