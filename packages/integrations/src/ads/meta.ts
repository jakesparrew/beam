/**
 * The real Meta Marketing API client (ops spec section 6, read-only): `getCampaignInsights`
 * reads `/<act_id>/insights` at `level=campaign` for one day with the fields `campaign_id,
 * campaign_name, spend, impressions, clicks, actions, account_currency`. `spend` is a decimal
 * string in the account currency and becomes integer cents; `leads` is the `lead` action
 * (falling back to the pixel `offsite_conversion.fb_pixel_lead`). Pages through `paging.next`.
 * Status mapping: 408, 425, 429 and 5xx retry; 401 and 403 (an expired or revoked token) and
 * other 4xx are permanent. Every call is reported through `onCall`, never with the token.
 */
import { z } from "zod";
import { digestRequest } from "../_shared/digest";
import { errorFromStatus, IntegrationError } from "../_shared/errors";
import { trackCall, withTimeout } from "../_shared/timeout";
import { noopOnCall, type FetchLike, type OnCall } from "../_shared/types";
import { assertAdDay, toCount, type AdDayRow, type MetaAdsClient } from "./types";

export const META_GRAPH_API = "https://graph.facebook.com/v21.0";
const OPERATION = "insights.get";
const LEAD_ACTIONS = ["lead", "onsite_conversion.lead_grouped", "offsite_conversion.fb_pixel_lead"] as const;

const InsightRow = z.object({
  campaign_id: z.string().min(1),
  campaign_name: z.string().default(""),
  spend: z.union([z.string(), z.number()]).optional(),
  impressions: z.union([z.string(), z.number()]).optional(),
  clicks: z.union([z.string(), z.number()]).optional(),
  account_currency: z.string().optional(),
  actions: z.array(z.object({ action_type: z.string(), value: z.union([z.string(), z.number()]) })).optional(),
});
const InsightsPage = z.object({ data: z.array(InsightRow).default([]), paging: z.object({ next: z.string().optional() }).optional() });

export type MetaAdsClientOptions = { accessToken: string; onCall?: OnCall; fetch?: FetchLike; timeoutMs?: number; baseUrl?: string };

/** A decimal amount (`"12.34"`) in cents, rounded half up. */
export function amountToCents(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
}

/** The lead count of one insights row: the first lead action type present. */
export function metaLeads(actions: readonly { action_type: string; value: string | number }[] | undefined): number {
  for (const type of LEAD_ACTIONS) {
    const a = actions?.find((x) => x.action_type === type);
    if (a) return toCount(a.value);
  }
  return 0;
}

export function mapMetaInsight(row: z.infer<typeof InsightRow>): AdDayRow {
  return {
    campaignId: row.campaign_id,
    campaignName: row.campaign_name || row.campaign_id,
    spendCents: amountToCents(row.spend),
    impressions: toCount(row.impressions),
    clicks: toCount(row.clicks),
    leads: metaLeads(row.actions),
    ...(row.account_currency ? { currency: row.account_currency.toUpperCase() } : {}),
  };
}

export function createMetaAdsClient(options: MetaAdsClientOptions): MetaAdsClient {
  const onCall = options.onCall ?? noopOnCall;
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? 20_000;
  const base = options.baseUrl ?? META_GRAPH_API;

  async function page(url: string, path: string, day: string): Promise<z.infer<typeof InsightsPage>> {
    return trackCall(onCall, { provider: "meta_ads", operation: OPERATION, requestDigest: digestRequest({ method: "GET", path, params: { day, level: "campaign" } }) }, () =>
      withTimeout(
        async (signal) => {
          const res = await doFetch(url, { method: "GET", headers: { authorization: `Bearer ${options.accessToken}` }, signal });
          if (!res.ok) throw errorFromStatus("meta_ads", OPERATION, res.status, await res.text().catch(() => ""));
          const parsed = InsightsPage.safeParse(await res.json().catch(() => null));
          if (!parsed.success) throw new IntegrationError({ provider: "meta_ads", operation: OPERATION, retryable: false, code: "invalid_response", statusCode: res.status, message: "meta_ads insights.get: unexpected response" });
          return { value: parsed.data, statusCode: res.status };
        },
        timeoutMs,
        { provider: "meta_ads", operation: OPERATION },
      ),
    );
  }

  return {
    async getCampaignInsights({ accountId, day }) {
      assertAdDay(day);
      const act = accountId.startsWith("act_") ? accountId : `act_${accountId}`;
      const path = `/${encodeURIComponent(act)}/insights`;
      const query = new URLSearchParams({
        level: "campaign",
        fields: "campaign_id,campaign_name,spend,impressions,clicks,actions,account_currency",
        time_range: JSON.stringify({ since: day, until: day }),
        limit: "500",
      });
      let url: string | undefined = `${base}${path}?${query.toString()}`;
      const out: AdDayRow[] = [];
      for (let n = 0; url && n < 20; n++) {
        const body = await page(url, path, day);
        out.push(...body.data.map(mapMetaInsight));
        url = body.paging?.next;
      }
      return out;
    },
  };
}
