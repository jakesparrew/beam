"use server";
/**
 * assistant actions.
 * Staff (`assistant.read`): reply in a conversation (the first reply takes it over and silences the
 * agent there), hand it back to the agent, close it.
 * Staff (`assistant.manage`): save the settings, add or remove evaluation cases, run the evaluation
 * set on a model.
 * Staff: ask the lead agent for profile advice on a person (`assistant.read`) and carry out one of
 * its recommendations (`automations.move_person`).
 * Customer: allow or stop the coach using their check-ins (consent `ai_processing`, portal method,
 * the published wording).
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ForbiddenError } from "@beam/core/errors";
import { assistantConversations, assistantEvalCases, assistantMessages } from "@beam/db/schema";
import { action } from "@/lib/action";
import { eq, NotFoundError } from "@/lib/ctx";
import { getSettingWithVersion, setSetting } from "@/lib/settings";
import { currentWordingVersion, recordConsent } from "@/modules/crm/api";
import { AssistantSetting } from "./config";
import { applyRecommendation } from "./server/advise";
import { logAction } from "./server/store";

const read = { audience: "staff", permission: "assistant.read" } as const;
const manage = { audience: "staff", permission: "assistant.manage" } as const;

export const replyAsStaff = action(
  { name: "assistant.reply", ...read, input: z.object({ conversationId: z.uuid(), body: z.string().trim().min(1).max(4000) }), audit: false },
  async (ctx, input): Promise<{ messageId: string }> => {
    if (ctx.actor.kind !== "staff") throw new ForbiddenError("forbidden: staff");
    const [conv] = await ctx.tx.select().from(assistantConversations).where(eq(assistantConversations.id, input.conversationId)).for("update");
    if (!conv) throw new NotFoundError("conversation_not_found");
    const [msg] = await ctx.tx
      .insert(assistantMessages)
      .values({ conversationId: conv.id, author: "staff", staffUserId: ctx.actor.userId, body: input.body })
      .returning({ id: assistantMessages.id });
    await ctx.tx
      .update(assistantConversations)
      .set({ takenOverByUserId: conv.takenOverByUserId ?? ctx.actor.userId, status: conv.status === "closed" ? "open" : conv.status, lastMessageAt: ctx.now, updatedAt: ctx.now })
      .where(eq(assistantConversations.id, conv.id));
    if (!conv.takenOverByUserId) await logAction(ctx.tx, { conversationId: conv.id, personId: conv.personId, kind: "taken_over", detail: { user_id: ctx.actor.userId } });
    return { messageId: msg!.id };
  },
);

export const releaseConversation = action(
  { name: "assistant.release", ...read, input: z.object({ conversationId: z.uuid() }), audit: false },
  async (ctx, input): Promise<{ ok: true }> => {
    const [conv] = await ctx.tx.update(assistantConversations).set({ takenOverByUserId: null, status: "open", updatedAt: ctx.now }).where(eq(assistantConversations.id, input.conversationId)).returning();
    if (!conv) throw new NotFoundError("conversation_not_found");
    await logAction(ctx.tx, { conversationId: conv.id, personId: conv.personId, kind: "released" });
    return { ok: true };
  },
);

export const closeConversation = action(
  { name: "assistant.close", ...read, input: z.object({ conversationId: z.uuid() }), audit: false },
  async (ctx, input): Promise<{ ok: true }> => {
    const [conv] = await ctx.tx.update(assistantConversations).set({ status: "closed", updatedAt: ctx.now }).where(eq(assistantConversations.id, input.conversationId)).returning();
    if (!conv) throw new NotFoundError("conversation_not_found");
    await logAction(ctx.tx, { conversationId: conv.id, personId: conv.personId, kind: "closed" });
    await ctx.enqueue({ kind: "assistant.analyse_conversation", payload: { conversation_id: conv.id, force: true }, key: `assistant.analyse:${conv.id}:closed:${conv.messageCount}` });
    return { ok: true };
  },
);

export const saveAssistantSettings = action(
  { name: "assistant.save_settings", ...manage, input: AssistantSetting, audit: false },
  async (ctx, input): Promise<{ version: number }> => {
    const { version } = await getSettingWithVersion(ctx.tx, "assistant");
    return setSetting(ctx, "assistant", input, version);
  },
);

export const addEvalCase = action(
  { name: "assistant.add_eval_case", ...manage, input: z.object({ question: z.string().trim().min(3).max(1000), expectation: z.string().trim().min(3).max(1000), locale: z.enum(["nl-BE", "fr-BE", "en"]) }), audit: false },
  async (ctx, input): Promise<{ id: string }> => {
    const [row] = await ctx.tx.insert(assistantEvalCases).values(input).returning({ id: assistantEvalCases.id });
    return { id: row!.id };
  },
);

export const deleteEvalCase = action(
  { name: "assistant.delete_eval_case", ...manage, input: z.object({ id: z.uuid() }), audit: false },
  async (ctx, input): Promise<{ ok: true }> => {
    await ctx.tx.delete(assistantEvalCases).where(eq(assistantEvalCases.id, input.id));
    return { ok: true };
  },
);

export const runEvaluation = action(
  { name: "assistant.run_eval", ...manage, input: z.object({ models: z.array(z.string().min(3).max(120)).min(1).max(4) }), audit: false },
  async (ctx, input): Promise<{ runKey: string }> => {
    const runKey = `${ctx.now.toISOString().slice(0, 16)}-${randomUUID().slice(0, 6)}`;
    for (const model of input.models) await ctx.enqueue({ kind: "assistant.run_eval", payload: { run_key: runKey, model }, key: `assistant.eval:${runKey}:${model}` });
    return { runKey };
  },
);

export const advisePerson = action(
  { name: "assistant.advise_person", ...read, input: z.object({ personId: z.uuid() }), audit: false },
  async (ctx, input): Promise<{ queued: true }> => {
    await ctx.enqueue({ kind: "assistant.advise_person", payload: { person_id: input.personId }, key: `assistant.advise:${input.personId}:manual:${ctx.now.getTime()}` });
    return { queued: true };
  },
);

export const applyAdvice = action(
  { name: "assistant.apply_advice", audience: "staff", permission: "automations.move_person", input: z.object({ actionId: z.uuid(), index: z.number().int().min(0).max(5) }), audit: false },
  async (ctx, input): Promise<{ status: string; result: string | null }> => {
    const rec = await applyRecommendation(ctx.tx, ctx, input);
    if (!rec) throw new NotFoundError("advice_not_found");
    return { status: rec.status, result: rec.result ?? null };
  },
);

export const setCoachCheckins = action(
  { name: "assistant.set_coach_checkins", audience: "customer", input: z.object({ allowed: z.boolean() }), audit: false },
  async (ctx, input): Promise<{ allowed: boolean }> => {
    if (ctx.actor.kind !== "customer") throw new ForbiddenError("forbidden: customer");
    const wordingVersion = await currentWordingVersion(ctx.tx, "ai_processing");
    if (!wordingVersion) throw new NotFoundError("wording_not_published");
    await recordConsent(ctx.tx, ctx, {
      personId: ctx.actor.personId,
      purpose: "ai_processing",
      status: input.allowed ? "granted" : "withdrawn",
      method: "portal",
      source: "assistant_coach",
      wordingVersion,
    });
    await logAction(ctx.tx, { conversationId: null, personId: ctx.actor.personId, kind: "consent_recorded", detail: { purpose: "ai_processing", allowed: input.allowed } });
    return { allowed: input.allowed };
  },
);
