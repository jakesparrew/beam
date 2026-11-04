/**
 * The crm catalogue covers every label the pure core names (crm spec 8): segment fields,
 * comparators, event kinds and data keys, and every enum value. `pnpm i18n:check` keeps the
 * three locales in step; this test keeps the catalogue in step with the code.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { COMPARATORS, SEGMENT_ALLOWED_EVENT_KINDS, SEGMENT_EVENT_DATA_KEYS, SEGMENT_FIELDS, SEGMENT_R2_FIELDS } from "./segments/fields";
import { ACQUISITION_SOURCES, CONSENT_METHODS, CONSENT_PURPOSES, DUPLICATE_REASONS, PERSON_STATUSES, SUPPRESSION_REASONS, SUPPRESSION_SCOPES, TIMELINE_CATEGORIES } from "./types";

const dir = path.join(import.meta.dirname, "../i18n/messages");
const flat = (locale: string): Map<string, string> => {
  const out = new Map<string, string>();
  const walk = (node: unknown, prefix: string) => {
    if (node && typeof node === "object") for (const [k, v] of Object.entries(node)) walk(v, prefix ? `${prefix}.${k}` : k);
    else out.set(prefix, String(node));
  };
  walk(JSON.parse(readFileSync(path.join(dir, locale, "crm.json"), "utf8")), "");
  return out;
};

describe("crm catalogue", () => {
  const en = flat("en");

  it("has a label for every segment field, comparator, event kind and data key", () => {
    for (const f of [...SEGMENT_FIELDS, ...SEGMENT_R2_FIELDS]) expect(en.has(f.label), f.label).toBe(true);
    for (const c of COMPARATORS) expect(en.has(`crm.segments.comparators.${c}`), c).toBe(true);
    for (const k of SEGMENT_ALLOWED_EVENT_KINDS) expect(en.has(`crm.segments.event_kinds.${k.replace(".", "_")}`), k).toBe(true);
    for (const keys of Object.values(SEGMENT_EVENT_DATA_KEYS)) for (const k of keys) expect(en.has(`crm.segments.data_keys.${k}`), k).toBe(true);
  });

  it("has a label for every enum value and timeline category", () => {
    const enums: Record<string, readonly string[]> = {
      person_status: PERSON_STATUSES,
      consent_purpose: CONSENT_PURPOSES,
      consent_method: CONSENT_METHODS,
      suppression_scope: SUPPRESSION_SCOPES,
      suppression_reason: SUPPRESSION_REASONS,
      acquisition_source: ACQUISITION_SOURCES,
      duplicate_reason: DUPLICATE_REASONS,
      consent_outcome: ["recorded", "unchanged", "needs_confirmation", "skipped_suppressed", "skipped_minor"],
    };
    for (const [name, values] of Object.entries(enums)) for (const v of values) expect(en.has(`crm.enums.${name}.${v}`), `${name}.${v}`).toBe(true);
    for (const c of TIMELINE_CATEGORIES) expect(en.has(`crm.timeline.categories.${c}`), c).toBe(true);
  });

  it("keeps the same keys in nl-BE and fr-BE", () => {
    for (const locale of ["nl-BE", "fr-BE"]) expect([...flat(locale).keys()].sort()).toEqual([...en.keys()].sort());
  });
});
