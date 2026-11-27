/**
 * Grant display helpers (credits spec section 5): the grant's name, a units text and the badge
 * variant of a grant status. The grants table itself is `/admin/credits` (owner review, November
 * 2026, in the back-office kit). Server code: strings come from the catalogue through `translator`.
 */
import { formatMoney, type Locale, type LocalizedText } from "@beam/core/i18n";
import { translator } from "@/lib/i18n";

export function grantName(row: { productName: LocalizedText | null; label: LocalizedText | null; source: string }, locale: Locale, fallback: string): string {
  return row.productName?.[locale]?.trim() || row.label?.[locale]?.trim() || fallback;
}

/** "4 sessions", "2 nights" or "€ 35,00" in the page locale. */
export function unitsText(kind: string, units: number, locale: Locale): string {
  const tr = translator(locale);
  return kind === "euro" ? formatMoney(units, locale) : tr(`credits.admin.units.${kind}`, { count: units });
}

export const statusVariant = (status: string): "success" | "secondary" | "warning" | "destructive" | "outline" =>
  status === "active" ? "success" : status === "exhausted" ? "secondary" : status === "expired" ? "warning" : status === "revoked" ? "destructive" : "outline";
