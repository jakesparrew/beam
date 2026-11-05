/**
 * fix-w20-finance-wiring: `@beam/core/finance` is the one door to finance's pure core. The PDF
 * document model, the Billit mapping, the CSV format, the dashboard periods and the KPIs are
 * re-exported from the barrel (requests of finance-P3, P4, P7, P8 and P10), and the barrel's
 * `FinanceKpis` is the finance-P10 shape, not the finance-P1 placeholder.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import * as finance from "./index";
import * as billitMapping from "./billit-mapping";
import * as csv from "./csv";
import * as documentModel from "./document-model";
import * as kpis from "./kpis";
import * as periods from "./periods";

describe("@beam/core/finance barrel", () => {
  it.each([
    ["document-model", documentModel],
    ["billit-mapping", billitMapping],
    ["csv", csv],
    ["periods", periods],
    ["kpis", kpis],
  ] as const)("re-exports every value of ./%s", (_name, mod) => {
    for (const [key, value] of Object.entries(mod)) {
      expect(finance, key).toHaveProperty(key);
      expect((finance as Record<string, unknown>)[key], key).toBe(value);
    }
  });

  it("exposes the finance-P10 KPI shape as FinanceKpis", () => {
    expectTypeOf<finance.FinanceKpis>().toEqualTypeOf<kpis.FinanceKpis>();
    const k: finance.FinanceKpis = finance.assembleFinanceKpis({ netRevenueCents: 100 }, {});
    expect(k.netRevenueCents).toBe(100);
    expect(k.previous.netRevenueCents).toBe(0);
    expect(k).not.toHaveProperty("invoicedCents");
  });
});
