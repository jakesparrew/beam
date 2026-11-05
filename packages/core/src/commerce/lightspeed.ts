/**
 * Lightspeed sales CSV (commerce rule 53, R3, commerce-P9). BEAM staff export the daily sales
 * from the Lightspeed back office and upload the file; this pure parser turns it into
 * `lightspeed_sales` rows. Rows are reporting data only: they create no orders, persons or
 * invoices, and they hold no person data (a customer column in the export is ignored).
 *
 * The parser is lenient about the shape of the export and strict about the values:
 * - the delimiter is detected on the header line (`;`, `,` or a tab; Belgian exports use `;`);
 * - headers are matched case- and accent-insensitively against English, Dutch and French
 *   names (`Receipt`, `Bonnummer`, `Ticket`, `Totaal incl. btw`, `Montant TTC`, ...);
 * - amounts accept Belgian decimal commas and thousands separators (`1.234,56`, `12,50`,
 *   `€ 3,00`) as well as dots (`12.50`); money becomes integer cents, half up;
 * - VAT rates accept `21`, `21%`, `21,00 %` and `0.21`, and must be a Belgian rate (0, 6, 12, 21);
 *   the VAT amount is taken from its column when present, else computed from the total (rule 11);
 * - local date-times are Europe/Brussels (`2026-11-04 14:32`, `04/11/2026 14:32:10`,
 *   `04-11-2026`, `04.11.2026`, or separate date and time columns); an explicit offset wins;
 * - a broken row is listed in `errors` with its row number (the header is row 1) and the rest
 *   imports (edge case 24).
 *
 * `external_line_key` is `<receipt_number>:<line_number>`; without a line column the line number
 * is the row's position within its receipt in file order, so the same file always gives the
 * same keys and a re-upload adds nothing.
 */
import { TZDate } from "@date-fns/tz";
import { vatOf } from "./vat";

export const LIGHTSPEED_VAT_RATES = [0, 6, 12, 21] as const;

/** One parsed till line, ready for `lightspeed_sales`. */
export type LightspeedRow = {
  /** The CSV row number (header = 1). */
  row: number;
  externalLineKey: string;
  receiptNumber: string;
  lineNumber: number;
  /** `YYYY-MM-DD` (Europe/Brussels). */
  businessDayOn: string;
  soldAt: Date;
  productName: string;
  category: string;
  /** `numeric(10,3)` as text, e.g. `"2.000"` or `"-1.000"`. */
  quantity: string;
  totalCents: number;
  /** `numeric(4,2)` as text, e.g. `"21.00"`. */
  vatRatePct: string;
  vatCents: number;
  paymentMethod: string;
};

export const LIGHTSPEED_ERROR_CODES = [
  "empty_file",
  "missing_column",
  "column_count",
  "receipt_missing",
  "date_invalid",
  "product_missing",
  "quantity_invalid",
  "total_invalid",
  "vat_rate_invalid",
  "vat_amount_invalid",
  "line_invalid",
  "duplicate_line",
] as const;
export type LightspeedErrorCode = (typeof LIGHTSPEED_ERROR_CODES)[number];

export type RowError = { row: number; code: LightspeedErrorCode; column?: string };

export type LightspeedColumn =
  | "receipt"
  | "line"
  | "datetime"
  | "date"
  | "time"
  | "businessDay"
  | "product"
  | "category"
  | "quantity"
  | "total"
  | "vatRate"
  | "vatAmount"
  | "payment";

