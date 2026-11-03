/**
 * The only way person data reaches a Claude prompt (PL-60, architecture section 8).
 *
 * `toAiContext()` copies the fields of the allow-list `AI_ALLOWED_FIELDS` from an already
 * loaded profile (a `v_person_profile` row, snake_case or camelCase) and nothing else:
 * never email, phone, notes, free text or any `SENSITIVE_FIELD_KEYS` member.
 */
export const AI_ALLOWED_FIELDS = [
  "first_name",
  "locale",
  "status",
  "is_member",
  "b2c_stage",
  "tags",
  "acquisition.source",
  "first_visit_at",
  "last_visit_at",
  "visits",
  "purchases",
  "revenue_cents",
  "credits_remaining",
  "grant_expires_at",
  "membership_period_end_at",
  "next_booking_at",
  "open_tasks",
  "granted_purposes",
] as const;

export type AiAllowedField = (typeof AI_ALLOWED_FIELDS)[number];

export type AiValue = string | number | boolean | null | string[];

/** The context object sent to Claude: allow-listed fields only, flat, JSON-safe. */
export type AiContext = Partial<Record<AiAllowedField, AiValue>>;

/** A loaded profile. Unknown keys are allowed and ignored; only allow-listed fields are read. */
export type AiProfileInput = {
  [key: string]: unknown;
  first_name?: string | null;
  locale?: string | null;
  status?: string | null;
  is_member?: boolean | null;
  b2c_stage?: string | null;
  tags?: readonly (string | { name?: unknown; key?: unknown })[] | null;
  acquisition?: { source?: string | null; [key: string]: unknown } | null;
  first_visit_at?: Date | string | null;
  last_visit_at?: Date | string | null;
  visits?: number | null;
  purchases?: number | null;
  revenue_cents?: number | null;
  credits_remaining?: number | null;
  grant_expires_at?: Date | string | null;
  membership_period_end_at?: Date | string | null;
  next_booking_at?: Date | string | null;
  open_tasks?: number | null;
  granted_purposes?: readonly string[] | null;
};

export function isAiAllowedField(field: string): field is AiAllowedField {
  return (AI_ALLOWED_FIELDS as readonly string[]).includes(field);
}

const DATE_FIELDS = new Set<AiAllowedField>([
  "first_visit_at",
  "last_visit_at",
  "grant_expires_at",
  "membership_period_end_at",
  "next_booking_at",
]);
const NUMBER_FIELDS = new Set<AiAllowedField>(["visits", "purchases", "revenue_cents", "credits_remaining", "open_tasks"]);
const LIST_FIELDS = new Set<AiAllowedField>(["tags", "granted_purposes"]);
const BOOLEAN_FIELDS = new Set<AiAllowedField>(["is_member"]);
const MAX_TEXT = 100;
const MAX_LIST = 50;

function camel(snake: string): string {
  return snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function read(profile: AiProfileInput, field: AiAllowedField): unknown {
  if (field === "acquisition.source") {
    const acquisition = profile.acquisition ?? (profile as Record<string, unknown>).acquisitionSource;
    if (acquisition && typeof acquisition === "object") return (acquisition as { source?: unknown }).source;
    if (typeof acquisition === "string") return acquisition;
    return profile.acquisition_source;
  }
  const value = profile[field];
  return value === undefined ? profile[camel(field)] : value;
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed ? trimmed.slice(0, MAX_TEXT) : null;
}

function normalise(field: AiAllowedField, value: unknown): AiValue | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (DATE_FIELDS.has(field)) {
    const d = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
    return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
  }
  if (NUMBER_FIELDS.has(field)) return typeof value === "number" && Number.isFinite(value) ? value : null;
  if (BOOLEAN_FIELDS.has(field)) return typeof value === "boolean" ? value : null;
  if (LIST_FIELDS.has(field)) {
    if (!Array.isArray(value)) return null;
    const items = value
      .map((item: unknown) => {
        if (typeof item === "string") return text(item);
        if (item && typeof item === "object") return text((item as { name?: unknown }).name ?? (item as { key?: unknown }).key);
        return null;
      })
      .filter((item): item is string => item !== null);
    return items.slice(0, MAX_LIST);
  }
  return text(value);
}

/** Builds the AI context from the allow-list. Fields absent from the profile are left out. */
export function toAiContext(profile: AiProfileInput, fields: readonly AiAllowedField[] = AI_ALLOWED_FIELDS): AiContext {
  const context: AiContext = {};
  for (const field of AI_ALLOWED_FIELDS) {
    if (!fields.includes(field)) continue;
    const value = normalise(field, read(profile, field));
    if (value !== undefined) context[field] = value;
  }
  return context;
}

/** The field names present in a context: what `callClaude()` receives as `fieldsSent`. */
export function aiContextFields(context: AiContext): AiAllowedField[] {
  return AI_ALLOWED_FIELDS.filter((f) => f in context);
}

/** Stable JSON (allow-list order) for the prompt. */
export function aiContextJson(context: AiContext): string {
  const ordered: Record<string, AiValue> = {};
  for (const f of aiContextFields(context)) ordered[f] = context[f] as AiValue;
  return JSON.stringify(ordered);
}
