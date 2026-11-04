/**
 * forms-P3: sensitive data never leaves `form_sensitive_answers` (forms spec section 9, SE4,
 * acceptance "Sensitive free text is excluded from AI"): the encrypted column is registered,
 * no forms column is an AI field, the only form-derived segment fields are ops' two profile
 * columns, and the event data keys segments read hold no answer.
 */
import { describe, expect, it } from "vitest";
import { getTableColumns, getTableName } from "drizzle-orm";
import { SENSITIVE_COLUMNS } from "@beam/db";
import { formImportEvents, formImportSources, formLinks, forms, formSensitiveAnswers, formSubmissions, formVersions, formViewsDaily } from "@beam/db/schema";
import { AI_ALLOWED_FIELDS } from "@beam/core/ai";
import { SEGMENT_ALLOWED_FIELDS, SEGMENT_EVENT_DATA_KEYS } from "@beam/core/crm";
import { events } from "./events";

const FORMS_TABLES = [forms, formVersions, formSubmissions, formSensitiveAnswers, formLinks, formViewsDaily, formImportSources, formImportEvents];
const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

describe("forms sensitive data boundaries", () => {
  it("form_sensitive_answers.value_enc is in SENSITIVE_COLUMNS", () => {
    expect(SENSITIVE_COLUMNS).toContainEqual({ table: "form_sensitive_answers", column: "value_enc", keyColumn: "key_version" });
  });

  it("no forms column appears in AI_ALLOWED_FIELDS", () => {
    const columns = new Set<string>();
    for (const t of FORMS_TABLES) {
      for (const k of Object.keys(getTableColumns(t))) {
        if (["id", "createdAt", "updatedAt", "status", "locale"].includes(k)) continue;
        columns.add(snake(k));
        columns.add(`${getTableName(t)}.${snake(k)}`);
      }
    }
    for (const field of AI_ALLOWED_FIELDS) expect(columns.has(field), field).toBe(false);
    expect(AI_ALLOWED_FIELDS.some((f) => /form|assessment|answer|score|outcome|sleep|stress/.test(f))).toBe(false);
  });

  it("the only form-derived segment fields are ops' last assessment slug and outcome", () => {
    const formish = SEGMENT_ALLOWED_FIELDS.filter((f) => /form|assessment|answer|score|outcome|sensitive|sleep|stress|health/.test(f));
    expect([...formish].sort()).toEqual(["last_assessment_form_slug", "last_assessment_outcome_key"]);
  });

  it("segment event rules on form.* and assessment.* kinds read keys whose values are never answers", () => {
    const kinds = Object.keys(SEGMENT_EVENT_DATA_KEYS).filter((k) => k.startsWith("form.") || k.startsWith("assessment."));
    expect(kinds.sort()).toEqual(events.map((e) => e.kind).sort());
    const allowed = new Set(["form_slug", "outcome_key", "funnel", "form_kind", "cta_key", "source"]);
    for (const k of kinds) for (const key of (SEGMENT_EVENT_DATA_KEYS as Record<string, readonly string[]>)[k]!) expect(allowed.has(key), `${k}.${key}`).toBe(true);
  });

  it("every forms event is non-sensitive with a strict schema that refuses extra keys", () => {
    for (const e of events) {
      expect(e.isSensitive).toBe(false);
      const parsed = e.data.safeParse({ sleep_hours: "5_6" });
      expect(parsed.success).toBe(false);
    }
    const completed = events.find((e) => e.kind === "form.completed")!;
    const shape = Object.keys((completed.data as unknown as { shape: Record<string, unknown> }).shape);
    expect(shape).not.toContain("answers");
  });
});
