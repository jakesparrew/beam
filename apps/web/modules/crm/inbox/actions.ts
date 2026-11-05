"use server";
/**
 * Inbox actions (crm spec 4.2), crm-P9. Thread actions need `persons.write`, reply templates
 * `settings.write`. The handlers in `./api` write their own audit rows (`inbox.update|reply|
 * note|link|sensitive|template`), so the wrapper's row is off. Only async functions are
 * exported (OD-18).
 *
 * R4 (crm-P10): `requestAiDraft` (`ai.use`, audit `ai.request`), `discardAiDraft`
 * (`persons.write`) and `loadAiDraftPanel` (`persons.read`, the panel's state and labels, polled
 * while a draft is pending). `replyToThread` with `usedAiDraftMessageId` marks that draft `used`.
 */
import { z } from "zod";
import { INBOX_THREAD_STATUSES } from "@beam/db/schema";
import { LOCALES, LocalizedTextSchema } from "@beam/core/i18n";
import { action } from "@/lib/action";
import { actorHasPermission } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { discardDraft, getAiDraftState, replyWithDraft, requestDraft } from "./ai-draft";
import { addStaffThreadNote, linkStaffThreadPerson, markStaffThreadSensitive, saveStaffReplyTemplate, updateStaffThread } from "./api";

const UpdateThreadInput = z.object({ threadId: z.uuid(), assigneeUserId: z.uuid().nullable().optional(), status: z.enum(INBOX_THREAD_STATUSES).optional() });
const updateThread = action(
  { name: "crm.update_thread", audience: "staff", permission: "persons.write", input: UpdateThreadInput, audit: false },
  (ctx, input) => updateStaffThread(ctx, input),
);

/** `crm.update_thread`: assign (or unassign with `null`). */
export async function assignThread(input: { threadId: string; assigneeUserId: string | null }) {
  return updateThread(input);
}

/** `crm.update_thread`: set the status (rule 3.57 staff moves). */
export async function setThreadStatus(input: { threadId: string; status: (typeof INBOX_THREAD_STATUSES)[number] }) {
  return updateThread(input);
}

export const replyToThread = action(
  {
    name: "crm.reply_thread",
    audience: "staff",
    permission: "persons.write",
    input: z.object({ threadId: z.uuid(), body: z.string().trim().min(1).max(20_000), templateKey: z.string().max(64).optional(), usedAiDraftMessageId: z.uuid().optional() }),
    audit: false,
  },
  (ctx, input) => replyWithDraft(ctx, input),
);

export const addThreadNote = action(
  { name: "crm.note_thread", audience: "staff", permission: "persons.write", input: z.object({ threadId: z.uuid(), body: z.string().trim().min(1).max(20_000) }), audit: false },
  (ctx, input) => addStaffThreadNote(ctx, input),
);

export const linkThreadPerson = action(
  {
    name: "crm.link_thread",
    audience: "staff",
    permission: "persons.write",
    input: z
      .object({ threadId: z.uuid(), personId: z.uuid().optional(), createFromSender: z.object({ locale: z.enum(LOCALES) }).optional() })
      .refine((v) => !!v.personId !== !!v.createFromSender, { message: "person_or_create", path: ["personId"] }),
    audit: false,
  },
  (ctx, input) => linkStaffThreadPerson(ctx, input),
);

export const markThreadSensitive = action(
  { name: "crm.mark_thread_sensitive", audience: "staff", permission: "persons.write", input: z.object({ threadId: z.uuid(), isSensitive: z.boolean() }), audit: false },
  (ctx, input) => markStaffThreadSensitive(ctx, input),
);

export const saveReplyTemplate = action(
  {
    name: "crm.save_reply_template",
    audience: "staff",
    permission: "settings.write",
    input: z.object({
      id: z.uuid().optional(),
      key: z.string().regex(/^[a-z0-9_-]{2,64}$/),
      name: LocalizedTextSchema,
      body: LocalizedTextSchema,
      isActive: z.boolean(),
    }),
    audit: false,
  },
  (ctx, input) => saveStaffReplyTemplate(ctx, input),
);

// ---------------------------------------------------------------------------
// R4: AI reply drafts (crm-P10)
// ---------------------------------------------------------------------------

const MessageInput = z.object({ messageId: z.uuid() });

export const requestAiDraft = action(
  { name: "crm.request_ai_draft", audience: "staff", permission: "ai.use", input: MessageInput, audit: false },
  (ctx, input) => requestDraft(ctx, input),
);

export const discardAiDraft = action(
  { name: "crm.discard_ai_draft", audience: "staff", permission: "persons.write", input: MessageInput, audit: false },
  (ctx, input) => discardDraft(ctx, input),
);

const PANEL_LABELS = [
  "title",
  "hint",
  "request",
  "regenerate",
  "pending",
  "ready",
  "use",
  "discard",
  "sending",
  "failed",
  "blocked",
  "thread_sensitive",
  "used",
  "discarded",
  "error",
  "pending_conflict",
  "no_permission",
  "sent",
] as const;
export type AiDraftPanelLabelKey = (typeof PANEL_LABELS)[number];

const loadPanel = action(
  { name: "crm.load_ai_draft", audience: "staff", permission: "persons.read", input: z.object({ threadId: z.uuid() }), audit: false },
  async (ctx, input) => {
    const tr = translator(await adminLocale());
    const labels = Object.fromEntries(PANEL_LABELS.map((k) => [k, tr(`crm.inbox.ai.${k}`)])) as Record<AiDraftPanelLabelKey, string>;
    return {
      state: await getAiDraftState(ctx.tx, input.threadId),
      canRequest: actorHasPermission(ctx.actor, "ai.use"),
      canSend: actorHasPermission(ctx.actor, "persons.write"),
      labels,
    };
  },
);

/** The AI draft panel's state and labels for one thread (`persons.read`). */
export async function loadAiDraftPanel(input: { threadId: string }) {
  return loadPanel(input);
}
