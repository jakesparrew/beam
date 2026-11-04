/**
 * The automation definition (automation spec section 2.8): the JSON stored in
 * `automation_versions.definition` and `automations.draft_definition`, parsed with Zod.
 *
 * Every object is `.strict()` (unknown keys are rejected). Semantic checks that need the
 * database (templates, tags, roles, other automations, webhook hosts) live in `validate.ts`.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

export const PERSON_STATUSES = ["lead", "customer", "member"] as const;
export const DEFINITION_LOCALES = ["nl-BE", "fr-BE", "en"] as const;
export const AUTOMATION_PURPOSES = ["newsletter", "events", "member_comms", "b2b"] as const;
export const STEP_TYPES = [
  "email",
  "wait",
  "condition",
  "task",
  "tag",
  "untag",
  "set_field",
  "status_override",
  "enrol",
  "exit",
  "notify_slack",
  "webhook",
] as const;
export const TASK_KINDS = ["call", "follow_up", "payment", "proposal", "review", "other"] as const;
export const TASK_PRIORITIES = ["low", "normal", "high"] as const;
export const BOOKING_KINDS = ["day", "night", "event"] as const;
export const BOOKING_STATUSES_CHECKED = ["attended", "no_show", "confirmed", "cancelled"] as const;
export const CREDIT_KINDS = ["day", "night", "euro"] as const;
/** The one interpolation `has_other_active_grant.credit_kind` accepts. */
export const TRIGGER_CREDIT_KIND = "{{trigger.data.credit_kind}}" as const;

export type PersonStatus = (typeof PERSON_STATUSES)[number];
export type DefinitionLocale = (typeof DEFINITION_LOCALES)[number];
export type AutomationPurpose = (typeof AUTOMATION_PURPOSES)[number];
export type StepType = (typeof STEP_TYPES)[number];

/** Step keys: `^[a-z0-9_]{1,40}$`. */
export const STEP_KEY_RE = /^[a-z0-9_]{1,40}$/;
/** Automation slugs (`automations.slug`). */
export const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** Event kinds (`activity_events.kind`). */
export const EVENT_KIND_RE = /^[a-z_]+\.[a-z_]+$/;
/** Filter paths: `data.<a>[.<b>...]`, `mode`, `ref_type`, `ref_id`. */
export const FILTER_PATH_RE = /^(?:data(?:\.[a-z0-9_]+)+|mode|ref_type|ref_id)$/;
/** Anchor paths: `data.<a>[.<b>...]` into the trigger event data. */
export const ANCHOR_PATH_RE = /^data(?:\.[a-z0-9_]+)+$/;
export const RE_ENTRY_RE = /^after_days:(\d{1,4})$/;
export const HHMM_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
/** `exit_on` string entries: `kind` or `kind:qualifier`. */
export const EXIT_STRING_RE = /^[a-z_]+\.[a-z_]+(?::[a-z0-9_]+)?$/;
/** At offsets are bounded to one year either way. */
export const MAX_OFFSET_MINUTES = 525_600;
export const MAX_STEPS = 40;

// ---------------------------------------------------------------------------
// Types (section 2.8)
// ---------------------------------------------------------------------------

export type Literal = string | number | boolean | null;
export type FilterOps = {
  eq?: Literal;
  ne?: Literal;
  in?: Literal[];
  nin?: Literal[];
  gt?: number | string;
  gte?: number | string;
  lt?: number | string;
  lte?: number | string;
  exists?: boolean;
};
/** Dotted path (`data.x`, `mode`, `ref_type`, `ref_id`) to a literal (equality) or operators. */
export type Filter = Record<string, Literal | FilterOps>;

export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { has_future_booking: true | { kind?: "day" | "night" | "event"; within_days?: number } }
  | { status_in: PersonStatus[] }
  | { has_tag: string }
  | { in_segment: string }
  | { has_active_membership: true }
  | { membership_cancelling: true }
  | { has_other_active_grant: { credit_kind: "day" | "night" | "euro" | typeof TRIGGER_CREDIT_KIND } }
  | { form_completed: { slug: string; within_days?: number } }
  | { form_available: string }
  | { processing_restricted: true }
  | { event_since_enrolment: string }
  | { booking_status_in: ("attended" | "no_show" | "confirmed" | "cancelled")[] }
  | { trigger: Filter }
  | { task_open: string }
  | { sent_within_days: { template: string; days: number } };

