/**
 * Helpers of the finance dashboard screen (finance-P8): labels for categories and payment methods,
 * the change against the previous period, and the CSV of each table as a `data:` link (the same
 * accountant format as the exports: `;`, UTF-8 with a BOM, euros with a dot, ISO dates).
 */
import { centsToEuros, toCsv, type CsvCell } from "@beam/core/finance";
import { formatDate, type Locale } from "@beam/core/i18n";

/** Fills `{param}` placeholders of a dashboard label (`dashboard.<key>`). */
export type DashboardLabel = (key: string, params?: Record<string, string | number>) => string;

export function categoryLabel(labels: Record<string, string>, category: string): string {
  return labels[`dashboard.category_${category}`] ?? category;
}

export function methodLabel(labels: Record<string, string>, method: string): string {
  return labels[`dashboard.method_${method}`] ?? method;
}

/** The change of `current` against `previous`; the percentage is null when `previous` is 0. */
export function changeOf(current: number, previous: number): { change: number; changePct: number | null } {
  const change = current - previous;
  return { change, changePct: previous === 0 ? null : (change / Math.abs(previous)) * 100 };
}

/** A calendar date or the month of a bucket (`YYYY-MM-01`) in the staff user's locale. */
export function bucketLabel(bucket: string, granularity: "day" | "month", locale: Locale): string {
  if (granularity === "day") return formatDate(bucket, locale, "short");
  const [y, m] = bucket.split("-").map(Number) as [number, number];
  return new Intl.DateTimeFormat(locale, { timeZone: "UTC", month: "short", year: "numeric" }).format(new Date(Date.UTC(y, m - 1, 15)));
}

/** A CSV money cell (euros with a dot and two decimals). */
export const euros = (cents: number): string => centsToEuros(cents);

/** A `data:` URL of a CSV file with `header` and `rows`. */
export function csvHref(header: string[], rows: CsvCell[][]): string {
  return `data:text/csv;charset=utf-8,${encodeURIComponent(toCsv(header, rows))}`;
}
