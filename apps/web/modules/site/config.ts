/**
 * site settings (02-data-model 5.4 and 6.11). Facade read by `pnpm gen:indexes`. Wave 0 by
 * platform-P7; site owns it from site-P1 on. Trade name and legal identity come from platform's
 * `company`, never from `site`.
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
