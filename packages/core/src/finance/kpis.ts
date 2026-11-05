/**
 * Finance KPIs for ops' R4 features (finance spec section 12, finance-P10): custom dashboards,
 * the weekly summary and NL questions read finance numbers through `getFinanceKpis(db, { from,
 * to })` (finance's api.ts) and describe them with `FINANCE_KPI_DEFINITIONS`, without reading
 * finance internals. Pure: the period arithmetic, the definitions and the assembly of a result.
 *
 * Semantics (decision 30): money is integer cents in EUR; revenue excludes VAT and vouchers;
 * credit notes reduce revenue on their own issue day. KPIs with `measure: 'period'` are sums over
 * the Brussels days `from..to`; KPIs with `measure: 'end_of_period'` are the state at the end of
 * the last day (capped at now). `previous` is the equal-length period right before (the
 * dashboard's custom-period comparison, `resolvePeriod`).
 */
import type { LocalizedText } from "../i18n/localized-text";
import { resolvePeriod, type DateRange } from "./periods";

/** One period's figures. */
export type FinanceKpiValues = {
  /** Invoice-based revenue excluding VAT and vouchers, credit notes deducted on their day. */
  netRevenueCents: number;
  /** VAT on invoices minus VAT on credit notes. */
  vatCents: number;
  /** Paid payments (not the euro credit balance) by Brussels paid day. */
  cashInCents: number;
  /** Credit notes issued in the period, net of VAT, as a positive amount (vouchers excluded). */
  refundsCents: number;
  /** Open bank-transfer invoices at the end of the period. */
  openInvoicesCount: number;
  /** What those open invoices still owe (partial credit notes deducted). */
  openInvoicesCents: number;
  /** The part of `openInvoicesCents` past its due date at the end of the period. */
  overdueCents: number;
  /** Failed and expired payments by Brussels day of the failure. */
  failedPaymentsCount: number;
  /** Memberships live at the end of the period (started, not pending, not ended). */
  activeMemberships: number;
  /** Documents of recurring (membership renewal) orders, excluding VAT. */
  recurringRevenueCents: number;
  /** Unused paid credits at the end of the period, excluding VAT (a liability). */
  deferredRevenueCents: number;
  /** Paid credits expired unused in the Brussels months the period touches, excluding VAT. */
  breakageCents: number;
};

export type FinanceKpis = FinanceKpiValues & { previous: Omit<FinanceKpis, "previous"> };

export type FinanceKpiKey = keyof FinanceKpiValues;

/** Every KPI key, in display order. */
export const FINANCE_KPI_KEYS = [
  "netRevenueCents",
  "vatCents",
  "cashInCents",
  "refundsCents",
  "openInvoicesCount",
  "openInvoicesCents",
  "overdueCents",
  "failedPaymentsCount",
  "activeMemberships",
  "recurringRevenueCents",
  "deferredRevenueCents",
  "breakageCents",
] as const satisfies readonly FinanceKpiKey[];

export type FinanceKpiDefinition = {
  key: FinanceKpiKey;
  label: LocalizedText;
  unit: "cents" | "count";
  permission: "reports.finance";
  /** `period`: a sum over the days of the period; `end_of_period`: the state at its end. */
  measure: "period" | "end_of_period";
  /** True when a lower value is the better outcome (refunds, overdue, failed payments). */
  lowerIsBetter: boolean;
};

const def = (
  key: FinanceKpiKey,
  unit: FinanceKpiDefinition["unit"],
  measure: FinanceKpiDefinition["measure"],
  label: Required<LocalizedText>,
  lowerIsBetter = false,
): FinanceKpiDefinition => ({ key, label, unit, permission: "reports.finance", measure, lowerIsBetter });

