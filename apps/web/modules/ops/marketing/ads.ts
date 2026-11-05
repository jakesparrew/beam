/**
 * The Meta and Google Ads spend import (ops rule 74, spec section 6, R3). Read-only: BEAM never
 * creates or edits ads. `ads.pull_yesterday` (05:30 Brussels) enqueues one pull per configured
 * account and day for yesterday and the 3 days before it (late conversions); each pull upserts
 * `ad_spend_daily` on `(platform, campaign_external_id, day_on)`, so a re-pull replaces the
 * figures of the same day. The per-day key carries the run date
 * (`ads:<platform>:<accountId>:<day>:run:<runOn>`), so tomorrow's re-pull of a day is a new job.
 *
 * Failures: a retryable `IntegrationError` (429, 5xx, network) retries with the job backoff; a
 * 401 or 403 (token expired or revoked) and every other permanent provider error become a
 * `PermanentError`, and an account whose currency is not EUR is refused with "account currency
 * must be EUR" and writes nothing (edge case 18). The ads clients are built here with the
 * runbook 1.5 rule (`integrationMode`), not through `getIntegrations()`; tests install fakes with
 * `setAdsClients`.
 */
import type { DbOrTx } from "@beam/db";
import { adSpendDaily, featureFlags } from "@beam/db/schema";
import { PermanentError } from "@beam/core/errors";
import { ADS_SETTINGS_DEFAULT, type AdsSettings } from "@beam/core/ops";
import { localDateKey, wallClock } from "@beam/core/platform";
import { createAdsClients, type AdDayRow, type AdsClients, type AdsPlatform } from "@beam/integrations/ads";
import { IntegrationError } from "@beam/integrations/_shared";
import { eq, sql, type Ctx } from "@/lib/ctx";
import { integrationMode, routedOnCall } from "@/lib/integrations";
import { rowsOf } from "@/lib/sensitive";
import { getSetting } from "@/lib/settings";

export const MARKETING_FLAG = "ff_ops_marketing";
/** Rule 74: yesterday and the 3 days before it. */
export const ADS_REPULL_DAYS = 3;
/** Rule 74: the digest alerts after this many consecutive days without a successful pull. */
export const ADS_STALE_DAYS = 3;
export const ADS_BACKFILL_MAX_DAYS = 90;

// ---------------------------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------------------------

const cache = globalThis as unknown as { __beamAdsClients?: AdsClients };

/** The ads clients of this process (fake or real per platform, runbook 1.5). */
export function getAdsClients(): AdsClients {
  cache.__beamAdsClients ??= createAdsClients({ env: process.env, mode: (p, k) => integrationMode(p, k), onCall: routedOnCall });
  return cache.__beamAdsClients;
}

/** Tests install a set (for example `createAdsFake()`); `undefined` resets. */
export function setAdsClients(clients: AdsClients | undefined): void {
  cache.__beamAdsClients = clients;
}

// ---------------------------------------------------------------------------------------------
// Dates (Brussels calendar days, `YYYY-MM-DD`)
// ---------------------------------------------------------------------------------------------

export const brusselsDay = (d: Date): string => localDateKey(wallClock(d));

/** Calendar arithmetic on a `YYYY-MM-DD` date. */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

/** Every day from `from` to `to`, both included (at most `max`). */
export function daysBetween(from: string, to: string, max = ADS_BACKFILL_MAX_DAYS): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < max; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Rule 74: the days a run on `runOn` pulls: yesterday first, then the 3 days before. */
export function daysToPull(runOn: string): string[] {
  return Array.from({ length: ADS_REPULL_DAYS + 1 }, (_, i) => addDays(runOn, -(i + 1)));
}

export const pullJobKey = (platform: AdsPlatform, accountId: string, day: string, runOn: string) => `ads:${platform}:${accountId}:${day}:run:${runOn}`;
export const backfillJobKey = (platform: AdsPlatform, accountId: string, from: string, to: string) => `ads:backfill:${platform}:${accountId}:${from}:${to}`;

// ---------------------------------------------------------------------------------------------
// Settings and flag
// ---------------------------------------------------------------------------------------------

