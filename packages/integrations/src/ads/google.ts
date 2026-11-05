/**
 * The real Google Ads API client (ops spec section 6, read-only): `getCampaignStats` runs the
 * GAQL query `select campaign.id, campaign.name, metrics.cost_micros, metrics.impressions,
 * metrics.clicks, metrics.conversions, customer.currency_code from campaign where segments.date
 * = '<day>'` through `customers/<id>/googleAds:search` and pages through `nextPageToken`.
 * `spendCents = round(cost_micros / 10000)`; `leads` is `metrics.conversions` rounded. Status
 * mapping as every client: 408, 425, 429 and 5xx retry; 401, 403 and other 4xx are permanent.
 */
import { z } from "zod";
import { digestRequest } from "../_shared/digest";
import { errorFromStatus, IntegrationError } from "../_shared/errors";
import { trackCall, withTimeout } from "../_shared/timeout";
import { noopOnCall, type FetchLike, type OnCall } from "../_shared/types";
import { assertAdDay, toCount, type AdDayRow, type GoogleAdsClient } from "./types";

export const GOOGLE_ADS_API = "https://googleads.googleapis.com/v17";
const OPERATION = "campaign_stats.get";

const num = z.union([z.string(), z.number()]).optional();
const SearchRow = z.object({
  campaign: z.object({ id: z.union([z.string(), z.number()]), name: z.string().default("") }),
  metrics: z.object({ costMicros: num, impressions: num, clicks: num, conversions: num }).default({}),
  customer: z.object({ currencyCode: z.string().optional() }).optional(),
});
const SearchPage = z.object({ results: z.array(SearchRow).default([]), nextPageToken: z.string().optional() });

export type GoogleAdsClientOptions = {
  accessToken: string;
  developerToken?: string;
  loginCustomerId?: string;
  onCall?: OnCall;
  fetch?: FetchLike;
  timeoutMs?: number;
  baseUrl?: string;
};

/** Rule (ops spec 6): micros to cents, `round(cost_micros / 10000)`. */
export function microsToCents(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n / 10_000) : 0;
}

export function googleQuery(day: string): string {
  assertAdDay(day);
  return `select campaign.id, campaign.name, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, customer.currency_code from campaign where segments.date = '${day}'`;
}

export function mapGoogleRow(row: z.infer<typeof SearchRow>): AdDayRow {
  const id = String(row.campaign.id);
  return {
    campaignId: id,
    campaignName: row.campaign.name || id,
    spendCents: microsToCents(row.metrics.costMicros),
    impressions: toCount(row.metrics.impressions),
    clicks: toCount(row.metrics.clicks),
    leads: toCount(row.metrics.conversions),
    ...(row.customer?.currencyCode ? { currency: row.customer.currencyCode.toUpperCase() } : {}),
  };
}

export function createGoogleAdsClient(options: GoogleAdsClientOptions): GoogleAdsClient {
  const onCall = options.onCall ?? noopOnCall;
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? 20_000;
  const base = options.baseUrl ?? GOOGLE_ADS_API;

  return {
    async getCampaignStats({ customerId, day }) {
      const query = googleQuery(day);
      const id = customerId.replace(/-/g, "");
      const path = `/customers/${encodeURIComponent(id)}/googleAds:search`;
      const headers: Record<string, string> = { authorization: `Bearer ${options.accessToken}`, "content-type": "application/json" };
      if (options.developerToken) headers["developer-token"] = options.developerToken;
      if (options.loginCustomerId) headers["login-customer-id"] = options.loginCustomerId.replace(/-/g, "");
      const out: AdDayRow[] = [];
      let pageToken: string | undefined;
      for (let n = 0; n < 20; n++) {
        const body = await trackCall(onCall, { provider: "google_ads", operation: OPERATION, requestDigest: digestRequest({ method: "POST", path, params: { day } }) }, () =>
          withTimeout(
            async (signal) => {
              const res = await doFetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify({ query, ...(pageToken ? { pageToken } : {}) }), signal });
              if (!res.ok) throw errorFromStatus("google_ads", OPERATION, res.status, await res.text().catch(() => ""));
              const parsed = SearchPage.safeParse(await res.json().catch(() => null));
              if (!parsed.success) throw new IntegrationError({ provider: "google_ads", operation: OPERATION, retryable: false, code: "invalid_response", statusCode: res.status, message: "google_ads campaign_stats.get: unexpected response" });
              return { value: parsed.data, statusCode: res.status };
            },
            timeoutMs,
            { provider: "google_ads", operation: OPERATION },
          ),
        );
        out.push(...body.results.map(mapGoogleRow));
        pageToken = body.nextPageToken || undefined;
        if (!pageToken) break;
      }
      return out;
    },
  };
}
