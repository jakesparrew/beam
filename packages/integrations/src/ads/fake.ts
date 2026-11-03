/**
 * The Meta and Google Ads fakes (runbook section 1.5, ops spec section 6): deterministic daily
 * rows for three fake campaigns per platform, seeded by account and date, so dashboards have
 * data. Read-only; can be told to fail. ops-P8 writes the real `meta.ts` and `google.ts`.
 */
import { createHash } from "node:crypto";
import { digestRequest } from "../_shared/digest";
import { IntegrationError } from "../_shared/errors";
import { trackCall } from "../_shared/timeout";
import { noopOnCall, type FakeCall, type OnCall } from "../_shared/types";

export type AdDayRow = { campaignId: string; campaignName: string; spendCents: number; impressions: number; clicks: number; leads: number };

export interface MetaAdsClient {
  getCampaignInsights(input: { accountId: string; day: string }): Promise<AdDayRow[]>;
}

export interface GoogleAdsClient {
  getCampaignStats(input: { customerId: string; day: string }): Promise<AdDayRow[]>;
}

export type AdsPlatform = "meta" | "google";

export const FAKE_CAMPAIGNS: Readonly<Record<AdsPlatform, readonly { id: string; name: string }[]>> = {
  meta: [
    { id: "fake_meta_1", name: "Meta - Intro week" },
    { id: "fake_meta_2", name: "Meta - Membership autumn" },
    { id: "fake_meta_3", name: "Meta - Webinar sign-up" },
  ],
  google: [
    { id: "fake_google_1", name: "Google - Brand" },
    { id: "fake_google_2", name: "Google - Personal training Leuven" },
    { id: "fake_google_3", name: "Google - Gift vouchers" },
  ],
};

/** A stable number in [0, 1) from the inputs. */
function unit(...parts: string[]): number {
  const h = createHash("sha256").update(parts.join("|")).digest();
  return h.readUInt32BE(0) / 0x1_0000_0000;
}

/** The deterministic rows for one platform, account and day. */
export function fakeAdRows(platform: AdsPlatform, accountId: string, day: string): AdDayRow[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new RangeError(`day must be YYYY-MM-DD, got ${day}`);
  return FAKE_CAMPAIGNS[platform].map((c, i) => {
    const r = unit(platform, accountId, day, c.id);
    const impressions = 800 + Math.floor(r * 4200) + i * 300;
    const clicks = Math.max(1, Math.floor(impressions * (0.008 + unit(c.id, day, "ctr") * 0.02)));
    const leads = Math.floor(clicks * (0.03 + unit(c.id, day, "cvr") * 0.07));
    const spendCents = 1500 + Math.floor(unit(c.id, day, "spend") * 6000) + i * 500;
    return { campaignId: c.id, campaignName: c.name, spendCents, impressions, clicks, leads };
  });
}

export type AdsFake = {
  meta: MetaAdsClient;
  google: GoogleAdsClient;
  readonly calls: FakeCall[];
  failNext(platform: AdsPlatform, opts?: { retryable?: boolean; status?: number }): void;
  reset(): void;
};

export function createAdsFake(options: { onCall?: OnCall; now?: () => Date } = {}): AdsFake {
  const onCall = options.onCall ?? noopOnCall;
  const now = options.now ?? (() => new Date());
  const calls: FakeCall[] = [];
  const failures: { platform: AdsPlatform; retryable: boolean; status: number }[] = [];

  function run(platform: AdsPlatform, operation: string, account: string, day: string): Promise<AdDayRow[]> {
    calls.push({ operation, input: { account, day }, at: now() });
    const provider = platform === "meta" ? "meta_ads" : "google_ads";
    return trackCall(onCall, { provider, operation, requestDigest: digestRequest({ method: "GET", path: `/${platform}/insights`, params: { day } }) }, () => {
      const i = failures.findIndex((f) => f.platform === platform);
      if (i >= 0) {
        const [f] = failures.splice(i, 1);
        throw new IntegrationError({ provider, operation, retryable: f!.retryable, statusCode: f!.status, message: `${provider} ${operation} failed with ${f!.status}` });
      }
      return { value: fakeAdRows(platform, account, day), statusCode: 200 };
    });
  }

  return {
    calls,
    meta: { getCampaignInsights: ({ accountId, day }) => run("meta", "insights.get", accountId, day) },
    google: { getCampaignStats: ({ customerId, day }) => run("google", "campaign_stats.get", customerId, day) },
    failNext(platform, opts) {
      const retryable = opts?.retryable ?? true;
      failures.push({ platform, retryable, status: opts?.status ?? (retryable ? 503 : 401) });
    },
    reset() {
      calls.length = 0;
      failures.length = 0;
    },
  };
}