/** True unless `ff_ops_marketing` is `off` or has no row (jobs run as the system actor). */
export async function marketingEnabled(db: DbOrTx): Promise<boolean> {
  const [row] = await db.select({ state: featureFlags.state }).from(featureFlags).where(eq(featureFlags.key, MARKETING_FLAG)).limit(1);
  return !!row && row.state !== "off";
}

export async function readAdsSettings(db: DbOrTx): Promise<AdsSettings> {
  try {
    return await getSetting(db, "ads");
  } catch {
    return ADS_SETTINGS_DEFAULT;
  }
}

/** Every configured account, Meta first. */
export function configuredAccounts(settings: AdsSettings): { platform: AdsPlatform; accountId: string }[] {
  return [
    ...[...new Set(settings.meta_account_ids)].filter(Boolean).map((accountId) => ({ platform: "meta" as const, accountId })),
    ...[...new Set(settings.google_customer_ids)].filter(Boolean).map((accountId) => ({ platform: "google" as const, accountId })),
  ];
}

// ---------------------------------------------------------------------------------------------
// One pull
// ---------------------------------------------------------------------------------------------

/** The provider call; permanent provider failures become a `PermanentError` (401 and 403 included). */
async function fetchRows(clients: AdsClients, platform: AdsPlatform, accountId: string, day: string): Promise<AdDayRow[]> {
  try {
    return platform === "meta" ? await clients.meta.getCampaignInsights({ accountId, day }) : await clients.google.getCampaignStats({ customerId: accountId, day });
  } catch (error) {
    if (error instanceof IntegrationError && !error.retryable) {
      const reason = error.statusCode === 401 || error.statusCode === 403 ? "ads_token_rejected" : (error.code ?? "ads_permanent_failure");
      throw new PermanentError(`${reason}: ${platform} ${accountId} (${error.statusCode ?? "-"})`);
    }
    throw error;
  }
}

/**
 * Pulls one account and day and upserts its rows (rule 74). Refuses a non-EUR account before
 * writing anything (edge case 18). Returns the number of campaign rows written.
 */
export async function pullAdsDay(
  db: DbOrTx,
  input: { platform: AdsPlatform; accountId: string; day: string; now: Date; clients?: AdsClients },
): Promise<{ rows: number }> {
  const clients = input.clients ?? getAdsClients();
  const rows = await fetchRows(clients, input.platform, input.accountId, input.day);
  const foreign = rows.find((r) => r.currency && r.currency.toUpperCase() !== "EUR");
  if (foreign) throw new PermanentError(`account currency must be EUR: ${input.platform} ${input.accountId} reports ${foreign.currency}`);
  if (!rows.length) return { rows: 0 };
  const values = rows.map((r) => ({
    platform: input.platform,
    accountId: input.accountId,
    campaignExternalId: r.campaignId,
    campaignName: r.campaignName.slice(0, 300),
    dayOn: input.day,
    spendCents: Math.max(0, Math.round(r.spendCents)),
    impressions: Math.max(0, Math.round(r.impressions)),
    clicks: Math.max(0, Math.round(r.clicks)),
    leads: Math.max(0, Math.round(r.leads)),
    currency: "EUR",
    raw: { campaignId: r.campaignId, spendCents: r.spendCents, impressions: r.impressions, clicks: r.clicks, leads: r.leads, currency: r.currency ?? "EUR" },
    pulledAt: input.now,
  }));
  await db
    .insert(adSpendDaily)
    .values(values)
    .onConflictDoUpdate({
      target: [adSpendDaily.platform, adSpendDaily.campaignExternalId, adSpendDaily.dayOn],
      set: {
        accountId: sql`excluded.account_id`,
        campaignName: sql`excluded.campaign_name`,
        spendCents: sql`excluded.spend_cents`,
        impressions: sql`excluded.impressions`,
        clicks: sql`excluded.clicks`,
        leads: sql`excluded.leads`,
        raw: sql`excluded.raw`,
        pulledAt: sql`excluded.pulled_at`,
        updatedAt: sql`now()`,
      },
    });
  return { rows: values.length };
}

