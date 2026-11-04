import { describe, expect, it } from "vitest";
import { sumVat, vatOf } from "../commerce/vat";
import { linesFromOrderLines } from "./lines";
import type { InvoiceLine, OrderLineForInvoice, VatRatePct } from "./types";
import { buildVatBreakdown, computeLineVat, documentTotals, isVatRate, toVatRate } from "./vat";

const line = (gross: number, rate: VatRatePct): InvoiceLine => {
  const { vatCents, netCents } = computeLineVat(gross, rate);
  return {
    order_line_id: `ol-${gross}-${rate}`,
    product_id: "p",
    sku: "SKU",
    category: "item",
    description: "Item",
    description_i18n: { "nl-BE": "Item", "fr-BE": "Article", en: "Item" },
    quantity: gross < 0 ? -1 : 1,
    unit_amount_cents: Math.abs(gross),
    discount_cents: 0,
    discount_label: null,
    line_total_cents: gross,
    vat_rate_pct: rate,
    vat_cents: vatCents,
    net_cents: netCents,
    vat_note: rate === 0 ? "note" : null,
    credit_kind: null,
    credit_units: null,
    session_starts_at: null,
  };
};

describe("computeLineVat", () => {
  it("extracts the VAT of each rate from a VAT-inclusive total", () => {
    expect(computeLineVat(12_100, 21)).toEqual({ vatCents: 2_100, netCents: 10_000 });
    expect(computeLineVat(11_200, 12)).toEqual({ vatCents: 1_200, netCents: 10_000 });
    expect(computeLineVat(10_600, 6)).toEqual({ vatCents: 600, netCents: 10_000 });
    expect(computeLineVat(10_000, 0)).toEqual({ vatCents: 0, netCents: 10_000 });
    expect(computeLineVat(4_500, 21)).toEqual({ vatCents: 781, netCents: 3_719 });
  });

  it("rounds half up at exactly .5 (and symmetrically for credit lines)", () => {
    // 14 * 12 / 112 = 1.5
    expect(computeLineVat(14, 12)).toEqual({ vatCents: 2, netCents: 12 });
    expect(computeLineVat(-14, 12)).toEqual({ vatCents: -2, netCents: -12 });
    // 3719.008... rounds down, 4.49 stays 4
    expect(computeLineVat(26, 21).vatCents).toBe(5); // 4.51
    expect(computeLineVat(25, 21).vatCents).toBe(4); // 4.34
  });

  it("is zero for a zero total", () => {
    for (const r of [0, 6, 12, 21] as const) expect(computeLineVat(0, r)).toEqual({ vatCents: 0, netCents: 0 });
  });

  it("gives negative VAT and net for negative credit-note lines", () => {
    expect(computeLineVat(-12_100, 21)).toEqual({ vatCents: -2_100, netCents: -10_000 });
    expect(computeLineVat(-4_500, 21)).toEqual({ vatCents: -781, netCents: -3_719 });
    expect(computeLineVat(-999, 0)).toEqual({ vatCents: 0, netCents: -999 });
  });

  it("equals commerce's vatOf for every rate and amount", () => {
    for (let gross = -2_000; gross <= 2_000; gross += 7) {
      for (const r of [0, 6, 12, 21] as const) expect(computeLineVat(gross, r).vatCents).toBe(vatOf(gross, r));
    }
  });

  it("refuses other rates and fractional cents", () => {
    expect(() => computeLineVat(100, 9 as never)).toThrow(/invalid_vat_rate/);
    expect(() => computeLineVat(10.5, 21)).toThrow(RangeError);
    expect(toVatRate("21.00")).toBe(21);
    expect(toVatRate("0.00")).toBe(0);
    expect(() => toVatRate("20.00")).toThrow();
    expect(isVatRate("")).toBe(false);
    expect(isVatRate(null)).toBe(false);
    expect(isVatRate(6)).toBe(true);
  });
});

