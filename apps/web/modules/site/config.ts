/**
 * site settings (site spec section 4, 02-data-model 5.4 and 6.11). Facade read by
 * `pnpm gen:indexes`. Settings key `site` with the `SiteSettings` schema and defaults from
 * `@beam/core/site`; edited at platform's `/admin/settings/site` (`settings.write`). Trade name and
 * legal identity come from platform's `company`, never from `site`. Site has no feature flags in V1.
 */
import { DEFAULT_SITE_SETTINGS, SiteSettings } from "@beam/core/site";
import { defineSetting } from "@/lib/settings";

export const settings = [
  defineSetting({
    key: "site",
    schema: SiteSettings,
    default: DEFAULT_SITE_SETTINGS,
    description: "Canonical origin, analytics, social links, brand voice and the R3 ad tags",
  }),
] as const;

export const flags = [] as const;
