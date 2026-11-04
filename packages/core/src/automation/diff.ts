/**
 * Version diffs (`getVersion`, versions screen) and the canonical JSON behind
 * `automation_versions.definition_hash` (A-2; the sha256 itself is computed in `apps/web`,
 * because `@beam/core` stays free of `node:crypto`).
 */
import type { Definition } from "./definition";

export type DefinitionChange = {
  /** Dotted path; steps are addressed by key: `steps.<key>.template`. */
  path: string;
  kind: "added" | "removed" | "changed" | "moved";
  before?: unknown;
  after?: unknown;
};

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** JSON with object keys sorted at every level, so equal definitions hash equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value)) {
    const keys = Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

function diffValue(path: string, a: unknown, b: unknown, out: DefinitionChange[]): void {
  if (equal(a, b)) return;
  if (a === undefined) {
    out.push({ path, kind: "added", after: b });
    return;
  }
  if (b === undefined) {
    out.push({ path, kind: "removed", before: a });
    return;
  }
  if (isObject(a) && isObject(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const k of keys) diffValue(path ? `${path}.${k}` : k, a[k], b[k], out);
    return;
  }
  out.push({ path, kind: "changed", before: a, after: b });
}

/** Changes from `a` to `b`: top-level fields deep, steps matched by key (order changes are `moved`). */
export function diffDefinitions(a: Definition, b: Definition): DefinitionChange[] {
  const out: DefinitionChange[] = [];
  const { steps: stepsA, ...restA } = a;
  const { steps: stepsB, ...restB } = b;
  diffValue("", restA, restB, out);

  const byKeyA = new Map(stepsA.map((s, i) => [s.key, { s, i }]));
  const byKeyB = new Map(stepsB.map((s, i) => [s.key, { s, i }]));
  const orderA = stepsA.map((s) => s.key).filter((k) => byKeyB.has(k));
  const orderB = stepsB.map((s) => s.key).filter((k) => byKeyA.has(k));
  for (const s of stepsA) if (!byKeyB.has(s.key)) out.push({ path: `steps.${s.key}`, kind: "removed", before: s });
  for (const s of stepsB) {
    const prev = byKeyA.get(s.key);
    if (!prev) {
      out.push({ path: `steps.${s.key}`, kind: "added", after: s });
      continue;
    }
    if (orderA.indexOf(s.key) !== orderB.indexOf(s.key))
      out.push({ path: `steps.${s.key}`, kind: "moved", before: prev.i, after: byKeyB.get(s.key)!.i });
    const { key: _ka, ...fieldsA } = prev.s;
    const { key: _kb, ...fieldsB } = s;
    diffValue(`steps.${s.key}`, fieldsA, fieldsB, out);
  }
  return out;
}
