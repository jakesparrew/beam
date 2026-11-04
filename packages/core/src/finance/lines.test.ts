import { describe, expect, it } from "vitest";
import { vatOf } from "../commerce/vat";
import { creditLines, documentLocale, linesFromOrderLines, remainingToCredit, type VatNotes } from "./lines";
import type { InvoiceLine, OrderLineForInvoice } from "./types";
import { computeLineVat, documentTotals } from "./vat";

const all = (nl: string, fr: string, en: string) => ({ "nl-BE": nl, "fr-BE": fr, en });
const NOTES: VatNotes = { voucher: all("Btw verschuldigd bij inwisseling.", "TVA due lors de l'utilisation.", "VAT due on redemption.") };

function orderLine(over: Partial<OrderLineForInvoice> = {}): OrderLineForInvoice {
  const quantity = over.quantity ?? 1;
  const unit = over.unitAmountCents ?? 12_100;
  const discount = over.discountCents ?? 0;
  const total = unit * quantity - discount;
  const rate = over.vatRatePct ?? "21.00";
  return {
    id: "ol-1",
    lineNo: 1,
    productId: "prod-1",
    productKind: "package",
    sku: "PKG-5",
    description: all("Pakket 5 dagen", "Forfait 5 jours", "5-day package"),
    quantity,
    unitAmountCents: unit,
    discountCents: discount,
    lineTotalCents: total,
    vatRatePct: rate,
    vatCents: vatOf(total, rate),
    ...over,
  };
}

describe("linesFromOrderLines", () => {
  it("copies the order lines 1:1 in the customer's locale", () => {
    const { lines, locale } = linesFromOrderLines(
      [orderLine({ creditKind: "day", creditUnits: 5 }), orderLine({ id: "ol-2", lineNo: 2, productKind: "session", sessionStartsAt: new Date("2026-11-10T09:00:00Z") })],
      "fr-BE",
      NOTES,
    );
    expect(locale).toBe("fr-BE");
    expect(lines[0]).toEqual({
      order_line_id: "ol-1",
      product_id: "prod-1",
      sku: "PKG-5",
      category: "package",
      description: "Forfait 5 jours",
      description_i18n: all("Pakket 5 dagen", "Forfait 5 jours", "5-day package"),
      quantity: 1,
      unit_amount_cents: 12_100,
      discount_cents: 0,
      discount_label: null,
      line_total_cents: 12_100,
      vat_rate_pct: 21,
      vat_cents: 2_100,
      net_cents: 10_000,
      vat_note: null,
      credit_kind: "day",
      credit_units: 5,
      session_starts_at: null,
    });
    expect(lines[1]!.session_starts_at).toBe("2026-11-10T09:00:00.000Z");
  });

  it("falls back to nl-BE for the whole document when one line lacks the locale", () => {
    const rows = [orderLine(), orderLine({ id: "ol-2", lineNo: 2, description: { "nl-BE": "Oud product", en: "Old product" } })];
    const { lines, locale } = linesFromOrderLines(rows, "fr-BE", NOTES);
    expect(locale).toBe("nl-BE");
    expect(lines.map((l) => l.description)).toEqual(["Pakket 5 dagen", "Oud product"]);
    expect(documentLocale(rows, "en")).toBe("en");
    // A legacy line without nl-BE at all still gets a description (never blocks).
    const legacy = linesFromOrderLines([orderLine({ description: { en: "Legacy" } })], "fr-BE", NOTES);
    expect(legacy).toMatchObject({ locale: "nl-BE", lines: [{ description: "Legacy" }] });
  });

  it("puts the VAT note on 0 % lines and throws validation without one", () => {
    const voucher = orderLine({ productKind: "voucher", vatRatePct: "0.00", unitAmountCents: 5_000 });
    expect(linesFromOrderLines([voucher], "en", NOTES).lines[0]).toMatchObject({ vat_rate_pct: 0, vat_cents: 0, net_cents: 5_000, vat_note: "VAT due on redemption." });
    const item0 = orderLine({ productKind: "item", vatRatePct: 0, unitAmountCents: 500 });
    expect(() => linesFromOrderLines([item0], "en", NOTES)).toThrow(expect.objectContaining({ code: "validation", message: "finance.errors.vat_note_missing" }));
    expect(() => linesFromOrderLines([voucher], "en", { voucher: { en: "only en" } })).not.toThrow();
    expect(() => linesFromOrderLines([voucher], "nl-BE", { voucher: { en: "only en" } })).toThrow(/vat_note_missing/);
  });

  it("refuses no lines and a rate outside 0, 6, 12, 21", () => {
    expect(() => linesFromOrderLines([], "en", NOTES)).toThrow(/no_lines/);
    expect(() => linesFromOrderLines([orderLine({ vatRatePct: "9.00", vatCents: 0 })], "en", NOTES)).toThrow(/invalid_vat_rate/);
  });
});

