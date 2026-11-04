/**
 * `settings.site` reader (site spec section 4; site-P3). Reads through platform's
 * `getSetting(db, 'site')` with the caller's db or transaction (OD-15: a job or action passes its
 * tx, so a single-connection database never waits on itself) and parses it over the defaults with
 * `parseSiteSettings`. Also reads `settings.company` and `settings.business_hours` for the admin
 * summary and the go-live issues (rules 59-60).
 */
import type { DbOrTx } from "@beam/db";
import {
  companyFooter,
  missingCompanyIdentification,
  parseSiteSettings,
  type CompanyFooter,
  type CompanySetting,
  type SiteSettings,
} from "@beam/core/site";
import { getSetting } from "@/lib/settings";

export async function getSiteSettings(db: DbOrTx): Promise<SiteSettings> {
  return parseSiteSettings(await getSetting(db, "site"));
}

/** `settings.company` as stored (its declared default when no row exists). */
export async function getCompanySetting(db: DbOrTx): Promise<CompanySetting> {
  return ((await getSetting(db, "company")) ?? {}) as CompanySetting;
}

type HoursDay = { opens_at?: string | null; closes_at?: string | null } | null | undefined;

/** True when `settings.business_hours` has at least one open weekday (rule 59). */
export async function hasOpeningHours(db: DbOrTx): Promise<boolean> {
  const raw = (await getSetting(db, "business_hours")) as { week?: Record<string, HoursDay> } | null;
  return Object.values(raw?.week ?? {}).some((d) => !!d?.opens_at && !!d?.closes_at);
}

export type SiteSettingsSummary = {
  site: SiteSettings;
  company: CompanyFooter;
  missingCompany: ReturnType<typeof missingCompanyIdentification>;
};

/** The read-only `/admin/site/settings` summary. */
export async function getSiteSettingsSummary(db: DbOrTx): Promise<SiteSettingsSummary> {
  const [site, company] = await Promise.all([getSiteSettings(db), getCompanySetting(db)]);
  return { site, company: companyFooter(company), missingCompany: missingCompanyIdentification(company) };
}
