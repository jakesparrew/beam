/**
 * The ads client selector (runbook section 1.5, ops spec section 6). The ads clients are not
 * among the six shared clients of `getIntegrations()`; ops builds them here with the same rule:
 * `real` builds the Meta and Google clients from `META_ADS_TOKEN` and `GOOGLE_ADS_TOKEN`
 * (plus the optional `GOOGLE_ADS_DEVELOPER_TOKEN` and `GOOGLE_ADS_LOGIN_CUSTOMER_ID`), `fake`
 * returns `createAdsFake()`. A real platform without its token fails every call permanently
 * (`not_configured`), so production never falls back to invented numbers.
 */
import { IntegrationError } from "../_shared/errors";
import type { FetchLike, OnCall } from "../_shared/types";
import { createAdsFake } from "./fake";
import { createGoogleAdsClient } from "./google";
import { createMetaAdsClient } from "./meta";
import type { AdsClients, GoogleAdsClient, MetaAdsClient } from "./types";

export { createGoogleAdsClient, type GoogleAdsClientOptions } from "./google";
export { createMetaAdsClient, type MetaAdsClientOptions } from "./meta";

export const ADS_KEYS = { meta: "META_ADS_TOKEN", google: "GOOGLE_ADS_TOKEN" } as const;

type Env = Readonly<Record<string, string | undefined>>;

const notConfiguredMeta = (): MetaAdsClient => ({
  getCampaignInsights: () => Promise.reject(new IntegrationError({ provider: "meta_ads", operation: "insights.get", retryable: false, code: "not_configured", message: "not_configured: meta_ads" })),
});
const notConfiguredGoogle = (): GoogleAdsClient => ({
  getCampaignStats: () => Promise.reject(new IntegrationError({ provider: "google_ads", operation: "campaign_stats.get", retryable: false, code: "not_configured", message: "not_configured: google_ads" })),
});

/**
 * Builds both clients. `mode(platform, keyEnv)` is the caller's selection rule (the app passes
 * `integrationMode` from `@/lib/integrations`).
 */
export function createAdsClients(options: { env: Env; mode: (provider: string, keyEnv: string) => "real" | "fake"; onCall?: OnCall; fetch?: FetchLike }): AdsClients {
  const { env } = options;
  let fake: ReturnType<typeof createAdsFake> | undefined;
  const fakes = () => (fake ??= createAdsFake(options.onCall ? { onCall: options.onCall } : {}));
  const common = { ...(options.onCall ? { onCall: options.onCall } : {}), ...(options.fetch ? { fetch: options.fetch } : {}) };
  const metaToken = env[ADS_KEYS.meta];
  const googleToken = env[ADS_KEYS.google];
  return {
    meta: options.mode("meta_ads", ADS_KEYS.meta) === "fake" ? fakes().meta : metaToken ? createMetaAdsClient({ accessToken: metaToken, ...common }) : notConfiguredMeta(),
    google:
      options.mode("google_ads", ADS_KEYS.google) === "fake"
        ? fakes().google
        : googleToken
          ? createGoogleAdsClient({
              accessToken: googleToken,
              ...(env.GOOGLE_ADS_DEVELOPER_TOKEN ? { developerToken: env.GOOGLE_ADS_DEVELOPER_TOKEN } : {}),
              ...(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID ? { loginCustomerId: env.GOOGLE_ADS_LOGIN_CUSTOMER_ID } : {}),
              ...common,
            })
          : notConfiguredGoogle(),
  };
}