/** Labels and units for ops' custom dashboards, weekly summary and NL answers. */
export const FINANCE_KPI_DEFINITIONS: FinanceKpiDefinition[] = [
  def("netRevenueCents", "cents", "period", { "nl-BE": "Netto-omzet (excl. btw)", "fr-BE": "Chiffre d'affaires net (hors TVA)", en: "Net revenue (excl. VAT)" }),
  def("vatCents", "cents", "period", { "nl-BE": "Btw", "fr-BE": "TVA", en: "VAT" }),
  def("cashInCents", "cents", "period", { "nl-BE": "Ontvangen betalingen", "fr-BE": "Encaissements", en: "Cash in" }),
  def("refundsCents", "cents", "period", { "nl-BE": "Terugbetalingen (creditnota's, excl. btw)", "fr-BE": "Remboursements (notes de crédit, hors TVA)", en: "Refunds (credit notes, excl. VAT)" }, true),
  def("openInvoicesCount", "count", "end_of_period", { "nl-BE": "Openstaande facturen", "fr-BE": "Factures ouvertes", en: "Open invoices" }, true),
  def("openInvoicesCents", "cents", "end_of_period", { "nl-BE": "Openstaand bedrag", "fr-BE": "Montant ouvert", en: "Amount outstanding" }, true),
  def("overdueCents", "cents", "end_of_period", { "nl-BE": "Vervallen bedrag", "fr-BE": "Montant échu", en: "Amount overdue" }, true),
  def("failedPaymentsCount", "count", "period", { "nl-BE": "Mislukte betalingen", "fr-BE": "Paiements échoués", en: "Failed payments" }, true),
  def("activeMemberships", "count", "end_of_period", { "nl-BE": "Actieve lidmaatschappen", "fr-BE": "Abonnements actifs", en: "Active memberships" }),
  def("recurringRevenueCents", "cents", "period", { "nl-BE": "Terugkerende omzet (excl. btw)", "fr-BE": "Revenus récurrents (hors TVA)", en: "Recurring revenue (excl. VAT)" }),
  def("deferredRevenueCents", "cents", "end_of_period", { "nl-BE": "Uitgestelde omzet (ongebruikte tegoeden, excl. btw)", "fr-BE": "Revenus différés (crédits non utilisés, hors TVA)", en: "Deferred revenue (unused credits, excl. VAT)" }),
  def("breakageCents", "cents", "period", { "nl-BE": "Vervallen tegoeden (excl. btw)", "fr-BE": "Crédits expirés (hors TVA)", en: "Breakage (expired credits, excl. VAT)" }),
];

/** The definition of `key`. */
export function financeKpiDefinition(key: FinanceKpiKey): FinanceKpiDefinition {
  const found = FINANCE_KPI_DEFINITIONS.find((d) => d.key === key);
  if (!found) throw new RangeError(`unknown finance KPI ${String(key)}`);
  return found;
}

/** Every KPI at zero. */
export function emptyFinanceKpiValues(): FinanceKpiValues {
  return Object.fromEntries(FINANCE_KPI_KEYS.map((k) => [k, 0])) as FinanceKpiValues;
}

/**
 * The period `from..to` (Brussels days, both included) and the equal-length period right before
 * it, exactly as the finance dashboard compares a custom period. Throws a `RangeError` for dates
 * that are not `YYYY-MM-DD`, a period that ends before it starts or one longer than 731 days.
 */
export function financeKpiPeriods(input: DateRange): { current: DateRange; previous: DateRange } {
  // A custom period does not depend on the clock; any instant will do.
  const resolved = resolvePeriod({ period: "custom", from: input.from, to: input.to }, new Date(0));
  return { current: { from: resolved.from, to: resolved.to }, previous: resolved.previous };
}

/** Keeps exactly the KPI keys of `values` (missing ones as 0, non-finite ones refused). */
function pickValues(values: Partial<Record<FinanceKpiKey, number>>): FinanceKpiValues {
  const out = emptyFinanceKpiValues();
  for (const key of FINANCE_KPI_KEYS) {
    const v = values[key] ?? 0;
    if (!Number.isFinite(v)) throw new RangeError(`finance KPI ${key} is not a finite number`);
    out[key] = v;
  }
  return out;
}

/** The api result from the figures of the period and of the previous period. */
export function assembleFinanceKpis(current: Partial<Record<FinanceKpiKey, number>>, previous: Partial<Record<FinanceKpiKey, number>>): FinanceKpis {
  return { ...pickValues(current), previous: pickValues(previous) };
}

export type FinanceKpiChange = {
  key: FinanceKpiKey;
  current: number;
  previous: number;
  delta: number;
  /** Relative change in percent with one decimal; null when the previous value is 0. */
  changePct: number | null;
  /** `better`/`worse` from the KPI's direction, `same` when unchanged. */
  trend: "better" | "worse" | "same";
};

/** The change of one KPI against the previous period (for the weekly summary). */
export function financeKpiChange(kpis: FinanceKpis, key: FinanceKpiKey): FinanceKpiChange {
  const current = kpis[key];
  const previous = kpis.previous[key];
  const delta = current - previous;
  const changePct = previous === 0 ? null : Math.round((delta / Math.abs(previous)) * 1000) / 10;
  const up = delta > 0;
  const trend = delta === 0 ? "same" : up !== financeKpiDefinition(key).lowerIsBetter ? "better" : "worse";
  return { key, current, previous, delta, changePct, trend };
}
