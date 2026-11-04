/**
 * Locale prefixes of the public site (rule 1): `/nl` = `nl-BE`, `/fr` = `fr-BE`, `/en` = `en`.
 */
import { LOCALES, URL_SEGMENT, type Locale, type UrlSegment } from "../i18n";

export type SitePrefix = UrlSegment;
export const SITE_PREFIXES: readonly SitePrefix[] = LOCALES.map((l) => URL_SEGMENT[l] as SitePrefix);

export function localeFromPrefix(prefix: SitePrefix): Locale {
  const locale = LOCALES.find((l) => URL_SEGMENT[l] === prefix);
  if (!locale) throw new Error(`unknown site prefix "${String(prefix)}"`);
  return locale;
}

export function prefixFromLocale(locale: Locale): SitePrefix {
  return URL_SEGMENT[locale] as SitePrefix;
}

export function isSitePrefix(value: unknown): value is SitePrefix {
  return typeof value === "string" && (SITE_PREFIXES as readonly string[]).includes(value);
}

/** `/<prefix>` or `/<prefix>/<path>` for a page path without leading slash (`''` is home). */
export function localePath(locale: Locale, path: string): string {
  const clean = path.replace(/^\/+/, "");
  return clean ? `/${prefixFromLocale(locale)}/${clean}` : `/${prefixFromLocale(locale)}`;
}

/** `x-default` locale for hreflang: nl-BE when live, else the first live locale. */
export function defaultHreflangLocale(locales: readonly Locale[]): Locale | null {
  if (locales.includes("nl-BE")) return "nl-BE";
  return LOCALES.find((l) => locales.includes(l)) ?? null;
}
