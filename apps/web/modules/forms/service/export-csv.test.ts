/**
 * forms-P6: the staff CSV export (forms spec section 5 `submissions/export`, SE4): no sensitive
 * column and the CSV injection guard (cells starting with `=`, `+`, `-`, `@` are prefixed with `'`).
 */
import { describe, expect, it } from "vitest";
import { recoveryCheckSeed, deriveSensitiveKeys, type FormDefinition } from "@beam/core/forms";
import { csvCell, exportFields, toCsvText, toSubmissionCsv, type SubmissionExportRow } from "./export-csv";

const seed = recoveryCheckSeed({ baseUrl: "https://www.example.com" });
const version = {
  definition: seed.definition as unknown as Record<string, unknown>,
  scoring: seed.scoring as unknown as Record<string, unknown>,
  sensitiveFieldKeys: deriveSensitiveKeys(seed.definition, seed.scoring),
};

function row(over: Partial<SubmissionExportRow> = {}): SubmissionExportRow {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    status: "completed",
    startedAt: new Date("2026-11-04T08:00:00Z"),
    completedAt: new Date("2026-11-04T08:05:00Z"),
    version: 1,
    locale: "en",
    personEmail: "lotte@example.com",
    personFirstName: "Lotte",
    personLastName: "Peeters",
    outcomeKey: null,
    total: 12,
    source: "website",
    campaign: null,
    funnel: "form:recovery-check",
    utm: { source: "facebook", medium: "paid_social" },
    landingPath: "/nl/f/recovery-check",
    linkName: null,
    enteredByStaff: false,
    answers: { email: "lotte@example.com", first_name: "Lotte", movement: "rarely" },
    ...over,
  };
}

/** A minimal RFC 4180 parser for the assertions (quoted cells, doubled quotes, CRLF). */
function parse(csv: string): string[][] {
  const out: string[][] = [];
  let rowCells: string[] = [];
  let cell = "";
  let quoted = false;
  const text = csv.replace(/^﻿/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      rowCells.push(cell);
      cell = "";
    } else if (c === "\r" && text[i + 1] === "\n") {
      rowCells.push(cell);
      out.push(rowCells);
      rowCells = [];
      cell = "";
      i++;
    } else cell += c;
  }
  return out;
}

describe("toSubmissionCsv", () => {
  it("has no column for a sensitive field (SE4), but one for every non-sensitive field", () => {
    const def = seed.definition as FormDefinition;
    const sensitive = Object.values(def.fields).filter((f) => f.sensitive || version.sensitiveFieldKeys.includes(f.key));
    expect(sensitive.length).toBeGreaterThan(0);
    const [header] = parse(toSubmissionCsv([row()], version, "en"));
    for (const f of sensitive) expect(header!.some((h) => h.endsWith(`(${f.key})`))).toBe(false);
    const plain = exportFields(def, version.sensitiveFieldKeys);
    expect(plain.length).toBeGreaterThan(0);
    for (const f of plain) expect(header!.some((h) => h.endsWith(`(${f.key})`))).toBe(true);
  });

  it("never writes a sensitive value even when a row carries one by mistake", () => {
    const leaked = row({ answers: { email: "a@example.com", sleep_hours: "lt5", stress_level: 9 } });
    const csv = toSubmissionCsv([leaked], version, "en");
    expect(csv).not.toContain("lt5");
    expect(parse(csv)[1]).not.toContain("9");
  });

  it("writes option labels in the export locale, the outcome label and staff entry", () => {
    const def = seed.definition as FormDefinition;
    const movement = def.fields.movement as Extract<FormDefinition["fields"][string], { type: "single_choice" }>;
    const outcome = seed.scoring.outcomes[0]!;
    const csv = parse(toSubmissionCsv([row({ outcomeKey: outcome.key, enteredByStaff: true })], version, "fr-BE"));
    const [header, data] = csv as [string[], string[]];
    const col = header.findIndex((h) => h.endsWith("(movement)"));
    expect(data[col]).toBe(movement.options.find((o) => o.key === "rarely")!.label["fr-BE"]);
    expect(data).toContain(outcome.label["fr-BE"]);
    expect(header[0]).toBe("Id de la réponse");
    expect(data[1]).toBe("Terminé");
    expect(data[2]).toBe("2026-11-04 09:00");
  });

  it("CSV injection guard: text cells starting with =, +, -, @ are prefixed with '", () => {
    for (const bad of ["=HYPERLINK(\"http://x\")", "+1+1", "-2+3", "@SUM(A1)", "\t=1"]) expect(csvCell(bad)).toBe(`"'${bad.replace(/"/g, '""')}"`);
    expect(csvCell("plain")).toBe('"plain"');
    expect(csvCell(-5)).toBe('"-5"');
    expect(csvCell(null)).toBe('""');
    const csv = parse(toSubmissionCsv([row({ personFirstName: "=cmd|' /C calc'!A0", campaign: "@evil", answers: { first_name: "+danger", email: "-x@example.com" } })], version, "en"));
    const [header, data] = csv as [string[], string[]];
    expect(data).toContain("'=cmd|' /C calc'!A0");
    expect(data).toContain("'@evil");
    expect(data[header.findIndex((h) => h.endsWith("(first_name)"))]).toBe("'+danger");
    expect(data[header.findIndex((h) => h.endsWith("(email)"))]).toBe("'-x@example.com");
    for (const cell of data) expect(cell).not.toMatch(/^[=+\-@]/);
  });

  it("quotes commas, quotes and new lines, and ends lines with CRLF", () => {
    const text = toCsvText(["a", "b"], [["x, \"y\"", "line1\nline2"]]);
    expect(text.startsWith("﻿")).toBe(true);
    expect(text).toBe('﻿"a","b"\r\n"x, ""y""","line1\nline2"\r\n');
    expect(parse(text)[1]).toEqual(['x, "y"', "line1\nline2"]);
  });
});
