/**
 * `zodToFormFields(schema)`: turns a settings key's Zod schema into serialisable field
 * descriptors for the generic editor `/admin/settings/[key]` (platform spec 5). Strings,
 * numbers, booleans, enums, literals, LocalizedText (rendered with `LocalizedInput`) and
 * arrays of strings or numbers get their own input; nested objects are flattened into dotted
 * paths; anything deeper (records, tuples, unions, arrays of objects) gets a validated JSON
 * editor. Pure and server-safe: the page computes the fields, `SettingsForm` (client) renders
 * them, and the server action re-validates the whole value with the real schema (PL-41).
 */
import type { z } from "zod";

export type FieldKind = "string" | "number" | "integer" | "boolean" | "enum" | "literal" | "localized" | "string_list" | "number_list" | "json";

export type FormFieldSpec = {
  /** Path inside the setting value; `[]` is the whole value. */
  path: string[];
  /** Dotted path, used as input name and label fallback. */
  name: string;
  kind: FieldKind;
  nullable: boolean;
  optional: boolean;
  options?: string[];
  min?: number;
  max?: number;
  description?: string;
};

type AnyDef = { type: string; innerType?: ZodLike; element?: ZodLike; entries?: Record<string, string>; values?: unknown[]; checks?: { _zod: { def: Record<string, unknown> } }[]; shape?: Record<string, ZodLike> };
type ZodLike = { def: AnyDef; shape?: Record<string, ZodLike>; description?: string };

const LOCALE_KEYS = ["en", "fr-BE", "nl-BE"];

/** Unwraps optional, nullable, default and readonly wrappers. */
function unwrap(schema: ZodLike): { inner: ZodLike; nullable: boolean; optional: boolean } {
  let inner = schema;
  let nullable = false;
  let optional = false;
  for (let i = 0; i < 10; i++) {
    const t = inner.def.type;
    if (t === "nullable") nullable = true;
    else if (t === "optional" || t === "default" || t === "prefault") optional = true;
    else if (t !== "readonly" && t !== "catch") break;
    if (!inner.def.innerType) break;
    inner = inner.def.innerType;
  }
  return { inner, nullable, optional };
}

function bounds(schema: ZodLike): { min?: number; max?: number; integer: boolean } {
  let min: number | undefined;
  let max: number | undefined;
  let integer = false;
  for (const c of schema.def.checks ?? []) {
    const d = c._zod.def;
    if (d.check === "number_format" && (d.format === "safeint" || d.format === "int32")) integer = true;
    if ((d.check === "greater_than" || d.check === "min_length") && typeof (d.value ?? d.minimum) === "number") min = Number(d.value ?? d.minimum);
    if ((d.check === "less_than" || d.check === "max_length") && typeof (d.value ?? d.maximum) === "number") max = Number(d.value ?? d.maximum);
  }
  return { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}), integer };
}

function shapeOf(schema: ZodLike): Record<string, ZodLike> | undefined {
  return schema.shape ?? schema.def.shape;
}

function isLocalized(schema: ZodLike): boolean {
  const shape = shapeOf(schema);
  if (!shape) return false;
  const keys = Object.keys(shape).sort();
  return keys.length === 3 && keys.every((k, i) => k === LOCALE_KEYS[i]) && Object.values(shape).every((s) => unwrap(s).inner.def.type === "string");
}

function walk(schema: ZodLike, path: string[], out: FormFieldSpec[]): void {
  const { inner, nullable, optional } = unwrap(schema);
  const base = { path, name: path.join(".") || "value", nullable, optional, ...(schema.description ? { description: schema.description } : {}) };
  const type = inner.def.type;
  if (type === "object" && isLocalized(inner)) {
    out.push({ ...base, kind: "localized" });
    return;
  }
  if (type === "object" && !nullable) {
    for (const [key, child] of Object.entries(shapeOf(inner) ?? {})) walk(child, [...path, key], out);
    return;
  }
  if (type === "string") {
    const b = bounds(inner);
    out.push({ ...base, kind: "string", ...(b.min !== undefined ? { min: b.min } : {}), ...(b.max !== undefined ? { max: b.max } : {}) });
    return;
  }
  if (type === "number") {
    const b = bounds(inner);
    out.push({ ...base, kind: b.integer ? "integer" : "number", ...(b.min !== undefined ? { min: b.min } : {}), ...(b.max !== undefined ? { max: b.max } : {}) });
    return;
  }
  if (type === "boolean") {
    out.push({ ...base, kind: "boolean" });
    return;
  }
  if (type === "enum") {
    out.push({ ...base, kind: "enum", options: Object.values(inner.def.entries ?? {}) });
    return;
  }
  if (type === "literal") {
    out.push({ ...base, kind: "literal", options: (inner.def.values ?? []).map(String) });
    return;
  }
  if (type === "array" && inner.def.element) {
    const el = unwrap(inner.def.element).inner.def.type;
    if (el === "string" || el === "enum") {
      out.push({ ...base, kind: "string_list" });
      return;
    }
    if (el === "number") {
      out.push({ ...base, kind: "number_list" });
      return;
    }
  }
  out.push({ ...base, kind: "json" });
}

/** The field descriptors of a setting's schema (serialisable; safe to pass to a client component). */
export function zodToFormFields(schema: z.ZodType): FormFieldSpec[] {
  const out: FormFieldSpec[] = [];
  walk(schema as unknown as ZodLike, [], out);
  return out;
}

/** Reads the value at `path` (`[]` is the whole value). */
export function getAt(value: unknown, path: readonly string[]): unknown {
  let node = value;
  for (const p of path) node = node && typeof node === "object" ? (node as Record<string, unknown>)[p] : undefined;
  return node;
}

/** Returns a copy of `value` with `path` set to `next`. */
export function setAt(value: unknown, path: readonly string[], next: unknown): unknown {
  if (path.length === 0) return next;
  const [head, ...rest] = path;
  const obj = value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
  obj[head!] = setAt(obj[head!], rest, next);
  return obj;
}