/** The predicate names of `Condition` (the leaf keys plus the three combinators). */
export const CONDITION_PREDICATES = [
  "all",
  "any",
  "not",
  "has_future_booking",
  "status_in",
  "has_tag",
  "in_segment",
  "has_active_membership",
  "membership_cancelling",
  "has_other_active_grant",
  "form_completed",
  "form_available",
  "processing_restricted",
  "event_since_enrolment",
  "booking_status_in",
  "trigger",
  "task_open",
  "sent_within_days",
] as const;
export type ConditionPredicate = (typeof CONDITION_PREDICATES)[number];

export type At = { from: "enrolment" | "anchor" | "previous"; minutes: number; snap_to?: string };
export type StepBase = { key: string; at?: At; unless?: Condition; late_entry?: "skip" | "send_now" };

export type EmailStep = StepBase & { type: "email"; template: string; send_as?: "marketing" };
export type WaitStep = StepBase & { type: "wait"; minutes: number };
export type ConditionStep = StepBase & { type: "condition"; if: Condition; then: string; else: string };
export type TaskStep = StepBase & {
  type: "task";
  title: string;
  kind: (typeof TASK_KINDS)[number];
  owner_role: string;
  due_in_minutes: number;
  priority: (typeof TASK_PRIORITIES)[number];
  owner?: "role" | "trigger_owner";
};
export type TagStep = StepBase & { type: "tag" | "untag"; tag: string };
export type SetFieldStep = StepBase & { type: "set_field"; field: "preferred_channel"; value: "email" | "phone" | "whatsapp" };
export type StatusOverrideStep = StepBase & { type: "status_override"; value: PersonStatus | null; reason: string };
export type EnrolStep = StepBase & { type: "enrol"; automation: string };
export type ExitStep = StepBase & { type: "exit"; automation?: string };
export type NotifySlackStep = StepBase & { type: "notify_slack"; text: string };
export type WebhookStep = StepBase & { type: "webhook"; url: string };

export type Step =
  | EmailStep
  | WaitStep
  | ConditionStep
  | TaskStep
  | TagStep
  | SetFieldStep
  | StatusOverrideStep
  | EnrolStep
  | ExitStep
  | NotifySlackStep
  | WebhookStep;

export type Trigger = { event: string | string[]; where?: Filter } | { segment_enter: string } | { manual: true };
export type Audience = {
  status?: PersonStatus[];
  segment_id?: string;
  exclude_segment_ids?: string[];
  locales?: DefinitionLocale[];
  require_reachable?: boolean;
};
export type ReEntry = "never" | "always" | `after_days:${number}`;
export type ExitOnEntry = string | { event: string; where?: Filter; same_subject?: boolean };

export type Definition = {
  schema_version: 1;
  trigger: Trigger;
  anchor: "enrolment" | `data.${string}`;
  subject?: "ref";
  audience?: Audience;
  re_entry: ReEntry;
  exit_on: ExitOnEntry[];
  steps: Step[];
};

/** One problem in a definition: a parse error or a `validateDefinition` finding. */
export type DefinitionIssue = {
  code: string;
  /** Dotted path into the definition (`steps.2.template`), `''` for the whole definition. */
  path: string;
  message: string;
  severity: "error" | "warning";
  params?: Record<string, string | number | string[]>;
};

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const regexString = (re: RegExp, message: string) => z.string().regex(re, message);
const stepKey = () => regexString(STEP_KEY_RE, "step keys match ^[a-z0-9_]{1,40}$");
const slug = () => regexString(SLUG_RE, "automation slugs are kebab-case");
const eventKind = () => regexString(EVENT_KIND_RE, "event kinds look like entity.fact");
const offset = () => z.number().int().min(-MAX_OFFSET_MINUTES).max(MAX_OFFSET_MINUTES);
const nonNegativeMinutes = () => z.number().int().min(0).max(MAX_OFFSET_MINUTES);

export const LiteralSchema: z.ZodType<Literal> = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const orderable = z.union([z.number(), z.string()]);

