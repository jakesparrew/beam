/**
 * Event filters and trigger matching (A-7, A-10). An `EventView` is the slice of an
 * `activity_events` row the engine reads; paths are `data.<a>.<b>`, `mode`, `ref_type`, `ref_id`.
 */
import { isEventTrigger, isSegmentTrigger, type Filter, type FilterOps, type Literal, type Trigger } from "./definition";

export type EventView = {
  /** `activity_events.id` (bigint identity). */
  id: bigint | number;
  kind: string;
  personId: string | null;
  occurredAt: Date;
  mode?: string | null;
  refType?: string | null;
  refId?: string | null;
  isSensitive?: boolean;
  data: Record<string, unknown>;
};

/** Values `{{trigger.data.<key>}}` placeholders resolve against (an enrolment's trigger). */
export type FilterVars = { trigger?: { data?: Record<string, unknown> } };

/** Events older than this never trigger (A-7b). */
export const TRIGGER_MAX_AGE_MS = 48 * 3_600_000;
export const HISTORY_IMPORTED_KIND = "ops.history_imported";

const PLACEHOLDER_RE = /^\{\{trigger\.data\.([a-z0-9_]+)\}\}$/;

/** Reads a dotted path from an event; `undefined` means the path is missing. */
export function readPath(ev: Pick<EventView, "mode" | "refType" | "refId" | "data">, path: string): unknown {
  if (path === "mode") return ev.mode ?? undefined;
  if (path === "ref_type") return ev.refType ?? undefined;
  if (path === "ref_id") return ev.refId ?? undefined;
  if (!path.startsWith("data.")) return undefined;
  let cur: unknown = ev.data;
  for (const part of path.slice(5).split(".")) {
    if (cur === null || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, part)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Resolves a `{{trigger.data.<key>}}` literal; other values pass through. */
export function resolveLiteral(value: unknown, vars?: FilterVars): unknown {
  if (typeof value !== "string") return value;
  const m = PLACEHOLDER_RE.exec(value);
  if (!m) return value;
  return vars?.trigger?.data?.[m[1]!];
}

export const isPlaceholder = (value: unknown): boolean => typeof value === "string" && PLACEHOLDER_RE.test(value);

const isOps = (v: Literal | FilterOps): v is FilterOps => v !== null && typeof v === "object";

function compare(value: unknown, bound: unknown): number | null {
  if (typeof value === "number" && typeof bound === "number") return value - bound;
  if (typeof value === "string" && typeof bound === "string") return value < bound ? -1 : value > bound ? 1 : 0;
  return null;
}

const same = (a: unknown, b: unknown) => a === b;

/**
 * One path against its literal or operator object. A missing path (`undefined`) fails every
 * operator except `exists: false`; `exists` means present and not null.
 */
export function matchesValue(value: unknown, cond: Literal | FilterOps, vars?: FilterVars): boolean {
  const missing = value === undefined;
  if (!isOps(cond)) return !missing && same(value, resolveLiteral(cond, vars));
  for (const [op, raw] of Object.entries(cond) as [keyof FilterOps, unknown][]) {
    if (raw === undefined) continue;
    if (op === "exists") {
      const present = !missing && value !== null;
      if (present !== raw) return false;
      continue;
    }
    if (missing) return false;
    const arg = Array.isArray(raw) ? raw.map((r) => resolveLiteral(r, vars)) : resolveLiteral(raw, vars);
    switch (op) {
      case "eq":
        if (!same(value, arg)) return false;
        break;
      case "ne":
        if (same(value, arg)) return false;
        break;
      case "in":
        if (!(arg as unknown[]).some((a) => same(value, a))) return false;
        break;
      case "nin":
        if ((arg as unknown[]).some((a) => same(value, a))) return false;
        break;
      default: {
        const c = compare(value, arg);
        if (c === null) return false;
        if (op === "gt" && !(c > 0)) return false;
        if (op === "gte" && !(c >= 0)) return false;
        if (op === "lt" && !(c < 0)) return false;
        if (op === "lte" && !(c <= 0)) return false;
      }
    }
  }
  return true;
}

/** A-10: every path of `where` matches; no `where` matches everything. */
export function matchesFilter(where: Filter | undefined, ev: Pick<EventView, "mode" | "refType" | "refId" | "data">, vars?: FilterVars): boolean {
  if (!where) return true;
  return Object.entries(where).every(([path, cond]) => matchesValue(readPath(ev, path), cond, vars));
}

/** A-10: kind (or any kind of a list) and `where`; `segment_enter` on `segment.entered`; `manual` never. */
export function matchesTrigger(trigger: Trigger, ev: EventView): boolean {
  if (isEventTrigger(trigger)) {
    const kinds = Array.isArray(trigger.event) ? trigger.event : [trigger.event];
    if (!kinds.includes(ev.kind)) return false;
    return matchesFilter(trigger.where, ev);
  }
  if (isSegmentTrigger(trigger)) {
    return ev.kind === "segment.entered" && ev.data.segment_id === trigger.segment_enter;
  }
  return false;
}

export type EventEligibility = {
  /** May start a journey (A-7). */
  trigger: boolean;
  /** May end a journey through built-in exits or `exit_on` (A-7). */
  exit: boolean;
  /** Why it cannot trigger, when it cannot. */
  reason: "sensitive" | "automation_kind" | "imported" | "history_imported" | "stale" | "automation_source" | null;
};

/**
 * A-7: sensitive events and `automation.*` kinds never trigger, exit or enter context; imported
 * history, events older than 48 hours and automation-caused events may exit but never trigger.
 */
export function eventEligibility(ev: EventView, now: Date): EventEligibility {
  if (ev.isSensitive) return { trigger: false, exit: false, reason: "sensitive" };
  if (ev.kind.startsWith("automation.")) return { trigger: false, exit: false, reason: "automation_kind" };
  if (ev.kind === HISTORY_IMPORTED_KIND) return { trigger: false, exit: true, reason: "history_imported" };
  if (ev.data.source === "import" || ev.data.via_import === true) return { trigger: false, exit: true, reason: "imported" };
  if (ev.data.source === "automation") return { trigger: false, exit: true, reason: "automation_source" };
  if (now.getTime() - ev.occurredAt.getTime() > TRIGGER_MAX_AGE_MS) return { trigger: false, exit: true, reason: "stale" };
  return { trigger: true, exit: true, reason: null };
}

/** The subject key of an event: `<ref_type>:<ref_id>`, or `''` when it has no reference. */
export function eventSubjectKey(ev: Pick<EventView, "refType" | "refId">): string {
  return ev.refType && ev.refId ? `${ev.refType}:${ev.refId}` : "";
}
