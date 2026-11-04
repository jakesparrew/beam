"use client";
/**
 * Field rules of the segment builder (crm spec 4.6, 5.1): a `v_person_profile` field from
 * `SEGMENT_FIELDS`, the comparators its type allows, and a typed value input. Also holds the
 * builder's shared label and option types. Every string is a prop.
 */
import { COMPARATORS_BY_TYPE, SEGMENT_FIELD_BY_COLUMN, SEGMENT_FIELDS, type SegmentRule } from "@beam/core/crm";
import { Input } from "@beam/ui";

export type Option = { value: string; label: string };

export type SegmentBuilderLabels = {
  /** The plain strings of `crm.segments.builder.*` (keys without the prefix). */
  builder: Record<string, string>;
  /** `crm.segments.builder.count`, `event_min_count` and `event_within_days` rendered for 1 and 7 (the client swaps the number). */
  plural: Record<"count" | "minCount" | "withinDays", { one: string; other: string }>;
  comparators: Record<string, string>;
  fields: Record<string, string>;
  /** Option lists of enum fields (and `tags`), keyed by column. */
  fieldOptions: Record<string, Option[]>;
  eventKinds: Record<string, string>;
  dataKeys: Record<string, string>;
  purposes: Option[];
  kinds: Option[];
  modes: Option[];
  tags: Option[];
  common: Record<"save" | "saving" | "cancel" | "error" | "yes" | "no" | "loading" | "search" | "open" | "required", string>;
};

export type FieldRule = Extract<SegmentRule, { type: "field" }>;

export const selectClass =
  "h-9 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** Swaps the sample number 7 of a pre-rendered plural for `n`. */
export function plural(forms: { one: string; other: string }, n: number): string {
  return n === 1 ? forms.one : forms.other.replace("7", String(n));
}

const listOf = (text: string) =>
  text
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

/** The default value a comparator expects for a field type. */
function defaultValue(type: string, cmp: string, options?: Option[]): unknown {
  if (["is_null", "is_not_null", "is_true", "is_false"].includes(cmp)) return undefined;
  if (cmp === "between") return [0, 1];
  if (["within_last_days", "more_than_days_ago", "within_next_days"].includes(cmp)) return 30;
  if (["before", "after"].includes(cmp)) return new Date().toISOString().slice(0, 10) + "T00:00:00.000Z";
  if (["in", "not_in", "contains_any", "contains_all", "contains_none"].includes(cmp)) return options?.[0] ? [options[0].value] : [];
  if (type === "number") return 0;
  return options?.[0]?.value ?? "";
}

export function newFieldRule(labels: SegmentBuilderLabels): FieldRule {
  const field = SEGMENT_FIELDS[0]!;
  const cmp = COMPARATORS_BY_TYPE[field.type][0];
  return { type: "field", field: field.column, cmp, value: defaultValue(field.type, cmp, labels.fieldOptions[field.column]) };
}

export function FieldPicker({ rule, onChange, labels, idPrefix }: { rule: FieldRule; onChange: (rule: FieldRule) => void; labels: SegmentBuilderLabels; idPrefix: string }) {
  const field = SEGMENT_FIELD_BY_COLUMN[rule.field] ?? SEGMENT_FIELDS[0]!;
  const comparators = COMPARATORS_BY_TYPE[field.type] as readonly string[];
  const options = labels.fieldOptions[field.column];

  const setField = (column: string) => {
    const next = SEGMENT_FIELD_BY_COLUMN[column]!;
    const cmp = COMPARATORS_BY_TYPE[next.type][0];
    onChange({ type: "field", field: column, cmp, value: defaultValue(next.type, cmp, labels.fieldOptions[column]) });
  };
  const setCmp = (cmp: string) => onChange({ ...rule, cmp: cmp as FieldRule["cmp"], value: defaultValue(field.type, cmp, options) });
  const setValue = (value: unknown) => onChange({ ...rule, value });

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select id={`${idPrefix}-field`} aria-label={labels.builder.rule_field} className={selectClass} value={field.column} onChange={(e) => setField(e.target.value)}>
        {SEGMENT_FIELDS.map((f) => (
          <option key={f.column} value={f.column}>
            {labels.fields[f.column] ?? f.column}
          </option>
        ))}
      </select>
      <select aria-label={labels.builder.value} className={selectClass} value={rule.cmp} onChange={(e) => setCmp(e.target.value)}>
        {comparators.map((c) => (
          <option key={c} value={c}>
            {labels.comparators[c] ?? c}
          </option>
        ))}
      </select>
      <ValueInput type={field.type} cmp={rule.cmp} value={rule.value} options={options} onChange={setValue} labels={labels} />
    </div>
  );
}

function ValueInput({
  type,
  cmp,
  value,
  options,
  onChange,
  labels,
}: {
  type: string;
  cmp: string;
  value: unknown;
  options?: Option[];
  onChange: (value: unknown) => void;
  labels: SegmentBuilderLabels;
}) {
  if (["is_null", "is_not_null", "is_true", "is_false"].includes(cmp)) return null;
  const b = labels.builder;
  if (cmp === "between") {
    const [lo, hi] = Array.isArray(value) ? (value as number[]) : [0, 1];
    return (
      <span className="flex items-center gap-2">
        <Input type="number" aria-label={b.from} className="w-28" value={lo} onChange={(e) => onChange([Number(e.target.value), hi])} />
        <Input type="number" aria-label={b.to} className="w-28" value={hi} onChange={(e) => onChange([lo, Number(e.target.value)])} />
      </span>
    );
  }
  if (["within_last_days", "more_than_days_ago", "within_next_days"].includes(cmp)) {
    return <Input type="number" min={1} max={3650} aria-label={b.days} className="w-24" value={Number(value ?? 30)} onChange={(e) => onChange(Math.trunc(Number(e.target.value)))} />;
  }
  if (cmp === "before" || cmp === "after") {
    const day = typeof value === "string" ? value.slice(0, 10) : "";
    return <Input type="date" aria-label={b.value} className="w-44" value={day} onChange={(e) => onChange(e.target.value ? `${e.target.value}T00:00:00.000Z` : "")} />;
  }
  const isList = ["in", "not_in", "contains_any", "contains_all", "contains_none"].includes(cmp);
  if (isList && options?.length) {
    const chosen = new Set(Array.isArray(value) ? (value as string[]) : []);
    return (
      <fieldset className="flex flex-wrap gap-x-3 gap-y-1" aria-label={b.values}>
        {options.map((o) => (
          <label key={o.value} className="flex items-center gap-1 text-sm">
            <input
              type="checkbox"
              checked={chosen.has(o.value)}
              onChange={(e) => {
                const next = new Set(chosen);
                if (e.target.checked) next.add(o.value);
                else next.delete(o.value);
                onChange([...next]);
              }}
            />
            {o.label}
          </label>
        ))}
      </fieldset>
    );
  }
  if (isList) {
    return <Input aria-label={b.values} className="w-64" value={Array.isArray(value) ? (value as string[]).join(", ") : ""} onChange={(e) => onChange(listOf(e.target.value))} />;
  }
  if (type === "number") {
    return <Input type="number" aria-label={b.value} className="w-28" value={Number(value ?? 0)} onChange={(e) => onChange(Number(e.target.value))} />;
  }
  if (options?.length) {
    return (
      <select aria-label={b.value} className={selectClass} value={(typeof value === "string" || typeof value === "number" ? String(value) : "")} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }
  return <Input aria-label={b.value} className="w-56" value={(typeof value === "string" || typeof value === "number" ? String(value) : "")} onChange={(e) => onChange(e.target.value)} />;
}
