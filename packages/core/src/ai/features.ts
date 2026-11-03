/**
 * The AI feature register (blueprint 61, PL-52 to PL-54, platform decision 32).
 *
 * One entry per AI job kind of architecture section 8 plus site's R4 audit job. Every key is
 * present from Wave 0, so later releases never edit this file to switch a feature on; the
 * `when` field records the release that uses it. `/admin/system/ai` renders this register.
 */
import { AI_ALLOWED_FIELDS, type AiAllowedField } from "./context";

export const AI_MODELS = { opus: "claude-opus-5-5", haiku: "claude-haiku-5-5" } as const;

export type AiModelAlias = keyof typeof AI_MODELS;
export type AiModelId = (typeof AI_MODELS)[AiModelAlias];
export type AiEffort = "low" | "medium" | "high";
export type AiRelease = "V1" | "R2" | "R3" | "R4";

export const AI_PROVIDER = "Anthropic" as const;
export const AI_LOCATION =
  "Anthropic API, US processing under the EU-US DPF and SCCs; an EU endpoint is used once Anthropic offers one" as const;
export const AI_RETENTION = "30 days in ai_requests; Anthropic API retention per its commercial terms" as const;
export const AI_TRAINING_STATUS = "not_used_for_training" as const;
export const AI_PROMPT_STORAGE = "ai_requests.prompt" as const;
export const AI_PROMPT_RETENTION = "30 days" as const;

export type AiFeature = {
  /** The module that owns the job and stores the output. */
  module: string;
  /** What the feature does (English; the admin screen shows it as documentation). */
  purpose: string;
  model: AiModelAlias;
  effort: AiEffort;
  /** Fields of `AI_ALLOWED_FIELDS` the feature may send; `[]` means no personal data at all. */
  allowedFields: readonly AiAllowedField[];
  /** No V1 to R4 feature may receive special-category data (PL-54). */
  allowsSensitive: false;
  /** The release in which the feature is used. */
  when: AiRelease;
  provider: typeof AI_PROVIDER;
  location: typeof AI_LOCATION;
  retention: typeof AI_RETENTION;
  trainingStatus: typeof AI_TRAINING_STATUS;
  /** Where the output lives until a person approves it (PL-61). */
  outputStorage: string;
  promptStorage: typeof AI_PROMPT_STORAGE;
  promptRetention: typeof AI_PROMPT_RETENTION;
};

/** The ten documentation fields of blueprint 61 that every register entry carries. */
export const BLUEPRINT_61_FIELDS = [
  "purpose",
  "provider",
  "model",
  "allowedFields",
  "location",
  "retention",
  "trainingStatus",
  "outputStorage",
  "promptStorage",
  "promptRetention",
] as const satisfies readonly (keyof AiFeature)[];

const COMMON = {
  allowsSensitive: false,
  provider: AI_PROVIDER,
  location: AI_LOCATION,
  retention: AI_RETENTION,
  trainingStatus: AI_TRAINING_STATUS,
  promptStorage: AI_PROMPT_STORAGE,
  promptRetention: AI_PROMPT_RETENTION,
} as const;

const PROFILE_BASICS = ["first_name", "locale", "status", "is_member", "b2c_stage", "tags"] as const satisfies readonly AiAllowedField[];

export const AI_FEATURE_KEYS = [
  "site.propose_page",
  "ai.classify",
  "ai.draft_email",
  "ai.draft_reply",
  "ai.weekly_summary",
  "ai.answer_question",
  "site.audit_content",
] as const;

export type AiFeatureKey = (typeof AI_FEATURE_KEYS)[number];

export const AI_FEATURES: Readonly<Record<AiFeatureKey, AiFeature>> = {
  "site.propose_page": {
    ...COMMON,
    module: "site",
    purpose: "Propose a new version of a website page from its current content and a staff instruction.",
    model: "opus",
    effort: "high",
    allowedFields: [],
    when: "V1",
    outputStorage: "page_versions row with status proposed (created_by claude) until a staff member with site.publish publishes it",
  },
  "ai.classify": {
    ...COMMON,
    module: "crm",
    purpose: "Classify an incoming inbox message by topic and urgency so staff can route it.",
    model: "haiku",
    effort: "low",
    allowedFields: ["locale", "status", "is_member", "b2c_stage"],
    when: "R3",
    outputStorage: "inbox thread classification fields, shown as a suggestion that staff can change",
  },
  "ai.draft_email": {
    ...COMMON,
    module: "email",
    purpose: "Draft a marketing campaign (subject and blocks in three locales) from a staff brief.",
    model: "opus",
    effort: "medium",
    allowedFields: [],
    when: "R4",
    outputStorage: "ai draft row and a draft campaign version that staff edit and approve; never scheduled automatically",
  },
  "ai.draft_reply": {
    ...COMMON,
    module: "crm",
    purpose: "Draft a reply to a customer message in the unified inbox for staff to review and send.",
    model: "opus",
    effort: "medium",
    allowedFields: [...PROFILE_BASICS, "credits_remaining", "grant_expires_at", "membership_period_end_at", "next_booking_at"],
    when: "R3",
    outputStorage: "inbox thread ai_draft field until a staff member edits and sends it",
  },
  "ai.weekly_summary": {
    ...COMMON,
    module: "ops",
    purpose: "Summarise the week's management figures (aggregates only) for the management dashboard.",
    model: "opus",
    effort: "medium",
    allowedFields: [],
    when: "R4",
    outputStorage: "ops weekly summary row shown on the management dashboard",
  },
  "ai.answer_question": {
    ...COMMON,
    module: "ops",
    purpose: "Answer a staff question in natural language with read-only SQL over the non-sensitive ai views.",
    model: "opus",
    effort: "medium",
    allowedFields: [],
    when: "R4",
    outputStorage: "ops question log with the SQL and the answer, shown only to the asking staff member",
  },
  "site.audit_content": {
    ...COMMON,
    module: "site",
    purpose: "Weekly SEO and broken-reference review of published website pages.",
    model: "haiku",
    effort: "low",
    allowedFields: [],
    when: "R4",
    outputStorage: "site_audit_reports row listing suggestions for staff",
  },
};

export function isAiFeatureKey(key: string): key is AiFeatureKey {
  return (AI_FEATURE_KEYS as readonly string[]).includes(key);
}

/** The model id a feature runs on (`opus` -> `claude-opus-5-5`, PL-58). */
export function modelIdFor(alias: AiModelAlias): AiModelId {
  return AI_MODELS[alias];
}

/**
 * PL-53: the fields a call wants to send that the feature does not allow (empty when the call
 * may go ahead). Also lists fields outside `AI_ALLOWED_FIELDS`.
 */
export function disallowedFields(feature: AiFeature, fieldsSent: readonly string[]): string[] {
  const allowed = new Set<string>(feature.allowedFields.filter((f) => (AI_ALLOWED_FIELDS as readonly string[]).includes(f)));
  return fieldsSent.filter((f) => !allowed.has(f));
}
