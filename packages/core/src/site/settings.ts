/**
 * `settings.site` (site spec section 4, 02-data-model 6.11), snake_case like every setting value.
 * Written only through platform's `updateSetting` on `/admin/settings/site`; trade name and legal
 * identity come from `settings.company`, never from `site`.
 */
import { z } from "zod";

const https = z.string().url().startsWith("https://");

export const SiteSettings = z.object({
  canonical_origin: z.string().url().startsWith("https://"),
  analytics_enabled: z.boolean(),
  ga_measurement_id: z.string().regex(/^G-[A-Z0-9]{4,12}$/).nullable(),
  default_og_image_media_id: z.string().uuid().nullable(),
  social_links: z.object({ instagram: https.optional(), facebook: https.optional(), linkedin: https.optional(), youtube: https.optional() }),
  brand_voice: z.string().max(4000),
  google_ads_conversion_id: z.string().regex(/^AW-[0-9]{6,12}$/).nullable(),
  meta_pixel_id: z.string().regex(/^[0-9]{10,20}$/).nullable(),
});
export type SiteSettings = z.infer<typeof SiteSettings>;

export const DEFAULT_SITE_SETTINGS: SiteSettings = {
  canonical_origin: "https://www.beam.be",
  analytics_enabled: false,
  ga_measurement_id: null,
  default_og_image_media_id: null,
  social_links: {},
  brand_voice: "",
  google_ads_conversion_id: null,
  meta_pixel_id: null,
};

/** Parses a stored value over the defaults; an invalid value yields the defaults. */
export function parseSiteSettings(value: unknown): SiteSettings {
  const stored = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const parsed = SiteSettings.safeParse({ ...DEFAULT_SITE_SETTINGS, ...stored });
  return parsed.success ? parsed.data : DEFAULT_SITE_SETTINGS;
}
