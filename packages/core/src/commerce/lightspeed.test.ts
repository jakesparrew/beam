/**
 * commerce-P9: the Lightspeed sales CSV parser (rule 53, edge case 24): semicolon and comma
 * files, Belgian decimal commas, VAT parsing and bad rows reported with their row numbers.
 */
import { describe, expect, it } from "vitest";
import {
  businessDayRange,
  detectDelimiter,
  parseCents,
  parseLightspeedCsv,
  parseLightspeedDateTime,
  parseQuantity,
  parseVatRate,
} from "./lightspeed";

const SEMICOLON = [
  "Bonnummer;Lijn;Datum;Product;Categorie;Aantal;Totaal incl. btw;Btw %;Btw bedrag;Betaalmethode",
  "R-1001;1;04/11/2026 14:32;Cappuccino;Warme dranken;2;7,00;21%;1,21;Bancontact",
  "R-1001;2;04/11/2026 14:32;Croque monsieur;Keuken;1;12,50;12,00 %;;Bancontact",
  "R-1002;1;04/11/2026 23:15;Wijn wit;Wijn;1;1.234,56;21;214,26;Cash",
].join("\r\n");

const COMMA = [
  "Receipt number,Date,Time,Item,Category,Qty,Total,VAT rate,Payment method",
  'R-2001,2026-11-04,09:05,"Tea, green",Hot drinks,1,3.20,0.21,Card',
  'R-2001,2026-11-04,09:05,Scone,Kitchen,"1,5","4,80",6,Card',
  "R-2002,2026-11-04,10:00,Water,Cold drinks,1,2.50,21,",
].join("\n");

describe("parseLightspeedCsv", () => {
  it("reads a semicolon export with Dutch headers and Belgian decimal commas", () => {
    expect(detectDelimiter(SEMICOLON)).toBe(";");
    const { rows, errors } = parseLightspeedCsv(SEMICOLON);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      row: 2,
      externalLineKey: "R-1001:1",
      receiptNumber: "R-1001",
      productName: "Cappuccino",
      category: "Warme dranken",
      quantity: "2.000",
      totalCents: 700,
      vatRatePct: "21.00",
      vatCents: 121,
      paymentMethod: "Bancontact",
      businessDayOn: "2026-11-04",
    });
    // 14:32 Brussels in November (CET, UTC+1).
    expect(rows[0]!.soldAt.toISOString()).toBe("2026-11-04T13:32:00.000Z");
    // No VAT amount column value: computed from the total (rule 11): 1250 * 12 / 112.
    expect(rows[1]).toMatchObject({ externalLineKey: "R-1001:2", totalCents: 1250, vatRatePct: "12.00", vatCents: 134 });
    expect(rows[2]).toMatchObject({ totalCents: 123_456, vatCents: 21_426, paymentMethod: "Cash" });
  });

  it("reads a comma export with quoted cells, separate date and time columns and English headers", () => {
    expect(detectDelimiter(COMMA)).toBe(",");
    const { rows, errors } = parseLightspeedCsv(COMMA);
    expect(errors).toEqual([]);
    expect(rows.map((r) => r.externalLineKey)).toEqual(["R-2001:1", "R-2001:2", "R-2002:1"]);
    expect(rows[0]).toMatchObject({ productName: "Tea, green", totalCents: 320, vatRatePct: "21.00", vatCents: 56 });
    expect(rows[1]).toMatchObject({ quantity: "1.500", totalCents: 480, vatRatePct: "6.00", vatCents: 27 });
    expect(rows[2]).toMatchObject({ paymentMethod: "unknown" });
    expect(rows[0]!.soldAt.toISOString()).toBe("2026-11-04T08:05:00.000Z");
    expect(businessDayRange(rows)).toEqual({ from: "2026-11-04", to: "2026-11-04" });
  });

  it("gives the same line keys for the same file (position within the receipt)", () => {
    const a = parseLightspeedCsv(COMMA).rows.map((r) => r.externalLineKey);
    const b = parseLightspeedCsv(COMMA).rows.map((r) => r.externalLineKey);
    expect(a).toEqual(b);
  });

  it("lists broken rows with their row number and code and imports the rest", () => {
    const csv = [
      "Ticket;Date;Produit;Catégorie;Quantité;Montant TTC;TVA;Paiement",
      ";04/11/2026 10:00;Café;Boissons;1;2,80;21;Cash",
      "T-1;31/02/2026 10:00;Café;Boissons;1;2,80;21;Cash",
      "T-2;04/11/2026 10:00;;Boissons;1;2,80;21;Cash",
      "T-3;04/11/2026 10:00;Café;Boissons;0;2,80;21;Cash",
      "T-4;04/11/2026 10:00;Café;Boissons;1;deux;21;Cash",
      "T-5;04/11/2026 10:00;Café;Boissons;1;2,80;19;Cash",
      "T-6;04/11/2026 10:00;Café;Boissons;1;2,80;21;Cash",
      "T-7;04/11/2026",
    ].join("\n");
    const { rows, errors } = parseLightspeedCsv(csv);
    expect(rows.map((r) => [r.row, r.externalLineKey, r.category])).toEqual([[8, "T-6:1", "Boissons"]]);
    expect(errors).toEqual([
      { row: 2, code: "receipt_missing", column: "receipt" },
      { row: 3, code: "date_invalid", column: "date" },
      { row: 4, code: "product_missing", column: "product" },
      { row: 5, code: "quantity_invalid", column: "quantity" },
      { row: 6, code: "total_invalid", column: "total" },
      { row: 7, code: "vat_rate_invalid", column: "vatRate" },
      { row: 9, code: "column_count" },
    ]);
  });

  it("rejects a VAT amount larger than the total and a duplicated line", () => {
    const csv = ["Receipt;Line;Date;Product;Total;VAT;VAT amount", "A;1;2026-11-04 10:00;X;1,00;21;2,00", "B;1;2026-11-04 10:00;X;1,00;21;0,17", "B;1;2026-11-04 10:01;Y;1,00;21;0,17"].join("\n");
    const { rows, errors } = parseLightspeedCsv(csv);
    expect(rows.map((r) => r.externalLineKey)).toEqual(["B:1"]);
    expect(rows[0]).toMatchObject({ category: "Other", quantity: "1.000", vatCents: 17 });
    expect(errors).toEqual([
      { row: 2, code: "vat_amount_invalid", column: "vatAmount" },
      { row: 4, code: "duplicate_line", column: "line" },
    ]);
  });

  it("reports missing required columns on the header row and an empty file", () => {
    expect(parseLightspeedCsv("Product;Total\nX;1,00").errors).toEqual([
      { row: 1, code: "missing_column", column: "receipt" },
      { row: 1, code: "missing_column", column: "vatRate" },
      { row: 1, code: "missing_column", column: "datetime" },
    ]);
    expect(parseLightspeedCsv("﻿\n\n")).toEqual({ rows: [], errors: [{ row: 1, code: "empty_file" }] });
  });

  it("keeps negative till lines (returns) with their VAT", () => {
    const { rows } = parseLightspeedCsv("Receipt;Date;Product;Qty;Total;VAT\nR;2026-11-04 10:00;Return;-1;-3,50;21");
    expect(rows[0]).toMatchObject({ quantity: "-1.000", totalCents: -350, vatCents: -61 });
  });
});

