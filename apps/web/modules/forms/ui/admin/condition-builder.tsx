"use client";

/**
 * Condition editor (rule F4; forms-P5): a recursive tree of `all` / `any` groups, `not`, and leaves
 * on an answer (`field`), a score (`score`, a dimension key or `total`) or a range
 * (`range: { dimension, key }`). Used for field and section visibility, logic rules and outcome
 * conditions. The caller passes only the fields and dimensions a condition may reference (L4).
 */
import { CONDITION_OPS, opNeedsValue, type Condition, type ConditionOp, type ConditionValue } from "@beam/core/forms";
import { Button, Input } from "@beam/ui";
import { lbl, type Labels } from "./issues-panel";

export type ConditionFieldRef = { key: string; label: string; type: string; options?: { key: string; label: string }[] };
export type ConditionDimensionRef = { key: string; label: string; ranges: { key: string; label: string }[] };

export type ConditionBuilderProps = {
  value: Condition | undefined;
  onChange: (value: Condition | undefined) => void;
  fields: readonly ConditionFieldRef[];
  dimensions?: readonly ConditionDimensionRef[];
  labels: Labels;
  /** Accessible name of the whole condition (for example "Show this field when"). */
  legend: string;
  depth?: number;
};

const MAX_DEPTH = 6;
export const selectClass = "h-9 rounded-md border bg-background px-2 text-sm";

type Kind = "field" | "score" | "range" | "all" | "any" | "not";
const kindOf = (c: Condition): Kind => ("all" in c ? "all" : "any" in c ? "any" : "not" in c ? "not" : "range" in c ? "range" : "score" in c ? "score" : "field");

function blank(kind: Kind, p: Pick<ConditionBuilderProps, "fields" | "dimensions">): Condition {
  switch (kind) {
    case "all":
      return { all: [] };
    case "any":
      return { any: [] };
    case "not":
      return { not: { field: p.fields[0]?.key ?? "", op: "answered" } };
    case "score":
      return { score: p.dimensions?.[0]?.key ?? "total", op: "gte", value: 0 };
    case "range":
      return { range: { dimension: p.dimensions?.[0]?.key ?? "", key: p.dimensions?.[0]?.ranges[0]?.key ?? "" } };
    default:
      return { field: p.fields[0]?.key ?? "", op: "answered" };
  }
}

/** Parses the text box of a field leaf: lists for `in`/`not_in`, numbers and booleans when they look like one. */
function parseValue(op: ConditionOp, raw: string): ConditionValue {
  const one = (s: string): string | number => (s.trim() !== "" && !Number.isNaN(Number(s)) ? Number(s) : s.trim());
  if (op === "in" || op === "not_in") return raw.split(",").map(one).filter((v) => v !== "");
  if (raw === "true" || raw === "false") return raw === "true";
  return one(raw);
}
const showValue = (v: ConditionValue | undefined) => (Array.isArray(v) ? v.join(", ") : v === undefined ? "" : String(v));

