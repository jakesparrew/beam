/**
 * The read-only ads interfaces (ops spec section 6, rule 74). One row per campaign and day;
 * `spendCents` is integer euro cents. `currency` is the account currency the platform reported
 * (ISO 4217, upper case); ops refuses an account that is not `EUR` (edge case 18). The fakes
 * leave it out, which means `EUR`.
 */
export type AdDayRow = {
  campaignId: string;
  campaignName: string;
  spendCents: number;
  impressions: number;
  clicks: number;
  leads: number;
  currency?: string;
};

export interface MetaAdsClient {
  getCampaignInsights(input: { accountId: string; day: string }): Promise<AdDayRow[]>;
}

export interface GoogleAdsClient {
  getCampaignStats(input: { customerId: string; day: string }): Promise<AdDayRow[]>;
}

export type AdsPlatform = "meta" | "google";

export const ADS_PLATFORMS: readonly AdsPlatform[] = ["meta", "google"];

/** The clients ops pulls from. */
export type AdsClients = { meta: MetaAdsClient; google: GoogleAdsClient };

/** `YYYY-MM-DD`, the only day format the clients accept. */
export const AD_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function assertAdDay(day: string): void {
  if (!AD_DAY.test(day)) throw new RangeError(`day must be YYYY-MM-DD, got ${day}`);
}

/** A non-negative integer from a provider value (`"12"`, `12`, `12.0`); anything else is 0. */
export function toCount(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}
