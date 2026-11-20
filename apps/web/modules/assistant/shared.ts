/**
 * The assistant setting's schema, types and defaults, without server imports, so client
 * components (the settings form) can use them. `config.ts` registers the setting.
 */
import { z } from "zod";

export const ASSISTANT_EFFORTS = ["none", "low", "medium", "high"] as const;

/** Journeys that start from "now" and need no event data, so a person can be placed in them by hand. */
export const DEFAULT_ADVICE_FLOWS = ["welcome-lead", "inactivity", "review-request", "lead-sales-follow-up", "assistant-lead-follow-up"] as const;

const RoleConfig = z.object({
  model: z.string().min(3).max(120),
  fallback: z.string().max(120).nullable(),
  effort: z.enum(ASSISTANT_EFFORTS),
  max_tokens: z.number().int().min(200).max(8000),
});

/** One model of the gateway with its list price, in cents per million tokens. */
export const AssistantModel = z.object({
  id: z.string().min(3).max(120),
  label: z.string().min(1).max(80),
  in: z.number().nonnegative(),
  out: z.number().nonnegative(),
  cache_read: z.number().nonnegative(),
  cache_write: z.number().nonnegative(),
});

export const AssistantSetting = z.object({
  enabled: z.boolean(),
  coach_enabled: z.boolean(),
  roles: z.object({ guide: RoleConfig, coach: RoleConfig, analyst: RoleConfig }),
  models: z.array(AssistantModel).min(1).max(30),
  daily_budget_cents: z.number().int().min(0),
  monthly_budget_cents: z.number().int().min(0),
  limits: z.object({
    per_minute: z.number().int().min(1).max(120),
    per_day: z.number().int().min(1).max(2000),
    per_conversation: z.number().int().min(4).max(400),
    per_ip_minute: z.number().int().min(1).max(600),
  }),
  contact_after_messages: z.number().int().min(1).max(30),
  tone: z.string().max(2000),
  /**
   * Profile advice: the journeys the agent may place a person in, and whether it does so itself
   * (`auto_apply`) or only proposes and staff click. Marketing emails stay behind consent either way.
   */
  advice: z
    .object({ auto_apply: z.boolean(), flows: z.array(z.string().min(2).max(80)).max(30) })
    .default({ auto_apply: false, flows: [...DEFAULT_ADVICE_FLOWS] }),
});

export type AssistantSettingValue = z.infer<typeof AssistantSetting>;
export type AssistantRole = keyof AssistantSettingValue["roles"];

/** Vercel AI Gateway list prices (USD per million tokens × 100), read 19-11-2026. */
export const DEFAULT_ASSISTANT_MODELS: AssistantSettingValue["models"] = [
  { id: "anthropic/claude-haiku-5.5", label: "Claude Haiku 5.5", in: 10, out: 50, cache_read: 1, cache_write: 12.5 },
  { id: "anthropic/claude-sonnet-5.5", label: "Claude Sonnet 5.5", in: 200, out: 1000, cache_read: 10, cache_write: 250 },
  { id: "anthropic/claude-opus-5.5", label: "Claude Opus 5.5", in: 400, out: 2000, cache_read: 20, cache_write: 500 },
  { id: "google/gemini-3-flash", label: "Gemini 3 Flash", in: 50, out: 300, cache_read: 5, cache_write: 0 },
  { id: "openai/gpt-5.5", label: "GPT-5.5", in: 500, out: 3000, cache_read: 50, cache_write: 0 },
];

export const DEFAULT_ASSISTANT_SETTING: AssistantSettingValue = {
  enabled: true,
  coach_enabled: true,
  roles: {
    guide: { model: "anthropic/claude-haiku-5.5", fallback: "google/gemini-3-flash", effort: "low", max_tokens: 700 },
    coach: { model: "anthropic/claude-sonnet-5.5", fallback: "anthropic/claude-haiku-5.5", effort: "medium", max_tokens: 1200 },
    analyst: { model: "anthropic/claude-haiku-5.5", fallback: null, effort: "low", max_tokens: 1500 },
  },
  models: DEFAULT_ASSISTANT_MODELS,
  daily_budget_cents: 500,
  monthly_budget_cents: 5000,
  limits: { per_minute: 12, per_day: 60, per_conversation: 80, per_ip_minute: 30 },
  contact_after_messages: 4,
  tone: "Warm, rustig en helder, zoals een gastvrouw van BEAM. Korte zinnen, geen uitroeptekens, geen jargon. Spreek de bezoeker aan met je.",
  advice: { auto_apply: false, flows: [...DEFAULT_ADVICE_FLOWS] },
};