export const FilterOpsSchema: z.ZodType<FilterOps> = z
  .strictObject({
    eq: LiteralSchema.optional(),
    ne: LiteralSchema.optional(),
    in: z.array(LiteralSchema).min(1).optional(),
    nin: z.array(LiteralSchema).min(1).optional(),
    gt: orderable.optional(),
    gte: orderable.optional(),
    lt: orderable.optional(),
    lte: orderable.optional(),
    exists: z.boolean().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: "an operator object needs at least one operator" });

export const FilterSchema: z.ZodType<Filter> = z.record(
  regexString(FILTER_PATH_RE, "filter paths are data.<key>, mode, ref_type or ref_id"),
  z.union([LiteralSchema, FilterOpsSchema]),
);

const leaf = <K extends string, V extends z.ZodType>(key: K, value: V) => z.strictObject({ [key]: value } as { [P in K]: V });

export const ConditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    leaf("all", z.array(ConditionSchema)),
    leaf("any", z.array(ConditionSchema)),
    leaf("not", ConditionSchema),
    leaf(
      "has_future_booking",
      z.union([
        z.literal(true),
        z.strictObject({ kind: z.enum(BOOKING_KINDS).optional(), within_days: z.number().int().min(1).max(3650).optional() }),
      ]),
    ),
    leaf("status_in", z.array(z.enum(PERSON_STATUSES)).min(1)),
    leaf("has_tag", z.string().min(1)),
    leaf("in_segment", z.guid()),
    leaf("has_active_membership", z.literal(true)),
    leaf("membership_cancelling", z.literal(true)),
    leaf(
      "has_other_active_grant",
      z.strictObject({ credit_kind: z.union([z.enum(CREDIT_KINDS), z.literal(TRIGGER_CREDIT_KIND)]) }),
    ),
    leaf(
      "form_completed",
      z.strictObject({ slug: z.string().min(1), within_days: z.number().int().min(1).max(3650).optional() }),
    ),
    leaf("form_available", z.string().min(1)),
    leaf("processing_restricted", z.literal(true)),
    leaf("event_since_enrolment", eventKind()),
    leaf("booking_status_in", z.array(z.enum(BOOKING_STATUSES_CHECKED)).min(1)),
    leaf("trigger", FilterSchema),
    leaf("task_open", stepKey()),
    leaf("sent_within_days", z.strictObject({ template: z.string().min(1), days: z.number().int().min(1).max(3650) })),
  ]),
);

export const AtSchema: z.ZodType<At> = z.strictObject({
  from: z.enum(["enrolment", "anchor", "previous"]),
  minutes: offset(),
  snap_to: regexString(HHMM_RE, "snap_to is HH:mm").optional(),
});

const base = {
  key: stepKey(),
  at: AtSchema.optional(),
  unless: ConditionSchema.optional(),
  late_entry: z.enum(["skip", "send_now"]).optional(),
};
const target = () => z.union([z.literal("end"), stepKey()]);

export const StepSchema: z.ZodType<Step> = z.discriminatedUnion("type", [
  z.strictObject({ ...base, type: z.literal("email"), template: z.string().min(1), send_as: z.literal("marketing").optional() }),
  z.strictObject({ ...base, type: z.literal("wait"), minutes: nonNegativeMinutes() }),
  z.strictObject({ ...base, type: z.literal("condition"), if: ConditionSchema, then: target(), else: target() }),
  z.strictObject({
    ...base,
    type: z.literal("task"),
    title: z.string().trim().min(1).max(200),
    kind: z.enum(TASK_KINDS),
    owner_role: z.string().min(1),
    due_in_minutes: nonNegativeMinutes(),
    priority: z.enum(TASK_PRIORITIES),
    owner: z.enum(["role", "trigger_owner"]).optional(),
  }),
  z.strictObject({ ...base, type: z.literal("tag"), tag: z.string().min(1) }),
  z.strictObject({ ...base, type: z.literal("untag"), tag: z.string().min(1) }),
  z.strictObject({
    ...base,
    type: z.literal("set_field"),
    field: z.literal("preferred_channel"),
    value: z.enum(["email", "phone", "whatsapp"]),
  }),
  z.strictObject({
    ...base,
    type: z.literal("status_override"),
    value: z.enum(PERSON_STATUSES).nullable(),
    reason: z.string().trim().min(1).max(500),
  }),
  z.strictObject({ ...base, type: z.literal("enrol"), automation: slug() }),
  z.strictObject({ ...base, type: z.literal("exit"), automation: slug().optional() }),
  z.strictObject({ ...base, type: z.literal("notify_slack"), text: z.string().trim().min(1).max(2000) }),
  z.strictObject({ ...base, type: z.literal("webhook"), url: z.string().min(1).max(2000) }),
]);