const invoiceLines = (rows: OrderLineForInvoice[]) => linesFromOrderLines(rows, "en", NOTES).lines;

describe("creditLines", () => {
  const three = orderLine({ quantity: 3, unitAmountCents: 1_000, discountCents: 1 }); // G = 2999
  const other = orderLine({ id: "ol-2", lineNo: 2, productKind: "voucher", vatRatePct: "0.00", unitAmountCents: 2_500 });

  it("'full' negates every line", () => {
    const inv = invoiceLines([three, other]);
    const cn = creditLines(inv, [], "full");
    expect(cn).toHaveLength(2);
    expect(cn[0]).toMatchObject({ order_line_id: "ol-1", quantity: -3, unit_amount_cents: 1_000, discount_cents: -1, line_total_cents: -2_999, credit_by: "quantity" });
    expect(cn[0]!.vat_cents).toBe(computeLineVat(-2_999, 21).vatCents);
    expect(cn[1]).toMatchObject({ order_line_id: "ol-2", quantity: -1, line_total_cents: -2_500, vat_cents: 0, vat_note: "VAT due on redemption." });
    expect(documentTotals(cn).totalCents).toBe(-documentTotals(inv).totalCents);
    for (const l of cn) expect(l.line_total_cents).toBe(l.unit_amount_cents * l.quantity - l.discount_cents);
  });

  it("a line credited in three quantity parts sums to its gross exactly", () => {
    const inv = invoiceLines([three]);
    const a = creditLines(inv, [], [{ orderLineId: "ol-1", quantity: 1 }]);
    const b = creditLines(inv, [a], [{ orderLineId: "ol-1", quantity: 1 }]);
    const c = creditLines(inv, [a, b], [{ orderLineId: "ol-1", quantity: 1 }]);
    expect([a, b, c].map((x) => x[0]!.line_total_cents)).toEqual([-1_000, -1_000, -999]); // round(2999/3) = 1000, the last takes the rest
    expect(a[0]!.line_total_cents + b[0]!.line_total_cents + c[0]!.line_total_cents).toBe(-2_999);
    for (const x of [a, b, c]) expect(x[0]!.line_total_cents).toBe(x[0]!.unit_amount_cents * x[0]!.quantity - x[0]!.discount_cents);
    expect(() => creditLines(inv, [a, b, c], [{ orderLineId: "ol-1", quantity: 1 }])).toThrow(/credit_exceeds_invoice/);
    expect(() => creditLines(inv, [a, b, c], "full")).toThrow(/credit_exceeds_invoice/);
  });

  it("credit beyond what remains throws conflict", () => {
    const inv = invoiceLines([three]);
    expect(() => creditLines(inv, [], [{ orderLineId: "ol-1", quantity: 4 }])).toThrow(
      expect.objectContaining({ code: "conflict", message: "finance.errors.credit_exceeds_invoice" }),
    );
    const part = creditLines(inv, [], [{ orderLineId: "ol-1", amountCents: 2_000 }]);
    expect(() => creditLines(inv, [part], [{ orderLineId: "ol-1", amountCents: 1_000 }])).toThrow(/credit_exceeds_invoice/);
    expect(() => creditLines(inv, [part], [{ orderLineId: "ol-1", quantity: 2 }])).toThrow(/credit_exceeds_invoice/);
    // Two partial requests in one call that together exceed the line.
    expect(() => creditLines(inv, [], [{ orderLineId: "ol-1", amountCents: 2_000 }, { orderLineId: "ol-1", amountCents: 1_000 }])).toThrow(/credit_exceeds_invoice/);
    // Earlier credit notes that already exceed the invoice (corrupt data) are refused too.
    expect(() => creditLines(inv, [creditLines(inv, [], "full"), creditLines(inv, [], "full")], [{ orderLineId: "ol-1", amountCents: 1 }])).toThrow(/credit_exceeds_invoice/);
  });

  it("partial by amount: quantity -1, the amount as unit price, prefixed description, VAT at the line's rate", () => {
    const inv = invoiceLines([three]);
    const [l] = creditLines(inv, [], [{ orderLineId: "ol-1", amountCents: 1_210 }], { partialCreditLabel: "Partial credit:" });
    expect(l).toMatchObject({
      quantity: -1,
      unit_amount_cents: 1_210,
      discount_cents: 0,
      discount_label: null,
      line_total_cents: -1_210,
      vat_rate_pct: 21,
      vat_cents: -210,
      net_cents: -1_000,
      description: "Partial credit: 5-day package",
      credit_by: "amount",
    });
    // 'full' after a partial amount credits the rest as one amount line.
    const rest = creditLines(inv, [[l!]], "full");
    expect(rest).toHaveLength(1);
    expect(rest[0]).toMatchObject({ quantity: -1, line_total_cents: -(2_999 - 1_210), credit_by: "amount" });
    expect(remainingToCredit(inv, [[l!], rest]).get("ol-1")).toEqual({ quantity: 3, grossCents: 0 });
  });

  it("prorates credit units and keeps the line identity with a discount", () => {
    const inv = invoiceLines([orderLine({ quantity: 2, unitAmountCents: 4_500, discountCents: 901, creditKind: "day", creditUnits: 10 })]);
    const [half] = creditLines(inv, [], [{ orderLineId: "ol-1", quantity: 1 }]);
    expect(half).toMatchObject({ quantity: -1, line_total_cents: -4_050, discount_cents: -450, credit_units: -5 }); // round(8099 / 2) = 4050
    const [rest] = creditLines(inv, [[half!]], "full");
    expect(rest).toMatchObject({ quantity: -1, line_total_cents: -4_049, credit_units: -5 });
    expect(remainingToCredit(inv, [[half!]]).get("ol-1")).toEqual({ quantity: 1, grossCents: 4_049 });
  });

  it("validates the request", () => {
    const inv = invoiceLines([three]);
    expect(() => creditLines(inv, [], [])).toThrow(/no_lines/);
    expect(() => creditLines(inv, [], [{ orderLineId: "nope", quantity: 1 }])).toThrow(/unknown_line/);
    expect(() => creditLines(inv, [], [{ orderLineId: "ol-1" }])).toThrow(/quantity_or_amount/);
    expect(() => creditLines(inv, [], [{ orderLineId: "ol-1", quantity: 1, amountCents: 5 }])).toThrow(/quantity_or_amount/);
    expect(() => creditLines(inv, [], [{ orderLineId: "ol-1", quantity: 0 }])).toThrow(/credit_quantity_invalid/);
    expect(() => creditLines(inv, [], [{ orderLineId: "ol-1", amountCents: -5 }])).toThrow(/credit_amount_invalid/);
    const cn = creditLines(inv, [], "full");
    expect(() => creditLines(cn, [], "full")).toThrow(/not_an_invoice_line/);
    expect(() => creditLines(inv, [[{ ...cn[0]!, order_line_id: "elsewhere" }]], "full")).toThrow(/unknown_line/);
  });

  it("infers the mode of credit lines stored without credit_by", () => {
    const inv = invoiceLines([three]);
    const [byQty] = creditLines(inv, [], [{ orderLineId: "ol-1", quantity: 1 }]);
    const [byAmount] = creditLines(inv, [], [{ orderLineId: "ol-1", amountCents: 500 }], { partialCreditLabel: "Partial credit:" });
    const strip = (l: InvoiceLine): InvoiceLine => {
      const { credit_by: _ignored, ...rest } = l;
      return rest;
    };
    expect(remainingToCredit(inv, [[strip(byQty!)], [strip(byAmount!)]]).get("ol-1")).toEqual({ quantity: 2, grossCents: 2_999 - 1_000 - 500 });
  });
});
