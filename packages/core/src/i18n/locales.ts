/** The three locales of the platform. No fallback language exists (architecture section 5). */
export const LOCALES = ["nl-BE", "fr-BE", "en"] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "nl-BE";

/** The catalogue every other catalogue is checked against (PL-62). */
export const SOURCE_LOCALE: Locale = "en";

/** The URL prefix of each locale on the site and portal (`/nl`, `/fr`, `/en`). */
export const URL_SEGMENT: Readonly<Record<Locale, string>> = { "nl-BE": "nl", "fr-BE": "fr", en: "en" };

export type UrlSegment = "nl" | "fr" | "en";

/** The time zone all business logic runs in. */
export const TIME_ZONE = "Europe/Brussels";

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** `nl` -> `nl-BE`; anything unknown -> `null`. */
export function localeFromSegment(segment: string | null | undefined): Locale | null {
  for (const locale of LOCALES) if (URL_SEGMENT[locale] === segment) return locale;
  return null;
}

/**
 * Best match for an `Accept-Language` header (PL-65 step 3), or `null` when nothing matches.
 * `nl`, `nl-NL` and `nl-BE` all map to `nl-BE`; `fr*` to `fr-BE`; `en*` to `en`.
 */
export function localeFromAcceptLanguage(header: string | null | undefined): Locale | null {
  if (!header) return null;
  const ranked = header
    .split(",")
    .map((part, index) => {
      const [tag = "", ...params] = part.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      const weight = q ? Number.parseFloat(q.slice(2)) : 1;
      return { tag: tag.toLowerCase(), weight: Number.isFinite(weight) ? weight : 0, index };
    })
    .filter((entry) => entry.tag && entry.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.index - b.index);
  for (const { tag } of ranked) {
    const primary = tag.split("-")[0];
    const match = LOCALES.find((l) => l.toLowerCase() === tag) ?? LOCALES.find((l) => l.split("-")[0] === primary);
    if (match) return match;
  }
  return null;
}
