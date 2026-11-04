import type { MetadataRoute } from "next";
import { cookies, headers } from "next/headers";
import { DEFAULT_LOCALE, isLocale, localeFromAcceptLanguage, localeFromSegment, type Locale } from "@beam/core/i18n";
import { translator } from "@/lib/i18n";
import { reportError } from "@/lib/logger";
import { getPublicSettings } from "@/modules/site/queries";

/**
 * The PWA manifest (site spec section 5, site-P5). `name` is `settings.company.trade_name`,
 * `lang` and `description` follow the request locale (the `NEXT_LOCALE` cookie, then
 * `Accept-Language`, then nl-BE), colours are the light `packages/ui` tokens (`--background`
 * and `--primary` in sRGB hex). The icons are served by `app/pwa-icon/[size]` with a file
 * extension so the locale proxy leaves them alone.
 */
export const dynamic = "force-dynamic";

/** `oklch(0.99 0.004 95)` and `oklch(0.45 0.09 165)` of `@beam/config/tailwind-theme.css`. */
export const PWA_BACKGROUND = "#fcfcf9";
export const PWA_THEME = "#0e6549";

async function requestLocale(): Promise<Locale> {
  try {
    const c = (await cookies()).get("NEXT_LOCALE")?.value;
    if (c) {
      const fromCookie = isLocale(c) ? c : localeFromSegment(c);
      if (fromCookie) return fromCookie;
    }
    return localeFromAcceptLanguage((await headers()).get("accept-language")) ?? DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const locale = await requestLocale();
  let name = "BEAM Vitality Center";
  try {
    const { company } = await getPublicSettings();
    const trade = (company as { trade_name?: unknown }).trade_name;
    if (typeof trade === "string" && trade.trim()) name = trade.trim();
  } catch (error) {
    reportError(error, { tags: { module: "site", step: "manifest" } });
  }
  return {
    id: "/",
    name,
    short_name: "BEAM",
    lang: locale,
    description: translator(locale)("site.portal.install.body"),
    start_url: "/account?source=pwa",
    scope: "/",
    display: "standalone",
    background_color: PWA_BACKGROUND,
    theme_color: PWA_THEME,
    icons: [
      { src: "/pwa-icon/192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/pwa-icon/512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/pwa-icon/512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
