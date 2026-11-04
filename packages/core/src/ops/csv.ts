/**
 * Streaming CSV (RFC 4180) for imports, report downloads and exports (ops rules 41, 42, 55).
 * Pure: Web streams primitives only (`TextEncoder`, `TextDecoder`), no Node APIs.
 *
 * - `toCsv` writes a header and the rows as UTF-8 with a BOM (Excel opens it in every locale),
 *   CRLF line ends, and quotes a field only when it holds the delimiter, a quote, CR or LF.
 *   Text that starts with `=`, `+`, `-`, `@`, tab or CR and is not a number gets a leading `'`
 *   so spreadsheets never evaluate it (CSV injection).
 * - `parseCsvStream` reads parts in order (a multi-byte character may span two parts), drops a
 *   leading BOM, accepts CRLF, LF or CR line ends and quoted fields with embedded delimiters,
 *   quotes (`""`) and line breaks, and yields one record per row keyed by the header.
 */

export type CsvDelimiter = "," | ";" | "\t";

export class CsvParseError extends Error {
  override readonly name = "CsvParseError";
  constructor(
    message: string,
    readonly row: number,
  ) {
    super(message);
  }
}

const BOM = "﻿";
const FLUSH_AT = 64 * 1024;
const NUMERIC = /^[+-]?(\d+([.,]\d*)?|[.,]\d+)([eE][+-]?\d+)?$/;
const FORMULA_START = /^[=+\-@\t\r]/;

/** The text of one cell. */
export function csvCell(value: unknown, delimiter: CsvDelimiter = ","): string {
  let text: string;
  if (value === null || value === undefined) text = "";
  else if (value instanceof Date) text = value.toISOString();
  else if (typeof value === "string") text = FORMULA_START.test(value) && !NUMERIC.test(value) ? `'${value}` : value;
  else if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") text = String(value);
  else text = JSON.stringify(value);
  if (text.includes(delimiter) || text.includes('"') || text.includes("\n") || text.includes("\r")) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

/** One CSV line with its CRLF. */
export function csvLine(values: readonly unknown[], delimiter: CsvDelimiter = ","): string {
  return `${values.map((v) => csvCell(v, delimiter)).join(delimiter)}\r\n`;
}

async function* iterate<T>(rows: AsyncIterable<T> | Iterable<T>): AsyncIterable<T> {
  for await (const row of rows) yield row;
}

/** Header plus rows as UTF-8 chunks of about 64 KB. */
export async function* toCsv(
  columns: string[],
  rows: AsyncIterable<unknown[]> | unknown[][],
  opts: { delimiter?: CsvDelimiter; bom?: boolean } = {},
): AsyncIterable<Uint8Array> {
  const delimiter = opts.delimiter ?? ",";
  const encoder = new TextEncoder();
  let buffer = (opts.bom === false ? "" : BOM) + csvLine(columns, delimiter);
  for await (const row of iterate(rows)) {
    buffer += csvLine(row, delimiter);
    if (buffer.length >= FLUSH_AT) {
      yield encoder.encode(buffer);
      buffer = "";
    }
  }
  if (buffer) yield encoder.encode(buffer);
}

/** The delimiter of a header line: the most frequent of `,`, `;` and tab outside quotes. */
export function detectDelimiter(headerLine: string): CsvDelimiter {
  const counts: Record<CsvDelimiter, number> = { ",": 0, ";": 0, "\t": 0 };
  let quoted = false;
  for (const ch of headerLine) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === "," || ch === ";" || ch === "\t")) counts[ch] += 1;
  }
  const [best, count] = (Object.entries(counts) as [CsvDelimiter, number][]).sort((a, b) => b[1] - a[1])[0]!;
  return count > 0 ? best : ",";
}

/** Rows as arrays of fields, header included. */
export async function* parseCsvRows(parts: AsyncIterable<Uint8Array> | Iterable<Uint8Array>, opts: { delimiter: CsvDelimiter }): AsyncIterable<string[]> {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const d = opts.delimiter;
  let first = true;
  let field = "";
  let row: string[] = [];
  let quoted = false;
  /** A quote just closed inside a quoted field (the next char decides: `"` escape or end). */
  let quoteEnd = false;
  /** The previous char was a CR outside quotes (a following LF belongs to it). */
  let afterCr = false;
  let rowNo = 0;

  function* endRow(): Generator<string[]> {
    row.push(field);
    field = "";
    rowNo += 1;
    const out = row;
    row = [];
    if (!(out.length === 1 && out[0] === "")) yield out;
  }

  function* feed(text: string): Generator<string[]> {
    for (const ch of text) {
      if (afterCr) {
        afterCr = false;
        if (ch === "\n") continue;
      }
      if (quoted) {
        if (quoteEnd) {
          quoteEnd = false;
          if (ch === '"') {
            field += '"';
            continue;
          }
          quoted = false;
          // fall through: the char after the closing quote
        } else if (ch === '"') {
          quoteEnd = true;
          continue;
        } else {
          field += ch;
          continue;
        }
      }
      if (ch === '"' && field === "") quoted = true;
      else if (ch === d) {
        row.push(field);
        field = "";
      } else if (ch === "\n") yield* endRow();
      else if (ch === "\r") {
        afterCr = true;
        yield* endRow();
      } else field += ch;
    }
  }

  for await (const part of iterate(parts)) {
    let text = decoder.decode(part, { stream: true });
    if (first && text.length) {
      if (text.startsWith(BOM)) text = text.slice(1);
      first = false;
    }
    yield* feed(text);
  }
  let tail = decoder.decode();
  if (first && tail.startsWith(BOM)) tail = tail.slice(1);
  yield* feed(tail);
  if (quoted && !quoteEnd) throw new CsvParseError("unterminated quoted field", rowNo + 1);
  if (quoteEnd) quoted = false;
  if (field !== "" || row.length) yield* endRow();
}

/**
 * Records keyed by the header row. Missing trailing fields are empty strings; a row with more
 * fields than the header, an empty header or a duplicate header raises `CsvParseError`.
 */
export async function* parseCsvStream(
  parts: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  opts: { delimiter: CsvDelimiter },
): AsyncIterable<Record<string, string>> {
  let header: string[] | null = null;
  let n = 0;
  for await (const fields of parseCsvRows(parts, opts)) {
    n += 1;
    if (!header) {
      header = fields.map((h) => h.trim());
      const seen = new Set<string>();
      for (const h of header) {
        if (!h) throw new CsvParseError("empty column name in the header", 1);
        if (seen.has(h)) throw new CsvParseError(`duplicate column "${h}" in the header`, 1);
        seen.add(h);
      }
      continue;
    }
    if (fields.length > header.length) throw new CsvParseError(`row has ${fields.length} fields, the header has ${header.length}`, n);
    const record: Record<string, string> = {};
    header.forEach((h, i) => {
      record[h] = fields[i] ?? "";
    });
    yield record;
  }
}

/** Collects an async byte stream (tests and small files). */
export async function collectBytes(parts: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const p of parts) {
    chunks.push(p);
    size += p.length;
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
