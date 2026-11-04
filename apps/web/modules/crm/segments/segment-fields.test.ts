/**
 * crm-P5: every `SEGMENT_ALLOWED_FIELDS` column exists in ops' `PERSON_PROFILE_COLUMNS` (or in
 * the fixture until ops lands) with a compatible type, and in the real `v_person_profile` view;
 * no field is a sensitive column, a contact column or a name (rules 3.23, 3.27).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { SEGMENT_ALLOWED_FIELDS, SEGMENT_FIELDS, SEGMENT_R2_FIELDS } from "@beam/core/crm";
import * as ops from "@beam/core/ops";
import { sql } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { PROFILE_FIXTURE_COLUMNS } from "./test-fixtures";

type ProfileColumn = { name: string; type: string; release: "V1" | "R2" };
const opsColumns = (ops as { PERSON_PROFILE_COLUMNS?: readonly ProfileColumn[] }).PERSON_PROFILE_COLUMNS;
const profileColumns: readonly ProfileColumn[] = opsColumns ?? PROFILE_FIXTURE_COLUMNS.map((name) => ({ name, type: "unknown", release: "V1" as const }));

const COMPATIBLE: Record<string, readonly string[]> = {
  enum: ["text", "locale", "unknown"],
  text: ["text", "unknown"],
  number: ["integer", "unknown"],
  timestamp: ["timestamptz", "date", "unknown"],
  "text[]": ["text[]", "uuid[]", "unknown"],
  boolean: ["boolean", "unknown"],
};

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  await h.close();
});

describe("SEGMENT_ALLOWED_FIELDS", () => {
  it("every field is a V1 column of PERSON_PROFILE_COLUMNS with a compatible type", () => {
    const byName = new Map(profileColumns.map((c) => [c.name, c]));
    const missing = SEGMENT_ALLOWED_FIELDS.filter((c) => !byName.has(c));
    expect(missing).toEqual([]);
    for (const field of SEGMENT_FIELDS) {
      const col = byName.get(field.column)!;
      expect({ column: field.column, release: col.release }).toEqual({ column: field.column, release: "V1" });
      expect(COMPATIBLE[field.type], `${field.column}: ${field.type} vs ${col.type}`).toContain(col.type);
    }
  });

  it("the R2 webinar fields are planned columns of PERSON_PROFILE_COLUMNS", () => {
    if (!opsColumns) return;
    const names = new Set(opsColumns.map((c) => c.name));
    expect(SEGMENT_R2_FIELDS.map((f) => f.column).filter((c) => !names.has(c))).toEqual([]);
  });

  it("every field is a column of the v_person_profile view in the database", async () => {
    const rows = rowsOf<{ column_name: string }>(
      await h.db.execute(sql`select column_name from information_schema.columns where table_name = 'v_person_profile'`),
    );
    const viewColumns = new Set(rows.map((r) => r.column_name));
    expect(viewColumns.has("person_id")).toBe(true);
    expect(SEGMENT_ALLOWED_FIELDS.filter((c) => !viewColumns.has(c))).toEqual([]);
  });

  it("holds no contact, name, birth or sensitive column", () => {
    const forbidden = ["email", "email_hash", "phone", "phone_e164", "first_name", "last_name", "birth_on", "address", "emergency_contact", "value_enc", "data"];
    expect(SEGMENT_ALLOWED_FIELDS.filter((c) => forbidden.includes(c))).toEqual([]);
    for (const field of SEGMENT_FIELDS) expect(field.label).toBe(`crm.segments.fields.${field.column}`);
  });
});

describe("builder labels", () => {
  it("every field, comparator, event kind and data key label exists in all three catalogues", async () => {
    const { segmentBuilderLabels } = await import("./queries");
    const { softTranslator, translator } = await import("@/lib/i18n");
    for (const locale of ["nl-BE", "fr-BE", "en"] as const) {
      const labels = segmentBuilderLabels(translator(locale), softTranslator(locale), []);
      expect(Object.keys(labels.fields)).toEqual([...SEGMENT_ALLOWED_FIELDS]);
      for (const v of [...Object.values(labels.fields), ...Object.values(labels.comparators), ...Object.values(labels.eventKinds), ...Object.values(labels.dataKeys)]) {
        expect(v).not.toMatch(/^⟦|^crm\./);
      }
      expect(labels.plural.count.other).toContain("7");
      expect(labels.fieldOptions.status!.map((o) => o.value)).toEqual(["lead", "customer", "member"]);
    }
  });
});
