/**
 * `SegmentRule` and its Zod schema (crm spec 4.6). The schema checks the shape; the compiler's
 * `validateSegmentRule` checks the allow-lists, comparators per field type, values and limits
 * (at most 50 rules, depth 4) and names the rule path of every problem (rule 3.38).
 */
import { z } from "zod";
import { CONSENT_PURPOSES, type ConsentPurpose } from "../types";
import { COMPARATORS, type AllowedEventKind, type Comparator } from "./fields";

export type EventWhereValue = string | number | boolean | { gte?: number; lte?: number };

export type SegmentRule =
  | { op: "and" | "or"; rules: SegmentRule[] }
  | { type: "not"; rule: SegmentRule }
  | { type: "field"; field: string; cmp: Comparator; value?: unknown }
  | { type: "tag"; tagKey: string; has: boolean }
  | { type: "consent"; purpose: ConsentPurpose; granted: boolean }
  | { type: "in_segment"; segmentId: string; negate?: boolean }
  | {
      type: "event";
      kind: AllowedEventKind;
      mode?: "live" | "replay" | "on_demand";
      where?: Partial<Record<string, EventWhereValue>>;
      withinDays?: number;
      minCount?: number;
      negate?: boolean;
    };

export type SegmentGroup = Extract<SegmentRule, { op: "and" | "or" }>;

/** Maximum number of rules (every node counts) and nesting depth (rule 3.38). */
export const SEGMENT_MAX_RULES = 50;
export const SEGMENT_MAX_DEPTH = 4;

const Range = z.object({ gte: z.number().optional(), lte: z.number().optional() }).strict();
const WhereValue = z.union([z.string().max(200), z.number(), z.boolean(), Range]);

const GroupSchema: z.ZodType<SegmentGroup> = z
  .object({
    op: z.enum(["and", "or"]),
    get rules() {
      return z.array(SegmentRuleSchema).max(SEGMENT_MAX_RULES);
    },
  })
  .strict();

const NotSchema = z
  .object({
    type: z.literal("not"),
    get rule() {
      return SegmentRuleSchema;
    },
  })
  .strict();

const FieldSchema = z
  .object({ type: z.literal("field"), field: z.string().min(1).max(64), cmp: z.enum(COMPARATORS as [Comparator, ...Comparator[]]), value: z.unknown().optional() })
  .strict();

const TagSchema = z.object({ type: z.literal("tag"), tagKey: z.string().min(1).max(64), has: z.boolean() }).strict();

const ConsentSchema = z.object({ type: z.literal("consent"), purpose: z.enum(CONSENT_PURPOSES), granted: z.boolean() }).strict();

const InSegmentSchema = z.object({ type: z.literal("in_segment"), segmentId: z.uuid(), negate: z.boolean().optional() }).strict();

const EventSchema = z
  .object({
    type: z.literal("event"),
    kind: z.string().min(3).max(64),
    mode: z.enum(["live", "replay", "on_demand"]).optional(),
    where: z.record(z.string().min(1).max(64), WhereValue).optional(),
    withinDays: z.number().int().min(1).max(3650).optional(),
    minCount: z.number().int().min(1).max(1000).optional(),
    negate: z.boolean().optional(),
  })
  .strict();

/** The shape of a stored `segments.definition`. */
export const SegmentRuleSchema: z.ZodType<SegmentRule> = z.lazy(() =>
  z.union([GroupSchema, NotSchema, FieldSchema, TagSchema, ConsentSchema, InSegmentSchema, EventSchema]),
) as z.ZodType<SegmentRule>;

/** `segments.definition` default: an empty `and` group (matches everyone). */
export const EMPTY_SEGMENT_RULE: SegmentRule = { op: "and", rules: [] };

/** Every `in_segment` target of a rule (for the cycle check on save, rule 3.39). */
export function referencedSegmentIds(rule: SegmentRule): string[] {
  const out = new Set<string>();
  const walk = (r: SegmentRule) => {
    if ("op" in r) r.rules.forEach(walk);
    else if (r.type === "not") walk(r.rule);
    else if (r.type === "in_segment") out.add(r.segmentId);
  };
  walk(rule);
  return [...out].sort();
}

/**
 * True when saving `segmentId` with these references creates an `in_segment` cycle. `refs`
 * maps every other segment id to the ids its rule references.
 */
export function hasSegmentCycle(segmentId: string, references: readonly string[], refs: Readonly<Record<string, readonly string[]>>): boolean {
  const seen = new Set<string>();
  const stack = [...references];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === segmentId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(refs[id] ?? []));
  }
  return false;
}