/** Enqueues the per-day pulls of `days` for one account; returns the job ids. */
export async function enqueueDayPulls(ctx: Pick<Ctx, "enqueue">, input: { platform: AdsPlatform; accountId: string; days: string[]; runOn: string }): Promise<string[]> {
  const ids: string[] = [];
  for (const day of input.days) {
    const { id } = await ctx.enqueue({
      kind: "ads.pull_yesterday",
      payload: { platform: input.platform, accountId: input.accountId, day, runOn: input.runOn },
      key: pullJobKey(input.platform, input.accountId, day, input.runOn),
    });
    ids.push(id);
  }
  return ids;
}

/**
 * "Pull now" (`pullAdsNow`): one `ads.backfill` per configured account over the `days` days up
 * to yesterday. Returns the job ids (empty when no account is configured).
 */
export async function requestAdsPull(ctx: Pick<Ctx, "tx" | "enqueue" | "now">, input: { days: number }): Promise<{ jobIds: string[]; from: string; to: string }> {
  const today = brusselsDay(ctx.now);
  const to = addDays(today, -1);
  const from = addDays(today, -Math.min(ADS_BACKFILL_MAX_DAYS, Math.max(1, input.days)));
  const jobIds: string[] = [];
  for (const a of configuredAccounts(await readAdsSettings(ctx.tx))) {
    const { id } = await ctx.enqueue({ kind: "ads.backfill", payload: { platform: a.platform, accountId: a.accountId, from, to }, key: backfillJobKey(a.platform, a.accountId, from, to) });
    jobIds.push(id);
  }
  return { jobIds, from, to };
}

// ---------------------------------------------------------------------------------------------
// Status (the ads report, the "data as of" line and the digest)
// ---------------------------------------------------------------------------------------------

export type AdsAccountStatus = { platform: AdsPlatform; accountId: string; lastPulledAt: Date | null; lastDay: string | null; configured: boolean };

/** The last pull per account (configured accounts first, then accounts that only have rows). */
export async function getAdsAccountStatus(db: DbOrTx): Promise<AdsAccountStatus[]> {
  const settings = await readAdsSettings(db);
  const rows = rowsOf<{ platform: AdsPlatform; account_id: string; last_pulled_at: string | Date | null; last_day: string | null }>(
    await db.execute(sql`select platform::text as platform, account_id, max(pulled_at) as last_pulled_at, max(day_on)::text as last_day from ad_spend_daily group by platform, account_id`),
  );
  const byKey = new Map(rows.map((r) => [`${r.platform}:${r.account_id}`, r]));
  const out: AdsAccountStatus[] = configuredAccounts(settings).map((a) => {
    const r = byKey.get(`${a.platform}:${a.accountId}`);
    byKey.delete(`${a.platform}:${a.accountId}`);
    return { ...a, lastPulledAt: r?.last_pulled_at ? new Date(r.last_pulled_at) : null, lastDay: r?.last_day ?? null, configured: true };
  });
  for (const r of byKey.values()) out.push({ platform: r.platform, accountId: r.account_id, lastPulledAt: r.last_pulled_at ? new Date(r.last_pulled_at) : null, lastDay: r.last_day, configured: false });
  return out;
}

/** "Data as of <date>" (rule 74): the latest `day_on` in `ad_spend_daily`, null without rows. */
export async function adsDataAsOf(db: DbOrTx): Promise<string | null> {
  const [row] = rowsOf<{ d: string | null }>(await db.execute(sql`select max(day_on)::text as d from ad_spend_daily`));
  return row?.d ?? null;
}

/**
 * Rule 74 (for the daily digest): the configured accounts whose last successful pull is
 * `ADS_STALE_DAYS` or more Brussels days old (or that never pulled), with the age in days.
 */
export async function getStaleAdsAccounts(db: DbOrTx, now: Date): Promise<{ platform: AdsPlatform; accountId: string; daysSincePull: number | null }[]> {
  const today = brusselsDay(now);
  const out: { platform: AdsPlatform; accountId: string; daysSincePull: number | null }[] = [];
  for (const a of await getAdsAccountStatus(db)) {
    if (!a.configured) continue;
    if (!a.lastPulledAt) {
      out.push({ platform: a.platform, accountId: a.accountId, daysSincePull: null });
      continue;
    }
    const pulled = brusselsDay(a.lastPulledAt);
    const age = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${pulled}T00:00:00Z`)) / 86_400_000);
    if (age >= ADS_STALE_DAYS) out.push({ platform: a.platform, accountId: a.accountId, daysSincePull: age });
  }
  return out;
}