/** Header names per column, normalised (lower case, no accents, letters and digits only). */
const HEADER_ALIASES: Record<LightspeedColumn, readonly string[]> = {
  receipt: ["receipt", "receiptnumber", "receiptno", "receiptnr", "receiptid", "ticket", "ticketnumber", "ticketno", "ticketnr", "bon", "bonnummer", "bonnr", "kassabon", "numeroticket", "noticket", "recu", "numerorecu", "transaction", "transactionid"],
  line: ["line", "linenumber", "lineno", "linenr", "lijn", "lijnnummer", "lijnnr", "regel", "regelnummer", "ligne", "numeroligne", "noligne", "position"],
  datetime: ["datetime", "dateandtime", "soldat", "timestamp", "datumtijd", "datumentijd", "dateheure", "dateetheure", "createdat"],
  date: ["date", "datum", "saledate", "verkoopdatum", "datevente"],
  time: ["time", "tijd", "uur", "heure"],
  businessDay: ["businessday", "businessdate", "businessdayon", "bedrijfsdag", "werkdag", "omzetdag", "journee", "journeecommerciale"],
  product: ["product", "productname", "item", "itemname", "article", "artikel", "artikelnaam", "produit", "nomproduit", "omschrijving", "description", "name", "naam", "nom"],
  category: ["category", "categoryname", "productcategory", "categorie", "categorienaam", "productgroep", "productgroup", "group", "groep", "groupe", "famille"],
  quantity: ["quantity", "qty", "aantal", "hoeveelheid", "quantite", "qte", "nombre"],
  total: ["total", "totalincl", "totalinclvat", "totalincltax", "totalvatincluded", "amount", "amountincl", "amountinclvat", "gross", "totaal", "totaalincl", "totaalinclbtw", "bedrag", "bedraginclbtw", "montant", "montantttc", "totalttc", "prixttc"],
  vatRate: ["vat", "vatrate", "vatpct", "vatpercent", "vatpercentage", "tax", "taxrate", "btw", "btwtarief", "btwpercentage", "btwvoet", "tva", "tauxtva", "tauxdetva"],
  vatAmount: ["vatamount", "vattotal", "taxamount", "btwbedrag", "bedragbtw", "montanttva", "tvamontant"],
  payment: ["payment", "paymentmethod", "paymenttype", "paidwith", "tender", "betaalmethode", "betaalwijze", "betaling", "betaalmiddel", "paiement", "modepaiement", "modedepaiement", "moyendepaiement"],
};

const REQUIRED: readonly LightspeedColumn[] = ["receipt", "product", "total", "vatRate"];

export function normaliseHeader(h: string): string {
  return h
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

// ---------------------------------------------------------------------------
// CSV tokenising
// ---------------------------------------------------------------------------

/** The delimiter used outside quotes on the first non-empty line (`;` wins ties). */
export function detectDelimiter(csv: string): ";" | "," | "\t" {
  const counts = { ";": 0, ",": 0, "\t": 0 };
  let quoted = false;
  for (const ch of csv) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === "\n" || ch === "\r")) {
      if (counts[";"] + counts[","] + counts["\t"] > 0) break;
    } else if (!quoted && ch in counts) counts[ch as keyof typeof counts]++;
  }
  if (counts["\t"] > counts[";"] && counts["\t"] > counts[","]) return "\t";
  return counts[","] > counts[";"] ? "," : ";";
}

/** RFC 4180 records with `""` escapes, CRLF or LF line ends; each record keeps its 1-based line number. */
export function splitCsv(csv: string, delimiter: string): Array<{ line: number; cells: string[] }> {
  const text = csv.replace(/^﻿/, "");
  const out: Array<{ line: number; cells: string[] }> = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  let recordLine = 1;
  const endRecord = () => {
    cells.push(cell);
    if (cells.some((c) => c.trim() !== "")) out.push({ line: recordLine, cells });
    cells = [];
    cell = "";
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else {
        if (ch === "\n") line++;
        cell += ch;
      }
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      cells.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRecord();
      line++;
      recordLine = line;
    } else cell += ch;
  }
  if (cell !== "" || cells.length) endRecord();
  return out;
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

type Decimal = { negative: boolean; int: string; frac: string };

/**
 * A decimal as typed in a Belgian or English export: `1.234,56`, `1,234.56`, `12,5`, `12.50`,
 * `-3`, `3-`, `(3,00)`, `€ 12,50`. With one separator kind, a single separator is the decimal
 * point and repeated ones are thousands. `null` when it is not a number.
 */