describe("buildVatBreakdown", () => {
  it("groups by rate, sorted ascending, with sums of the line values", () => {
    const lines = [line(12_100, 21), line(260, 0), line(1_060, 6), line(4_500, 21), line(11_200, 12)];
    expect(buildVatBreakdown(lines)).toEqual([
      { vat_rate_pct: 0, net_cents: 260, vat_cents: 0, gross_cents: 260 },
      { vat_rate_pct: 6, net_cents: 1_000, vat_cents: 60, gross_cents: 1_060 },
      { vat_rate_pct: 12, net_cents: 10_000, vat_cents: 1_200, gross_cents: 11_200 },
      { vat_rate_pct: 21, net_cents: 13_719, vat_cents: 2_881, gross_cents: 16_600 },
    ]);
  });

  it("sums line VAT, never the VAT of the summed gross", () => {
    // 3 x 26 cents at 21 %: 5 + 5 + 5 = 15, while vat(78) would be 14.
    const lines = [line(26, 21), { ...line(26, 21), order_line_id: "b" }, { ...line(26, 21), order_line_id: "c" }];
    expect(buildVatBreakdown(lines)).toEqual([{ vat_rate_pct: 21, net_cents: 63, vat_cents: 15, gross_cents: 78 }]);
    expect(computeLineVat(78, 21).vatCents).toBe(14);
  });

  it("is empty without lines and handles credit notes", () => {
    expect(buildVatBreakdown([])).toEqual([]);
    expect(buildVatBreakdown([line(-1_210, 21)])).toEqual([{ vat_rate_pct: 21, net_cents: -1_000, vat_cents: -210, gross_cents: -1_210 }]);
  });
});

describe("invoice totals for 200 random baskets", () => {
  // Deterministic PRNG (mulberry32), so a failure is reproducible.
  let seed = 20_261_104;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const RATES = [0, 6, 12, 21] as const;

  it("equal the order total, the commerce VAT and the breakdown", () => {
    for (let basket = 0; basket < 200; basket++) {
      const rows: OrderLineForInvoice[] = Array.from({ length: 1 + Math.floor(rand() * 8) }, (_, i) => {
        const rate = RATES[Math.floor(rand() * 4)]!;
        const quantity = 1 + Math.floor(rand() * 5);
        const unit = Math.floor(rand() * 50_000);
        const discount = Math.min(unit * quantity, Math.floor(rand() * 3) === 0 ? Math.floor(rand() * 2_000) : 0);
        const total = unit * quantity - discount;
        return {
          id: `ol-${basket}-${i}`,
          lineNo: i + 1,
          productId: "p",
          productKind: rate === 0 ? "voucher" : "item",
          sku: `SKU-${i}`,
          description: { "nl-BE": "x", "fr-BE": "x", en: "x" },
          quantity,
          unitAmountCents: unit,
          discountCents: discount,
          lineTotalCents: total,
          vatRatePct: `${rate}.00`,
          vatCents: vatOf(total, rate),
        };
      });
      const orderTotal = rows.reduce((s, r) => s + r.lineTotalCents, 0);
      const orderVat = sumVat(rows.map((r) => ({ lineTotalCents: r.lineTotalCents, vatRatePct: r.vatRatePct })));
      const { lines } = linesFromOrderLines(rows, "en", { voucher: { "nl-BE": "n", "fr-BE": "n", en: "n" } });
      const totals = documentTotals(lines);
      expect(totals.totalCents).toBe(orderTotal);
      expect(totals.vatCents).toBe(orderVat);
      expect(totals.subtotalCents + totals.vatCents).toBe(totals.totalCents);
      for (const l of lines) expect(l.vat_cents).toBe(computeLineVat(l.line_total_cents, l.vat_rate_pct).vatCents);
      const breakdown = buildVatBreakdown(lines);
      expect(breakdown.reduce((s, b) => s + b.gross_cents, 0)).toBe(orderTotal);
      expect(breakdown.reduce((s, b) => s + b.vat_cents, 0)).toBe(orderVat);
      expect(breakdown.reduce((s, b) => s + b.net_cents, 0)).toBe(totals.subtotalCents);
    }
  });
});
