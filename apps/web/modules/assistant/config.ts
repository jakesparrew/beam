/**
 * assistant settings (docs/plan/modules/assistant.md section 3.2). Facade read by `pnpm gen:indexes`.
 * One setting `assistant`: on/off per role, the model, fallback, reasoning effort and answer length
 * per role (any gateway model id from `models`), the price list used to compute cost, the spend
 * caps, the per-visitor limits, when to offer the contact card, and the tone of voice. Staff edit it
 * at `/admin/assistant/settings`; a change applies to the next message.
 */
import { defineSetting } from "@/lib/settings";
import { AssistantSetting, DEFAULT_ASSISTANT_SETTING } from "./shared";

export { ASSISTANT_EFFORTS, AssistantModel, AssistantSetting, DEFAULT_ASSISTANT_MODELS, DEFAULT_ASSISTANT_SETTING, type AssistantRole, type AssistantSettingValue } from "./shared";

export const settings = [
  defineSetting({
    key: "assistant",
    schema: AssistantSetting,
    default: DEFAULT_ASSISTANT_SETTING,
    description: "AI assistant: roles, models and prices, spend caps, visitor limits and tone",
  }),
] as const;

export const flags = [] as const;