export function parseDecimal(raw: string): Decimal | null {
  let s = raw.replace(/[\s  ]/g, "").replace(/€|eur$/i, "");
  if (s === "") return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith("-") || s.startsWith("+")) {
    negative = s.startsWith("-") || negative;
    s = s.slice(1);
  } else if (s.endsWith("-")) {
    negative = true;
    s = s.slice(0, -1);
  }
  s = s.replace(/€/g, "");
  if (!/^[0-9.,]+$/.test(s) || !/[0-9]/.test(s)) return null;
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  let decimalSep: "," | "." | null = null;
  if (lastComma >= 0 && lastDot >= 0) decimalSep = lastComma > lastDot ? "," : ".";
  else if (lastComma >= 0) decimalSep = s.indexOf(",") === lastComma ? "," : null;
  else if (lastDot >= 0) decimalSep = s.indexOf(".") === lastDot ? "." : null;
  let int = s;
  let frac = "";
  if (decimalSep) {
    const at = s.lastIndexOf(decimalSep);
    int = s.slice(0, at);
    frac = s.slice(at + 1);
    if (frac.includes(",") || frac.includes(".")) return null;
  }
  // Thousands separators are one kind only and group by three (`1.234.567`).
  if (/[.,]/.test(int)) {
    const sep = int.includes(",") && int.includes(".") ? null : int.includes(",") ? "," : ".";
    if (!sep || sep === decimalSep || !new RegExp(`^\\d{1,3}(\\${sep}\\d{3})*$`).test(int)) return null;
  }
  int = int.replace(/[.,]/g, "");
  if (int === "" && frac === "") return null;
  return { negative, int: int.replace(/^0+(?=\d)/, "") || "0", frac };
}

/** Rounds a decimal to `scale` digits, half up (away from zero), as a scaled integer. */
function scaled(d: Decimal, scale: number): number {
  const frac = d.frac.padEnd(scale + 1, "0");
  let n = Number(d.int) * 10 ** scale + Number(frac.slice(0, scale) || "0");
  if (Number(frac[scale]) >= 5) n += 1;
  return d.negative && n !== 0 ? -n : n;
}

/** Integer cents of an amount, or null. */
export function parseCents(raw: string): number | null {
  const d = parseDecimal(raw);
  if (!d) return null;
  const n = scaled(d, 2);
  return Number.isSafeInteger(n) ? n : null;
}

/** The quantity as `numeric(10,3)` text (`"1.500"`), or null (zero or out of range). */
export function parseQuantity(raw: string): string | null {
  const d = parseDecimal(raw);
  if (!d) return null;
  const n = scaled(d, 3);
  if (n === 0 || Math.abs(n) >= 10 ** 10) return null;
  const abs = Math.abs(n);
  return `${n < 0 ? "-" : ""}${Math.floor(abs / 1000)}.${String(abs % 1000).padStart(3, "0")}`;
}

/** A Belgian VAT rate as `"21.00"`: `21`, `21%`, `21,00 %`, `0.21`; null otherwise. */
export function parseVatRate(raw: string): string | null {
  const d = parseDecimal(raw.replace(/%/g, ""));
  if (!d || d.negative) return null;
  let hundredths = scaled(d, 2);
  // A fraction (`0.21`) is a rate of 21 %.
  if (hundredths > 0 && hundredths < 100 && !raw.includes("%")) hundredths *= 100;
  if (hundredths % 100 !== 0) return null;
  const pct = hundredths / 100;
  if (!(LIGHTSPEED_VAT_RATES as readonly number[]).includes(pct)) return null;
  return `${pct}.00`;
}

const pad = (n: number) => String(n).padStart(2, "0");

