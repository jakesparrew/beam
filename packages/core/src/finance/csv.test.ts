import { describe, expect, it } from "vitest";
import { FINANCE_EXPORT_KINDS } from "./types";
import { boolCell, centsToEuros, CSV_BOM, csvCell, csvLine, EXPORT_COLUMNS, exportFileName, toCsv, V1_EXPORT_KINDS, vatRateCell } from "./csv";

describe("toCsv", () => {
  it("starts with the UTF-8 BOM, then one header row, `;` separated and CRLF terminated", () => {
    const out = toCsv(["a", "b"], [["x", 1]]);
    expect(out.startsWith(CSV_BOM)).toBe(true);
    expect(out.charCodeAt(0)).toBe(0xfeff);
    expect(out.slice(1)).toBe("a;b\r\nx;1\r\n");
    expect(new TextEncoder().encode(out).subarray(0, 3)).toEqual(new Uint8Array([0xef, 0xbb, 0xbf]));
  });

  it("writes only the header for no rows", () => {
    expect(toCsv(["number", "total"], [])).toBe(`${CSV_BOM}number;total\r\n`);
  });

  it("quotes cells with `;`, quotes and newlines (RFC 4180) and doubles inner quotes", () => {
    expect(csvCell("Acme; Wellness")).toBe('"Acme; Wellness"');
    expect(csvCell('The "best" spa')).toBe('"The ""best"" spa"');
    expect(csvCell("line 1\nline 2")).toBe('"line 1\nline 2"');
    expect(csvCell("line 1\r\nline 2")).toBe('"line 1\r\nline 2"');
    expect(csvCell("plain, with comma")).toBe("plain, with comma");
    expect(csvLine(["a;b", null, 3, "Zoë Ørsted"])).toBe('"a;b";;3;Zoë Ørsted\r\n');
  });

  it("writes null as an empty cell and keeps accents (UTF-8)", () => {
    const out = toCsv(["name", "vat"], [["Brasserie Élise", null]]);
    expect(out).toContain("Brasserie Élise;\r\n");
  });

  it("neutralises text that a spreadsheet would run as a formula, but not negative amounts", () => {
    expect(csvCell("=HYPERLINK(\"x\")")).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell("+32 470 00 00 00")).toBe("'+32 470 00 00 00");
    expect(csvCell("@sum")).toBe("'@sum");
    expect(csvCell("-cmd")).toBe("'-cmd");
    expect(csvCell("-12.34")).toBe("-12.34");
    expect(csvCell("-3")).toBe("-3");
  });

  it("refuses a row whose width differs from the header", () => {
    expect(() => toCsv(["a", "b"], [["only one"]])).toThrow(RangeError);
  });

  it("accepts any iterable of rows (a generator)", () => {
    function* rows() {
      yield ["1"];
      yield ["2"];
    }
    expect(toCsv(["n"], rows())).toBe(`${CSV_BOM}n\r\n1\r\n2\r\n`);
  });
});

describe("decimals", () => {
  it("writes cents as euros with a dot and two decimals", () => {
    expect(centsToEuros(0)).toBe("0.00");
    expect(centsToEuros(5)).toBe("0.05");
    expect(centsToEuros(4_500)).toBe("45.00");
    expect(centsToEuros(123_456)).toBe("1234.56");
    expect(centsToEuros(-1_234)).toBe("-12.34");
    expect(centsToEuros(-7)).toBe("-0.07");
    expect(() => centsToEuros(1.5)).toThrow(RangeError);
  });

  it("numbers never use a locale comma; VAT rates are plain numbers", () => {
    expect(csvCell(12.5)).toBe("12.5");
    expect(csvCell(-2)).toBe("-2");
    expect(() => csvCell(Number.NaN)).toThrow(RangeError);
    expect(vatRateCell("21.00")).toBe("21");
    expect(vatRateCell("6")).toBe("6");
    expect(vatRateCell(0)).toBe("0");
    expect(vatRateCell("5.50")).toBe("5.5");
  });

  it("booleans are true/false", () => {
    expect(boolCell(true)).toBe("true");
    expect(boolCell(false)).toBe("false");
  });
});

describe("EXPORT_COLUMNS", () => {
  it("has a header for every export kind", () => {
    expect(Object.keys(EXPORT_COLUMNS).sort()).toEqual([...FINANCE_EXPORT_KINDS].sort());
    for (const kind of FINANCE_EXPORT_KINDS) expect(new Set(EXPORT_COLUMNS[kind]).size).toBe(EXPORT_COLUMNS[kind].length);
  });

  it("fixes the V1 headers of the spec", () => {
    expect(EXPORT_COLUMNS.invoices.join(", ")).toBe(
      "number, kind, issued_on, due_on, status, customer_name, customer_vat, is_company, net, vat, total, payment_method, payment_reference, reverses_number, billit_id",
    );
    expect(EXPORT_COLUMNS.invoice_lines.join(", ")).toBe("number, line_no, sku, category, description, quantity, unit_incl, discount, vat_rate, net, vat, gross");
    expect(EXPORT_COLUMNS.vat_summary.join(", ")).toBe("month, vat_rate, kind, net, vat, gross");
    expect(EXPORT_COLUMNS.payments.join(", ")).toBe("paid_on, provider, method, provider_payment_id, order_id, invoice_number, amount");
    expect(EXPORT_COLUMNS.deferred_revenue.join(", ")).toBe("as_of, credit_kind, vat_treatment, vat_rate, units, gross, net, vat");
    expect(EXPORT_COLUMNS.breakage.join(", ")).toBe("month, credit_kind, vat_rate, recognised_gross, breakage_gross, breakage_net, breakage_vat, revoked_gross");
    expect(EXPORT_COLUMNS.voucher_redemptions.join(", ")).toBe("redeemed_on, order_id, invoice_number, amount, is_reversed");
    expect([...V1_EXPORT_KINDS]).toEqual(["invoices", "invoice_lines", "vat_summary", "payments"]);
  });

  it("names files by kind and period", () => {
    expect(exportFileName("invoice_lines", "2026-10-01", "2026-10-31")).toBe("beam-invoice-lines-2026-10-01-2026-10-31.csv");
  });
});
