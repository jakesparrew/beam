/**
 * `settings.site` reader (site spec section 4). Stub by site-P1 with the final signature;
 * site-P3 implements it through platform's `getSetting(db, 'site')` and `parseSiteSettings`.
 */
import type { DbOrTx } from "@beam/db";
import { NotImplementedError } from "@beam/core/errors";
import type { SiteSettings } from "@beam/core/site";

export function getSiteSettings(_db: DbOrTx): Promise<SiteSettings> {
  return Promise.reject(new NotImplementedError("site.getSiteSettings"));
}