describe("value parsing", () => {
  it("reads Belgian and English amounts", () => {
    expect(parseCents("12,50")).toBe(1250);
    expect(parseCents("1.234,56")).toBe(123_456);
    expect(parseCents("1,234.56")).toBe(123_456);
    expect(parseCents("€ 3,00")).toBe(300);
    expect(parseCents("1.000.000")).toBe(100_000_000);
    expect(parseCents("2,005")).toBe(201);
    expect(parseCents("-0,5")).toBe(-50);
    expect(parseCents("3,00-")).toBe(-300);
    expect(parseCents("(4,00)")).toBe(-400);
    expect(parseCents("abc")).toBeNull();
    expect(parseCents("")).toBeNull();
    expect(parseCents("1,2,3.4,5")).toBeNull();
  });

  it("reads quantities with three decimals", () => {
    expect(parseQuantity("2")).toBe("2.000");
    expect(parseQuantity("0,25")).toBe("0.250");
    expect(parseQuantity("0")).toBeNull();
  });

  it("accepts Belgian VAT rates only", () => {
    expect(parseVatRate("21")).toBe("21.00");
    expect(parseVatRate("21%")).toBe("21.00");
    expect(parseVatRate("12,00 %")).toBe("12.00");
    expect(parseVatRate("0.06")).toBe("6.00");
    expect(parseVatRate("0")).toBe("0.00");
    expect(parseVatRate("19")).toBeNull();
    expect(parseVatRate("21,5")).toBeNull();
    expect(parseVatRate("-6")).toBeNull();
  });

  it("reads Brussels wall-clock times across DST and explicit offsets", () => {
    expect(parseLightspeedDateTime("2026-07-01 12:00")!.toISOString()).toBe("2026-07-01T10:00:00.000Z");
    expect(parseLightspeedDateTime("01.07.2026", "12:00:30")!.toISOString()).toBe("2026-07-01T10:00:30.000Z");
    expect(parseLightspeedDateTime("2026-07-01T12:00:00Z")!.toISOString()).toBe("2026-07-01T12:00:00.000Z");
    expect(parseLightspeedDateTime("04-11-26")!.toISOString()).toBe("2026-11-03T23:00:00.000Z");
    expect(parseLightspeedDateTime("2026-11-04 25:00")).toBeNull();
  });

  it("uses the business-day column when present", () => {
    const { rows } = parseLightspeedCsv("Receipt;Date;Business day;Product;Total;VAT\nR;05/11/2026 00:40;04/11/2026;Late drink;5,00;21");
    expect(rows[0]).toMatchObject({ businessDayOn: "2026-11-04" });
    expect(rows[0]!.soldAt.toISOString()).toBe("2026-11-04T23:40:00.000Z");
  });
});