function validYmd(y: number, m: number, d: number): boolean {
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** `YYYY-MM-DD`, `DD/MM/YYYY`, `DD-MM-YYYY` or `DD.MM.YYYY` (two-digit years are 20xx). */
function parseDatePart(s: string): { y: number; m: number; d: number } | null {
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) {
    const r = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
    return validYmd(r.y, r.m, r.d) ? r : null;
  }
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(s);
  if (m) {
    const y = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const r = { y, m: Number(m[2]), d: Number(m[1]) };
    return validYmd(r.y, r.m, r.d) ? r : null;
  }
  return null;
}

function parseTimePart(s: string): { h: number; mi: number; sec: number } | null {
  const m = /^(\d{1,2})[:.hu](\d{2})(?::(\d{2})(?:\.\d+)?)?$/i.exec(s);
  if (!m) return null;
  const r = { h: Number(m[1]), mi: Number(m[2]), sec: Number(m[3] ?? "0") };
  return r.h <= 23 && r.mi <= 59 && r.sec <= 59 ? r : null;
}

/**
 * A till timestamp: Brussels wall-clock time unless the text carries `Z` or an offset
 * (ISO 8601). A date without a time is midnight Brussels. Null when unreadable.
 */
export function parseLightspeedDateTime(dateRaw: string, timeRaw?: string): Date | null {
  const text = `${dateRaw.trim()}${timeRaw?.trim() ? ` ${timeRaw.trim()}` : ""}`;
  if (/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    const at = new Date(text);
    return Number.isNaN(at.getTime()) ? null : at;
  }
  const [datePart, timePart] = text.split(/[T\s]+/, 2);
  const day = parseDatePart(datePart ?? "");
  if (!day) return null;
  const time = timePart ? parseTimePart(timePart) : { h: 0, mi: 0, sec: 0 };
  if (!time) return null;
  return new Date(new TZDate(day.y, day.m - 1, day.d, time.h, time.mi, time.sec, "Europe/Brussels").getTime());
}

/** The Brussels calendar day of an instant (`YYYY-MM-DD`). */
export function brusselsDayOf(at: Date): string {
  const z = new TZDate(at.getTime(), "Europe/Brussels");
  return `${z.getFullYear()}-${pad(z.getMonth() + 1)}-${pad(z.getDate())}`;
}

// ---------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------

/** Maps each known column to its index in the header; unknown headers are ignored. */
export function mapHeader(header: readonly string[]): Partial<Record<LightspeedColumn, number>> {
  const map: Partial<Record<LightspeedColumn, number>> = {};
  header.forEach((h, i) => {
    const n = normaliseHeader(h);
    for (const [col, aliases] of Object.entries(HEADER_ALIASES) as [LightspeedColumn, readonly string[]][]) {
      if (map[col] === undefined && aliases.includes(n)) {
        map[col] = i;
        return;
      }
    }
  });
  return map;
}

const DEFAULT_CATEGORY = "Other";
const DEFAULT_PAYMENT = "unknown";

