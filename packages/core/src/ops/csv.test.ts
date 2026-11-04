import { describe, expect, it } from "vitest";
import { CsvParseError, collectBytes, csvCell, detectDelimiter, parseCsvRows, parseCsvStream, toCsv } from "./csv";

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { ignoreBOM: true });

async function text(stream: AsyncIterable<Uint8Array>): Promise<string> {
  return dec.decode(await collectBytes(stream));
}

async function records(parts: Uint8Array[], delimiter: "," | ";" | "\t" = ","): Promise<Record<string, string>[]> {
  const out: Record<string, string>[] = [];
  for await (const r of parseCsvStream(parts, { delimiter })) out.push(r);
  return out;
}

async function* asyncRows(rows: unknown[][]): AsyncIterable<unknown[]> {
  await Promise.resolve();
  for (const r of rows) yield r;
}

/** Splits bytes into parts of `size` (cuts through multi-byte characters on purpose). */
function split(bytes: Uint8Array, size: number): Uint8Array[] {
  const parts: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) parts.push(bytes.slice(i, i + size));
  return parts;
}

describe("toCsv", () => {
  it("writes a BOM, the header and CRLF rows", async () => {
    const out = await text(toCsv(["a", "b"], [[1, "x"], [null, true]]));
    expect(out).toBe("﻿a,b\r\n1,x\r\n,true\r\n");
  });

  it("quotes delimiters, quotes and newlines only when needed", async () => {
    const out = await text(toCsv(["v"], [["plain"], ["a,b"], ['say "hi"'], ["line1\nline2"], ["cr\rx"]], { bom: false }));
    expect(out).toBe('v\r\nplain\r\n"a,b"\r\n"say ""hi"""\r\n"line1\nline2"\r\n"cr\rx"\r\n');
  });

  it("uses the `;` delimiter and then leaves commas unquoted", async () => {
    const out = await text(toCsv(["naam", "bedrag"], [["Jansen, An", "12,50"]], { delimiter: ";", bom: false }));
    expect(out).toBe("naam;bedrag\r\nJansen, An;12,50\r\n");
  });

  it("formats dates as ISO and objects as JSON, and neutralises formulas but not numbers", () => {
    expect(csvCell(new Date("2026-11-04T10:00:00Z"))).toBe("2026-11-04T10:00:00.000Z");
    expect(csvCell({ nl: "x" })).toBe('"{""nl"":""x""}"');
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("-12.5")).toBe("-12.5");
    expect(csvCell(-3)).toBe("-3");
  });

  it("accepts async rows and flushes large outputs in several chunks", async () => {
    const rows = Array.from({ length: 3000 }, (_, i) => [i, "x".repeat(40)]);
    const chunks: Uint8Array[] = [];
    for await (const c of toCsv(["i", "pad"], asyncRows(rows))) chunks.push(c);
    expect(chunks.length).toBeGreaterThan(1);
    const parsed = await records(chunks);
    expect(parsed).toHaveLength(3000);
    expect(parsed[2999]).toEqual({ i: "2999", pad: "x".repeat(40) });
  });
});

describe("parseCsvStream", () => {
  it("strips the BOM and keys rows by the header", async () => {
    expect(await records([enc.encode("﻿email,name\r\na@example.com,An\r\n")])).toEqual([{ email: "a@example.com", name: "An" }]);
  });

  it("handles quotes, embedded delimiters, escaped quotes and newlines", async () => {
    const csv = 'a,b\n"x, y","say ""hi"""\n"multi\nline",z\n';
    expect(await records([enc.encode(csv)])).toEqual([
      { a: "x, y", b: 'say "hi"' },
      { a: "multi\nline", b: "z" },
    ]);
  });

  it("reads the `;` delimiter and tabs", async () => {
    expect(await records([enc.encode("a;b\n1,5;2\n")], ";")).toEqual([{ a: "1,5", b: "2" }]);
    expect(await records([enc.encode("a\tb\n1\t2\n")], "\t")).toEqual([{ a: "1", b: "2" }]);
  });

  it("accepts LF, CRLF and CR line ends and skips blank lines", async () => {
    expect(await records([enc.encode("a\r\n1\r\n\r\n2\r3\n")])).toEqual([{ a: "1" }, { a: "2" }, { a: "3" }]);
  });

  it("decodes characters split across parts and CRLF split across parts", async () => {
    const bytes = enc.encode("﻿naam,stad\r\nZoë,Liège\r\nÉmile,Brussel\r\n");
    for (const size of [1, 2, 3, 5, 7]) {
      expect(await records(split(bytes, size)), `parts of ${size}`).toEqual([
        { naam: "Zoë", stad: "Liège" },
        { naam: "Émile", stad: "Brussel" },
      ]);
    }
  });

  it("fills missing trailing fields and refuses extra fields", async () => {
    expect(await records([enc.encode("a,b,c\n1\n")])).toEqual([{ a: "1", b: "", c: "" }]);
    await expect(records([enc.encode("a\n1,2\n")])).rejects.toBeInstanceOf(CsvParseError);
  });

  it("refuses an unterminated quote, a duplicate or an empty header", async () => {
    await expect(records([enc.encode('a\n"open\n')])).rejects.toThrow(/unterminated/);
    await expect(records([enc.encode("a,a\n1,2\n")])).rejects.toThrow(/duplicate/);
    await expect(records([enc.encode("a,,c\n1,2,3\n")])).rejects.toThrow(/empty column/);
  });

  it("reads a last row without a line end", async () => {
    expect(await records([enc.encode('a,b\n1,"2"')])).toEqual([{ a: "1", b: "2" }]);
  });

  it("parseCsvRows yields the header too", async () => {
    const rows: string[][] = [];
    for await (const r of parseCsvRows([enc.encode("h1,h2\nv1,v2\n")], { delimiter: "," })) rows.push(r);
    expect(rows).toEqual([
      ["h1", "h2"],
      ["v1", "v2"],
    ]);
  });

  it("detects the delimiter of a header line", () => {
    expect(detectDelimiter("a;b;c")).toBe(";");
    expect(detectDelimiter("a\tb")).toBe("\t");
    expect(detectDelimiter('"x;y",b,c')).toBe(",");
    expect(detectDelimiter("single")).toBe(",");
  });
});

describe("round trip", () => {
  it("toCsv then parseCsvStream gives back every value, for both delimiters", async () => {
    const columns = ["id", "naam", "notitie", "bedrag"];
    const rows = [
      ["1", "Jansen, An", 'Zei "ja"', "12,50"],
      ["2", "Dupont", "regel 1\r\nregel 2", ""],
      ["3", "Zoë", "", "0"],
    ];
    for (const delimiter of [",", ";"] as const) {
      const bytes = await collectBytes(toCsv(columns, rows, { delimiter }));
      const back = await records(split(bytes, 4), delimiter);
      expect(back).toEqual(rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]]))));
    }
  });
});
