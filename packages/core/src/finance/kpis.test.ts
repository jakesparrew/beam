/**
 * finance-P10 pure KPI core: definitions cover every key, the comparison period is the
 * dashboard's custom-period comparison, and the assembled result always fills `previous`. The
 * database figures are compared with the finance dashboard in
 * `apps/web/modules/finance/finance-p10.kpis.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { LOCALES } from "../i18n/locales";
import {
  assembleFinanceKpis,
  emptyFinanceKpiValues,
  FINANCE_KPI_DEFINITIONS,
  FINANCE_KPI_KEYS,
  financeKpiChange,
  financeKpiDefinition,
  financeKpiPeriods,
  type FinanceKpis,
} from "./kpis";
import { resolvePeriod } from "./periods";

describe("FINANCE_KPI_DEFINITIONS", () => {
  it("defines every KPI key once, in key order", () => {
    expect(FINANCE_KPI_DEFINITIONS.map((d) => d.key)).toEqual([...FINANCE_KPI_KEYS]);
    expect(new Set(FINANCE_KPI_KEYS).size).toBe(FINANCE_KPI_KEYS.length);
  });

  it("has a label in every locale, the reports.finance permission and a unit matching the key", () => {
    for (const d of FINANCE_KPI_DEFINITIONS) {
      for (const locale of LOCALES) expect(d.label[locale], `${d.key} ${locale}`).toMatch(/\S/);
      expect(d.permission).toBe("reports.finance");
      expect(d.unit).toBe(d.key.endsWith("Cents") ? "cents" : "count");
    }
  });

  it("marks state KPIs as end of period and flows as period sums", () => {
    const state = FINANCE_KPI_DEFINITIONS.filter((d) => d.measure === "end_of_period").map((d) => d.key);
    expect(state).toEqual(expect.arrayContaining(["openInvoicesCount", "openInvoicesCents", "overdueCents", "activeMemberships", "deferredRevenueCents"]));
    expect(financeKpiDefinition("netRevenueCents").measure).toBe("period");
    expect(() => financeKpiDefinition("previous" as never)).toThrow(RangeError);
  });
});

describe("financeKpiPeriods", () => {
  it("compares with the equal-length period right before, as the dashboard's custom period", () => {
    for (const range of [
      { from: "2027-11-01", to: "2027-11-30" },
      { from: "2027-01-01", to: "2027-01-07" },
      { from: "2028-02-29", to: "2028-02-29" },
      { from: "2027-03-22", to: "2027-04-04" }, // across the spring DST change
    ]) {
      const p = financeKpiPeriods(range);
      const dashboard = resolvePeriod({ period: "custom", ...range }, new Date("2027-11-04T22:30:00Z"));
      expect(p).toEqual({ current: range, previous: dashboard.previous });
    }
    expect(financeKpiPeriods({ from: "2027-11-01", to: "2027-11-30" }).previous).toEqual({ from: "2027-10-02", to: "2027-10-31" });
    expect(financeKpiPeriods({ from: "2027-01-01", to: "2027-01-07" }).previous).toEqual({ from: "2026-12-25", to: "2026-12-31" });
  });

  it("refuses invalid ranges", () => {
    expect(() => financeKpiPeriods({ from: "2027-11-30", to: "2027-11-01" })).toThrow(RangeError);
    expect(() => financeKpiPeriods({ from: "2027-11", to: "2027-11-30" })).toThrow(RangeError);
    expect(() => financeKpiPeriods({ from: "2020-01-01", to: "2027-11-30" })).toThrow(RangeError);
  });
});

describe("assembleFinanceKpis", () => {
  it("fills every key of the period and of previous, missing ones as 0", () => {
    const k = assembleFinanceKpis({ netRevenueCents: 18_000, activeMemberships: 2 }, { netRevenueCents: 10_000 });
    expect(Object.keys(k).filter((key) => key !== "previous").sort()).toEqual([...FINANCE_KPI_KEYS].sort());
    expect(Object.keys(k.previous).sort()).toEqual([...FINANCE_KPI_KEYS].sort());
    expect(k.netRevenueCents).toBe(18_000);
    expect(k.activeMemberships).toBe(2);
    expect(k.vatCents).toBe(0);
    expect(k.previous).toEqual({ ...emptyFinanceKpiValues(), netRevenueCents: 10_000 });
  });

  it("drops unknown keys and refuses non-finite numbers", () => {
    const k = assembleFinanceKpis({ netRevenueCents: 1, extra: 5 } as never, {});
    expect("extra" in k).toBe(false);
    expect(() => assembleFinanceKpis({ vatCents: Number.NaN }, {})).toThrow(RangeError);
  });
});

describe("financeKpiChange", () => {
  const kpis: FinanceKpis = assembleFinanceKpis(
    { netRevenueCents: 18_000, refundsCents: 20_000, failedPaymentsCount: 3, vatCents: 100 },
    { netRevenueCents: 10_000, refundsCents: 0, failedPaymentsCount: 4, vatCents: 100 },
  );

  it("computes delta, percent and direction", () => {
    expect(financeKpiChange(kpis, "netRevenueCents")).toEqual({ key: "netRevenueCents", current: 18_000, previous: 10_000, delta: 8_000, changePct: 80, trend: "better" });
    expect(financeKpiChange(kpis, "refundsCents")).toMatchObject({ delta: 20_000, changePct: null, trend: "worse" });
    expect(financeKpiChange(kpis, "failedPaymentsCount")).toMatchObject({ delta: -1, changePct: -25, trend: "better" });
    expect(financeKpiChange(kpis, "vatCents")).toMatchObject({ delta: 0, changePct: 0, trend: "same" });
  });
});
