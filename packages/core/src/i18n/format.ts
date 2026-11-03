/**
 * Locale formatters (PL-66): every date, time and amount goes through `Intl` with the
 * locale and `Europe/Brussels`. Money is integer cents formatted as EUR.
 */
import { TIME_ZONE, type Locale } from "./locales";

export type DateStyle = "short" | "medium" | "long" | "full";

const cache = new Map<string, Intl.NumberFormat | Intl.DateTimeFormat>();

function numberFormat(locale: Locale, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const id = `n|${locale}|${JSON.stringify(options)}`;
  let f = cache.get(id) as Intl.NumberFormat | undefined;
  if (!f) {
    f = new Intl.NumberFormat(locale, options);
    cache.set(id, f);
  }
  return f;
}

function dateFormat(locale: Locale, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const id = `d|${locale}|${JSON.stringify(options)}`;
  let f = cache.get(id) as Intl.DateTimeFormat | undefined;
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { timeZone: TIME_ZONE, ...options });
    cache.set(id, f);
  }
  return f;
}

/** `formatMoney(12345, 'nl-BE')` -> `€ 123,45`. */
export function formatMoney(cents: number, locale: Locale, options: { hideZeroDecimals?: boolean } = {}): string {
  if (!Number.isInteger(cents)) throw new TypeError(`formatMoney expects integer cents, got ${cents}`);
  const whole = options.hideZeroDecimals && cents % 100 === 0;
  return numberFormat(locale, {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  }).format(cents / 100);
}

export function formatNumber(value: number, locale: Locale, options: Intl.NumberFormatOptions = {}): string {
  return numberFormat(locale, options).format(value);
}

/** A percentage given as a number (`99.5` -> `99,5 %` in nl-BE). */
export function formatPercent(value: number, locale: Locale, fractionDigits = 1): string {
  return numberFormat(locale, {
    style: "percent",
    minimumFractionDigits: 0,
    maximumFractionDigits: fractionDigits,
  }).format(value / 100);
}

/** A calendar date in Brussels. Accepts a `Date` or an ISO date string `YYYY-MM-DD` (read as that day). */
export function formatDate(date: Date | string, locale: Locale, style: DateStyle = "medium"): string {
  if (typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    // A plain date has no time zone: format it as that calendar day.
    const [y, m, d] = date.split("-").map(Number) as [number, number, number];
    return new Intl.DateTimeFormat(locale, { timeZone: "UTC", dateStyle: style }).format(new Date(Date.UTC(y, m - 1, d, 12)));
  }
  return dateFormat(locale, { dateStyle: style }).format(toDate(date));
}

export function formatTime(date: Date | string, locale: Locale): string {
  return dateFormat(locale, { timeStyle: "short" }).format(toDate(date));
}

export function formatDateTime(date: Date | string, locale: Locale, style: DateStyle = "medium"): string {
  return dateFormat(locale, { dateStyle: style, timeStyle: "short" }).format(toDate(date));
}

function toDate(value: Date | string): Date {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new TypeError(`invalid date: ${String(value)}`);
  return d;
}
