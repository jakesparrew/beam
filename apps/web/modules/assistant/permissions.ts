/**
 * assistant permissions (docs/plan/modules/assistant.md section 6). Facade read by `pnpm gen:indexes`.
 * `assistant.read`: the overview, conversations, agent log and the person panel; taking over a chat.
 * `assistant.manage`: the settings (models, caps, tone) and the evaluation set.
 */
export const permissions = ["assistant.read", "assistant.manage"] as const;
