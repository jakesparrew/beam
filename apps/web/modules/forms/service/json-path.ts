/**
 * The JsonPath of `ImportMapping` (forms spec rule I2): a dotted path with `[n]` indexes and
 * `[a.b=value]` filters, for example `form_response.answers[field.ref=sleep].number` (the first
 * element of `answers` whose `field.ref` is `sleep`, then its `number`). The grammar is the
 * `JsonPathSchema` regex of `packages/core/src/forms/definition.ts`. Resolution never throws:
 * a path that does not match the value gives `undefined`. Pure, no I/O.
 */

type Step = { kind: "key"; key: string } | { kind: "index"; index: number } | { kind: "filter"; path: string; value: string };

const KEY_RE = /^[A-Za-z0-9_$-]+$/;
const cache = new Map<string, Step[] | null>();

/** The steps of a path, or `null` when it is not a valid JsonPath. */
export function parsePath(path: string): Step[] | null {
  const hit = cache.get(path);
  if (hit !== undefined) return hit;
  const steps = parse(path);
  if (cache.size > 500) cache.clear();
  cache.set(path, steps);
  return steps;
}

function parse(path: string): Step[] | null {
  if (!path || path.length > 300) return null;
  const steps: Step[] = [];
  let i = 0;
  let expectKey = true;
  while (i < path.length) {
    const c = path[i]!;
    if (c === "[") {
      if (expectKey) return null;
      const end = path.indexOf("]", i);
      if (end < 0) return null;
      const inner = path.slice(i + 1, end);
      if (/^\d+$/.test(inner)) steps.push({ kind: "index", index: Number(inner) });
      else {
        const eq = inner.indexOf("=");
        if (eq <= 0) return null;
        const lhs = inner.slice(0, eq);
        const value = inner.slice(eq + 1);
        if (!value || !lhs.split(".").every((s) => KEY_RE.test(s))) return null;
        steps.push({ kind: "filter", path: lhs, value });
      }
      i = end + 1;
      expectKey = false;
      continue;
    }
    if (c === ".") {
      if (expectKey) return null;
      i++;
      expectKey = true;
      continue;
    }
    if (!expectKey) return null;
    let j = i;
    while (j < path.length && path[j] !== "." && path[j] !== "[") j++;
    const key = path.slice(i, j);
    if (!KEY_RE.test(key)) return null;
    steps.push({ kind: "key", key });
    i = j;
    expectKey = false;
  }
  return expectKey ? null : steps;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** `String()` of a scalar, for filter comparison; objects and arrays never match. */
const scalarText = (v: unknown): string | null =>
  typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" || typeof v === "bigint" ? String(v) : null;

/** I2: the value at `path` inside `obj`, or `undefined`. */
export function resolvePath(obj: unknown, path: string): unknown {
  const steps = parsePath(path);
  if (!steps) return undefined;
  let cur: unknown = obj;
  for (const s of steps) {
    if (cur === undefined || cur === null) return undefined;
    if (s.kind === "key") {
      if (!isRecord(cur) || !Object.prototype.hasOwnProperty.call(cur, s.key)) return undefined;
      cur = cur[s.key];
    } else if (s.kind === "index") {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[s.index];
    } else {
      if (!Array.isArray(cur)) return undefined;
      cur = cur.find((el: unknown) => scalarText(resolvePath(el, s.path)) === s.value);
    }
  }
  return cur;
}

/**
 * Sets `value` at a simple path (keys and `[n]` indexes, no filters), creating objects and arrays
 * on the way. Returns false when the path is not simple or collides with an existing scalar. Used
 * to rebuild a CSV row into the payload shape the mapping addresses (rule I5).
 */
export function setPath(target: Record<string, unknown>, path: string, value: unknown): boolean {
  const steps = parsePath(path);
  if (!steps || steps.some((s) => s.kind === "filter") || steps[0]?.kind !== "key") return false;
  let cur: Record<string, unknown> | unknown[] = target;
  for (let n = 0; n < steps.length; n++) {
    const s = steps[n]!;
    const last = n === steps.length - 1;
    const next = steps[n + 1];
    const slot: string | number = s.kind === "key" ? s.key : (s as { index: number }).index;
    if (s.kind === "key" && Array.isArray(cur)) return false;
    if (s.kind === "index" && !Array.isArray(cur)) return false;
    if (s.kind === "index" && s.index > 1000) return false;
    const holder = cur as Record<string | number, unknown>;
    if (last) {
      holder[slot] = value;
      return true;
    }
    const existing = holder[slot];
    if (existing === undefined) holder[slot] = next?.kind === "index" ? [] : {};
    else if (existing === null || typeof existing !== "object") return false;
    cur = holder[slot] as Record<string, unknown> | unknown[];
  }
  return true;
}