/** Parses a Lightspeed sales export (see the file comment); never throws on content. */
export function parseLightspeedCsv(csv: string): { rows: LightspeedRow[]; errors: RowError[] } {
  const records = splitCsv(csv, detectDelimiter(csv));
  const errors: RowError[] = [];
  const rows: LightspeedRow[] = [];
  const head = records[0];
  if (!head) return { rows, errors: [{ row: 1, code: "empty_file" }] };
  const cols = mapHeader(head.cells);
  const missing: LightspeedColumn[] = REQUIRED.filter((c) => cols[c] === undefined);
  if (cols.datetime === undefined && cols.date === undefined) missing.push("datetime");
  if (missing.length) return { rows, errors: missing.map((column) => ({ row: head.line, code: "missing_column" as const, column })) };

  const nextLine = new Map<string, number>();
  const seen = new Set<string>();
  for (const record of records.slice(1)) {
    const row = record.line;
    const cell = (c: LightspeedColumn): string => {
      const i = cols[c];
      return i === undefined ? "" : (record.cells[i] ?? "").trim();
    };
    if (record.cells.length < head.cells.length && record.cells.length <= Math.max(...Object.values(cols))) {
      errors.push({ row, code: "column_count" });
      continue;
    }
    const fail = (code: LightspeedErrorCode, column?: LightspeedColumn) => errors.push(column ? { row, code, column } : { row, code });

    const receiptNumber = cell("receipt");
    if (!receiptNumber) {
      fail("receipt_missing", "receipt");
      continue;
    }
    const soldAt = cols.datetime !== undefined ? parseLightspeedDateTime(cell("datetime")) : parseLightspeedDateTime(cell("date"), cell("time"));
    if (!soldAt) {
      fail("date_invalid", cols.datetime !== undefined ? "datetime" : "date");
      continue;
    }
    let businessDayOn = brusselsDayOf(soldAt);
    if (cols.businessDay !== undefined && cell("businessDay")) {
      const d = parseDatePart(cell("businessDay").split(/[T\s]/)[0]!);
      if (!d) {
        fail("date_invalid", "businessDay");
        continue;
      }
      businessDayOn = `${d.y}-${pad(d.m)}-${pad(d.d)}`;
    }
    const productName = cell("product");
    if (!productName) {
      fail("product_missing", "product");
      continue;
    }
    const quantity = cols.quantity === undefined || cell("quantity") === "" ? "1.000" : parseQuantity(cell("quantity"));
    if (!quantity) {
      fail("quantity_invalid", "quantity");
      continue;
    }
    const totalCents = parseCents(cell("total"));
    if (totalCents === null || Math.abs(totalCents) > 100_000_000) {
      fail("total_invalid", "total");
      continue;
    }
    const vatRatePct = parseVatRate(cell("vatRate"));
    if (!vatRatePct) {
      fail("vat_rate_invalid", "vatRate");
      continue;
    }
    let vatCents = vatOf(totalCents, vatRatePct);
    if (cols.vatAmount !== undefined && cell("vatAmount") !== "") {
      const given = parseCents(cell("vatAmount"));
      if (given === null || Math.abs(given) > Math.abs(totalCents) || (given !== 0 && Math.sign(given) !== Math.sign(totalCents))) {
        fail("vat_amount_invalid", "vatAmount");
        continue;
      }
      vatCents = given;
    }
    let lineNumber: number;
    if (cols.line !== undefined && cell("line") !== "") {
      lineNumber = Number(cell("line"));
      if (!Number.isInteger(lineNumber) || lineNumber < 0) {
        fail("line_invalid", "line");
        continue;
      }
    } else {
      lineNumber = (nextLine.get(receiptNumber) ?? 0) + 1;
    }
    nextLine.set(receiptNumber, Math.max(lineNumber, nextLine.get(receiptNumber) ?? 0));
    const externalLineKey = `${receiptNumber}:${lineNumber}`;
    if (seen.has(externalLineKey)) {
      fail("duplicate_line", cols.line !== undefined ? "line" : "receipt");
      continue;
    }
    seen.add(externalLineKey);
    rows.push({
      row,
      externalLineKey,
      receiptNumber,
      lineNumber,
      businessDayOn,
      soldAt,
      productName: productName.slice(0, 300),
      category: (cell("category") || DEFAULT_CATEGORY).slice(0, 120),
      quantity,
      totalCents,
      vatRatePct,
      vatCents,
      paymentMethod: (cell("payment") || DEFAULT_PAYMENT).slice(0, 60),
    });
  }
  return { rows, errors };
}

/** The first and last business day of the parsed rows (null when there are none). */
export function businessDayRange(rows: readonly Pick<LightspeedRow, "businessDayOn">[]): { from: string; to: string } | null {
  if (!rows.length) return null;
  let from = rows[0]!.businessDayOn;
  let to = from;
  for (const r of rows) {
    if (r.businessDayOn < from) from = r.businessDayOn;
    if (r.businessDayOn > to) to = r.businessDayOn;
  }
  return { from, to };
}
