/**
 * site types named in the cross-module contract (02-data-model section 6.11). Wave 0 skeleton
 * by platform-P7; site owns this file from site-P1 on.
 */
import { z } from "zod";

export type LegalKey = "privacy_notice" | "terms" | "cookie_notice" | "accessibility_statement" | "guardian_consent";
export type TermsContext = "checkout" | "signup" | "booking" | "portal_prompt" | "pos" | "import";
export type PortalRoute =
  | "home"
  | "book_day"
  | "book_night"
  | "bookings"
  | "waitlist"
  | "shop"
  | "packages"
  | "membership"
  | "invoices"
  | "preferences"
  | "profile";

const https = z.string().url().startsWith("https://");

/** `settings.site` (02-data-model 6.11), snake_case like every setting value. */
export const SiteSettings = z.object({
  canonical_origin: z.string().url(),
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