export const TriggerSchema: z.ZodType<Trigger> = z.union([
  z.strictObject({ event: z.union([eventKind(), z.array(eventKind()).min(1).max(20)]), where: FilterSchema.optional() }),
  z.strictObject({ segment_enter: z.guid() }),
  z.strictObject({ manual: z.literal(true) }),
]);

export const AudienceSchema: z.ZodType<Audience> = z.strictObject({
  status: z.array(z.enum(PERSON_STATUSES)).min(1).optional(),
  segment_id: z.guid().optional(),
  exclude_segment_ids: z.array(z.guid()).optional(),
  locales: z.array(z.enum(DEFINITION_LOCALES)).min(1).optional(),
  require_reachable: z.boolean().optional(),
});

const ReEntrySchema = z.union([
  z.literal("never"),
  z.literal("always"),
  z.templateLiteral(["after_days:", z.number()]).refine((s) => RE_ENTRY_RE.test(s), "re_entry is never, always or after_days:<n>"),
]);

const AnchorSchema = z.union([
  z.literal("enrolment"),
  z.templateLiteral(["data.", z.string()]).refine((s) => ANCHOR_PATH_RE.test(s), "the anchor is enrolment or data.<path>"),
]);

export const ExitOnEntrySchema: z.ZodType<ExitOnEntry> = z.union([
  regexString(EXIT_STRING_RE, "exit_on entries are kind or kind:qualifier"),
  z.strictObject({ event: eventKind(), where: FilterSchema.optional(), same_subject: z.boolean().optional() }),
]);

/** The definition schema (A-1). Step keys must be unique. */
export const AutomationDefinition: z.ZodType<Definition> = z
  .strictObject({
    schema_version: z.literal(1),
    trigger: TriggerSchema,
    anchor: AnchorSchema,
    subject: z.literal("ref").optional(),
    audience: AudienceSchema.optional(),
    re_entry: ReEntrySchema,
    exit_on: z.array(ExitOnEntrySchema).max(30),
    steps: z.array(StepSchema).min(1).max(MAX_STEPS),
  })
  .superRefine((def, ctx) => {
    const seen = new Set<string>();
    def.steps.forEach((s, i) => {
      if (seen.has(s.key)) {
        ctx.addIssue({
          code: "custom",
          path: ["steps", i, "key"],
          message: `step key ${s.key} is used twice`,
          params: { beamCode: "duplicate_step_key" },
        });
      }
      seen.add(s.key);
    });
  });

/** Parses unknown JSON into a definition, returning issues instead of throwing. */
export function parseDefinition(json: unknown): { ok: true; value: Definition } | { ok: false; issues: DefinitionIssue[] } {
  const result = AutomationDefinition.safeParse(json);
  if (result.success) return { ok: true, value: result.data };
  const issues = result.error.issues.map((issue): DefinitionIssue => {
    const custom = issue.code === "custom" ? (issue.params as { beamCode?: string } | undefined)?.beamCode : undefined;
    return {
      code: custom ?? (issue.code === "unrecognized_keys" ? "unknown_key" : "invalid_definition"),
      path: issue.path.map(String).join("."),
      message: issue.message,
      severity: "error",
    };
  });
  return { ok: false, issues };
}

/** Narrowing helpers. */
export const isEventTrigger = (t: Trigger): t is { event: string | string[]; where?: Filter } => "event" in t;
export const isSegmentTrigger = (t: Trigger): t is { segment_enter: string } => "segment_enter" in t;
export const isManualTrigger = (t: Trigger): t is { manual: true } => "manual" in t;

/** The event kinds an event trigger listens to (`[]` for segment and manual triggers). */
export function triggerKinds(t: Trigger): string[] {
  if (isEventTrigger(t)) return Array.isArray(t.event) ? [...t.event] : [t.event];
  if (isSegmentTrigger(t)) return ["segment.entered"];
  return [];
}

/** The number of days of an `after_days:N` policy, or null for `never` / `always`. */
export function reEntryDays(policy: ReEntry): number | null {
  const m = RE_ENTRY_RE.exec(policy);
  return m ? Number(m[1]) : null;
}
