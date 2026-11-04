/**
 * crm-P5: every `SEGMENT_ALLOWED_EVENT_KINDS` kind exists in the event registry with the
 * writer's exact spelling, every allowed `where` key exists in that kind's declared `data`
 * schema, and no allowed kind is sensitive (rules 3.27, 3.38; decision 48). A kind of a module
 * that has not declared its events yet (no kind of its prefixes is registered) is pending; as
 * soon as that module declares any event, its allowed kinds are checked like the others.
 */
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { SEGMENT_ALLOWED_EVENT_KINDS, SEGMENT_ARRAY_EVENT_KEYS, SEGMENT_EVENT_DATA_KEYS, SEGMENT_NUMERIC_EVENT_KEYS } from "@beam/core/crm";
import { EVENTS } from "@/registry/events.generated";

/** Kind prefixes of the writers that may not have declared their events yet (forms, webinar). */
const LATE_WRITERS: Record<string, readonly string[]> = {
  form: ["form", "assessment"],
  assessment: ["form", "assessment"],
  webinar: ["webinar"],
};
/** True while the writer of `kind` has no kind at all in the registry (its facade is still empty). */
const writerNotDeclared = (kind: string): boolean => {
  const family = LATE_WRITERS[kind.split(".")[0]!];
  return !!family && !Object.keys(EVENTS).some((k) => family.includes(k.split(".")[0]!));
};

type Def = { _zod?: { def: Record<string, unknown> } };

/** Every object key a Zod v4 schema accepts (objects, unions, intersections, pipes, wrappers). */
function schemaKeys(schema: unknown, seen = new Set<unknown>()): Set<string> {
  const out = new Set<string>();
  if (!schema || seen.has(schema)) return out;
  seen.add(schema);
  const def = (schema as Def)._zod?.def;
  if (!def) return out;
  const add = (s: unknown) => schemaKeys(s, seen).forEach((k) => out.add(k));
  switch (def.type) {
    case "object":
      Object.keys(def.shape as Record<string, unknown>).forEach((k) => out.add(k));
      break;
    case "union":
      (def.options as unknown[]).forEach(add);
      break;
    case "intersection":
      add(def.left);
      add(def.right);
      break;
    case "pipe":
      add(def.in);
      break;
    default:
      if (def.innerType) add(def.innerType);
  }
  return out;
}

const registry = EVENTS as unknown as Record<string, { kind: string; data: z.ZodTypeAny; isSensitive?: boolean } | undefined>;

describe("SEGMENT_ALLOWED_EVENT_KINDS", () => {
  it("every kind is registered by its writer, or its writer has not declared any event yet", () => {
    const missing: string[] = [];
    const pending: string[] = [];
    for (const kind of SEGMENT_ALLOWED_EVENT_KINDS) {
      if (registry[kind]) continue;
      if (writerNotDeclared(kind)) pending.push(kind);
      else missing.push(kind);
    }
    expect(missing).toEqual([]);
    expect(pending.length).toBeLessThan(SEGMENT_ALLOWED_EVENT_KINDS.length);
  });

  it("every allowed where key is a key of the kind's data schema", () => {
    const problems: string[] = [];
    for (const kind of SEGMENT_ALLOWED_EVENT_KINDS) {
      const def = registry[kind];
      if (!def) continue;
      const keys = schemaKeys(def.data);
      for (const key of SEGMENT_EVENT_DATA_KEYS[kind]) if (!keys.has(key)) problems.push(`${kind}.${key}`);
    }
    expect(problems).toEqual([]);
  });

  it("no allowed kind is a sensitive event", () => {
    const sensitive = SEGMENT_ALLOWED_EVENT_KINDS.filter((k) => registry[k]?.isSensitive === true);
    expect(sensitive).toEqual([]);
  });

  it("array and numeric keys are allowed keys of at least one kind", () => {
    const all = new Set(Object.values(SEGMENT_EVENT_DATA_KEYS).flat());
    for (const key of [...SEGMENT_ARRAY_EVENT_KEYS, ...SEGMENT_NUMERIC_EVENT_KEYS]) expect(all.has(key as never)).toBe(true);
  });

  it("schemaKeys reads object, extended and union schemas", async () => {
    const { z: zod } = await import("zod");
    const base = zod.object({ a: zod.string() });
    expect([...schemaKeys(base.extend({ b: zod.number().optional() }))].sort()).toEqual(["a", "b"]);
    expect([...schemaKeys(zod.union([base, zod.object({ c: zod.boolean() })]))].sort()).toEqual(["a", "c"]);
    expect([...schemaKeys(base.transform((v) => v).optional())]).toEqual(["a"]);
  });
});