function Leaf({ value, onChange, fields, dimensions, labels }: Omit<ConditionBuilderProps, "legend" | "value" | "onChange"> & { value: Condition; onChange: (c: Condition) => void }) {
  if ("field" in value) {
    const f = fields.find((x) => x.key === value.field);
    return (
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label={lbl(labels, "builder.condition.field")} className={selectClass} value={value.field} onChange={(e) => onChange({ ...value, field: e.target.value })}>
          {!f ? <option value={value.field}>{value.field || "—"}</option> : null}
          {fields.map((x) => (
            <option key={x.key} value={x.key}>
              {x.label || x.key}
            </option>
          ))}
        </select>
        <select aria-label={lbl(labels, "builder.condition.op")} className={selectClass} value={value.op} onChange={(e) => onChange({ field: value.field, op: e.target.value as ConditionOp, ...(opNeedsValue(e.target.value as ConditionOp) ? { value: value.value ?? "" } : {}) })}>
          {CONDITION_OPS.map((op) => (
            <option key={op} value={op}>
              {lbl(labels, `builder.op.${op}`)}
            </option>
          ))}
        </select>
        {opNeedsValue(value.op) ? (
          f?.options?.length && value.op !== "in" && value.op !== "not_in" ? (
            <select aria-label={lbl(labels, "builder.condition.value")} className={selectClass} value={showValue(value.value)} onChange={(e) => onChange({ ...value, value: e.target.value })}>
              <option value="">—</option>
              {f.options.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label || o.key}
                </option>
              ))}
            </select>
          ) : (
            <Input aria-label={lbl(labels, "builder.condition.value")} className="w-40" value={showValue(value.value)} onChange={(e) => onChange({ ...value, value: parseValue(value.op, e.target.value) })} />
          )
        ) : null}
      </div>
    );
  }
  if ("score" in value) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label={lbl(labels, "builder.condition.score")} className={selectClass} value={value.score} onChange={(e) => onChange({ ...value, score: e.target.value })}>
          <option value="total">{lbl(labels, "scoring.total")}</option>
          {(dimensions ?? []).map((d) => (
            <option key={d.key} value={d.key}>
              {d.label || d.key}
            </option>
          ))}
        </select>
        <select aria-label={lbl(labels, "builder.condition.op")} className={selectClass} value={value.op} onChange={(e) => onChange({ ...value, op: e.target.value as ConditionOp })}>
          {(["eq", "neq", "gt", "gte", "lt", "lte"] as const).map((op) => (
            <option key={op} value={op}>
              {lbl(labels, `builder.op.${op}`)}
            </option>
          ))}
        </select>
        <Input type="number" aria-label={lbl(labels, "builder.condition.value")} className="w-28" value={String(value.value)} onChange={(e) => onChange({ ...value, value: Number(e.target.value) })} />
      </div>
    );
  }
  if ("range" in value) {
    const d = dimensions?.find((x) => x.key === value.range.dimension);
    return (
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label={lbl(labels, "builder.condition.dimension")} className={selectClass} value={value.range.dimension} onChange={(e) => onChange({ range: { dimension: e.target.value, key: dimensions?.find((x) => x.key === e.target.value)?.ranges[0]?.key ?? "" } })}>
          {(dimensions ?? []).map((x) => (
            <option key={x.key} value={x.key}>
              {x.label || x.key}
            </option>
          ))}
        </select>
        <select aria-label={lbl(labels, "builder.condition.range")} className={selectClass} value={value.range.key} onChange={(e) => onChange({ range: { ...value.range, key: e.target.value } })}>
          {(d?.ranges ?? []).map((r) => (
            <option key={r.key} value={r.key}>
              {r.label || r.key}
            </option>
          ))}
        </select>
      </div>
    );
  }
  return null;
}

/** One node: a kind switch, the node's editor and a remove button. */
function Node(p: Omit<ConditionBuilderProps, "value" | "onChange" | "legend"> & { value: Condition; onChange: (c: Condition | undefined) => void; depth: number }) {
  const kind = kindOf(p.value);
  const kinds: Kind[] = ["field", ...(p.dimensions?.length || kind === "score" ? (["score", "range"] as Kind[]) : []), ...(p.depth < MAX_DEPTH - 1 ? (["all", "any", "not"] as Kind[]) : [])];
  const children = "all" in p.value ? p.value.all : "any" in p.value ? p.value.any : null;
  const setChildren = (list: Condition[]) => p.onChange("all" in p.value ? { all: list } : { any: list });
  return (
    <div className="grid gap-2 rounded-md border p-2" data-condition-kind={kind}>
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label={lbl(p.labels, "builder.condition.kind")} className={selectClass} value={kind} onChange={(e) => p.onChange(blank(e.target.value as Kind, p))}>
          {kinds.map((k) => (
            <option key={k} value={k}>
              {lbl(p.labels, `builder.condition.kind_${k}`)}
            </option>
          ))}
        </select>
        <Button type="button" variant="ghost" size="sm" onClick={() => p.onChange(undefined)}>
          {lbl(p.labels, "builder.remove")}
        </Button>
      </div>
      {children ? (
        <div className="grid gap-2 pl-4">
          {children.map((c, i) => (
            <Node key={i} {...p} depth={p.depth + 1} value={c} onChange={(next) => setChildren(next ? children.map((x, j) => (j === i ? next : x)) : children.filter((_, j) => j !== i))} />
          ))}
          <div>
            <Button type="button" variant="outline" size="sm" onClick={() => setChildren([...children, blank("field", p)])}>
              {lbl(p.labels, "builder.condition.add")}
            </Button>
          </div>
        </div>
      ) : "not" in p.value ? (
        <div className="pl-4">
          <Node {...p} depth={p.depth + 1} value={p.value.not} onChange={(next) => p.onChange(next ? { not: next } : undefined)} />
        </div>
      ) : (
        <Leaf {...p} value={p.value} onChange={p.onChange} />
      )}
    </div>
  );
}

export function ConditionBuilder({ value, onChange, legend, depth = 0, ...rest }: ConditionBuilderProps) {
  return (
    <fieldset className="grid gap-2">
      <legend className="text-sm font-medium">{legend}</legend>
      {value ? (
        <Node {...rest} depth={depth} value={value} onChange={onChange} />
      ) : (
        <div>
          <Button type="button" variant="outline" size="sm" onClick={() => onChange(blank("field", rest))}>
            {lbl(rest.labels, "builder.condition.add")}
          </Button>
        </div>
      )}
    </fieldset>
  );
}
