/**
 * The one selector of real and fake provider clients (runbook section 1.5, platform spec 6).
 *
 * `integrationMode(provider, keyEnv)`:
 *   1. `APP_ENV=production` or `staging`: always real.
 *   2. Otherwise `INTEGRATIONS=fake` gives every fake; `PAYMENTS_FAKE=1` gives the payments fake.
 *   3. Else real exactly when the key is present.
 * `getIntegrations()` builds the six shared clients with that rule at first use, cached per
 * process. Clients report calls through one `onCall` that routes each entry to the running
 * job's `ctx.integrationLog` (`withIntegrationLog`), so `integration_calls` gets one row per call.
 * Tests never read the environment: they pass `createFakeIntegrations()` to `makeCtx`.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { PermanentError } from "@beam/core/errors";
import type { IntegrationCallEntry, OnCall } from "@beam/integrations/_shared";
import { createClaudeClient, createClaudeFake, type ClaudeClient, type ClaudeFake } from "@beam/integrations/anthropic";
import { createBetterstackClient, createBetterstackFake, type BetterstackClient, type BetterstackFake } from "@beam/integrations/betterstack";
import { createBillitClient, createBillitFake, type BillitApi, type BillitFake } from "@beam/integrations/billit";
import { createPaymentsFake, type PaymentProvider, type PaymentsFake } from "@beam/integrations/payments";
import { createResendClient, createResendFake, type ResendClient, type ResendFake } from "@beam/integrations/resend";
import { createSlackClient, createSlackFake, type SlackClient, type SlackFake } from "@beam/integrations/slack";

export type Integrations = {
  payments: PaymentProvider;
  resend: ResendClient;
  billit: BillitApi;
  anthropic: ClaudeClient;
  slack: SlackClient;
  betterstack: BetterstackClient;
};

export type FakeIntegrations = {
  payments: PaymentsFake;
  resend: ResendFake;
  billit: BillitFake;
  anthropic: ClaudeFake;
  slack: SlackFake;
  betterstack: BetterstackFake;
};

export type AppEnv = "local" | "preview" | "staging" | "production";

/** An environment: `process.env` or a plain record (tests). */
export type Env = Readonly<Record<string, string | undefined>>;

export function appEnv(env: Env = process.env): AppEnv {
  const v = env.APP_ENV;
  return v === "preview" || v === "staging" || v === "production" ? v : "local";
}

/** The rule of runbook section 1.5, for one provider. */
export function integrationMode(provider: string, keyEnv: string, env: Env = process.env): "real" | "fake" {
  const mode = appEnv(env);
  if (mode === "production" || mode === "staging") return "real";
  if (env.INTEGRATIONS === "fake") return "fake";
  if (provider === "payments" && env.PAYMENTS_FAKE === "1") return "fake";
  return env[keyEnv] ? "real" : "fake";
}

/** The env key that switches each shared provider to its real client. */
export const PROVIDER_KEYS = {
  payments: "MOLLIE_API_KEY",
  resend: "RESEND_API_KEY",
  billit: "BILLIT_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  slack: "SLACK_WEBHOOK_URL",
  betterstack: "BETTERSTACK_API_TOKEN",
} as const satisfies Record<keyof Integrations, string>;

// ---------------------------------------------------------------------------
// Call log routing
// ---------------------------------------------------------------------------

const sinks = new AsyncLocalStorage<(entry: IntegrationCallEntry) => void>();

/** Runs `work` so every provider call made inside it lands in `sink` (the job's `ctx.integrationLog`). */
export function withIntegrationLog<T>(sink: (entry: IntegrationCallEntry) => void, work: () => Promise<T>): Promise<T> {
  return sinks.run(sink, work);
}

/** The `onCall` every shared client is built with. */
export const routedOnCall: OnCall = (entry) => {
  sinks.getStore()?.(entry);
};

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/** A client whose every method fails permanently: production without the provider's key. */
function notConfigured<T extends object>(provider: string): T {
  return new Proxy({} as T, {
    get(_t, prop) {
      if (prop === "then") return undefined;
      if (prop === "name") return provider;
      return () => Promise.reject(new PermanentError(`not_configured: ${provider}`));
    },
  });
}

/** Every fake, sharing one `onCall`. */
export function createFakeIntegrations(options: { onCall?: OnCall; isolatedPayments?: boolean } = {}): FakeIntegrations {
  const onCall = options.onCall ?? routedOnCall;
  return {
    payments: createPaymentsFake({ onCall, isolated: options.isolatedPayments ?? true }),
    resend: createResendFake({ onCall }),
    billit: createBillitFake({ onCall }),
    anthropic: createClaudeFake({ onCall }),
    slack: createSlackFake({ onCall }),
    betterstack: createBetterstackFake({ onCall }),
  };
}

/** Builds the shared clients from the environment (exported for tests of the selection rule). */
export function buildIntegrations(env: Env = process.env): Integrations {
  const onCall = routedOnCall;
  const fakes = (() => {
    let made: FakeIntegrations | undefined;
    return () => (made ??= createFakeIntegrations({ onCall, isolatedPayments: false }));
  })();
  const real = (p: keyof Integrations) => integrationMode(p, PROVIDER_KEYS[p], env) === "real";
  const key = (p: keyof Integrations) => env[PROVIDER_KEYS[p]];

  return {
    payments: !real("payments")
      ? fakes().payments
      : // The Mollie adapter is commerce's (commerce-P4); until it exists the real path is not configured.
        notConfigured<PaymentProvider>("mollie"),
    resend: !real("resend")
      ? fakes().resend
      : key("resend")
        ? createResendClient({ apiKey: key("resend")!, onCall })
        : notConfigured<ResendClient>("resend"),
    billit: !real("billit")
      ? fakes().billit
      : createBillitClient({
          baseUrl: env.BILLIT_BASE_URL ?? "https://api.billit.be",
          apiKey: key("billit") ?? "",
          partyId: env.BILLIT_PARTY_ID ?? "",
          onCall,
        }),
    anthropic: !real("anthropic")
      ? fakes().anthropic
      : key("anthropic")
        ? createClaudeClient({ apiKey: key("anthropic")!, onCall })
        : notConfigured<ClaudeClient>("anthropic"),
    slack: !real("slack")
      ? fakes().slack
      : key("slack")
        ? createSlackClient({ webhookUrl: key("slack")!, onCall })
        : notConfigured<SlackClient>("slack"),
    betterstack: !real("betterstack")
      ? fakes().betterstack
      : key("betterstack")
        ? createBetterstackClient({ apiToken: key("betterstack")!, onCall })
        : notConfigured<BetterstackClient>("betterstack"),
  };
}

const cache = globalThis as unknown as { __beamIntegrations?: Integrations };

/** The shared clients of this process (fake or real per provider, section 1.5). */
export function getIntegrations(): Integrations {
  cache.__beamIntegrations ??= buildIntegrations();
  return cache.__beamIntegrations;
}

/** Tests and the demo seed may install a set (for example `createFakeIntegrations()`); `undefined` resets. */
export function setIntegrations(integrations: Integrations | undefined): void {
  cache.__beamIntegrations = integrations;
}
