"use server";
/**
 * ops server actions, area `dashboard` (ops spec 4.1, ops-P3): "Create task" on a card row
 * (rule 22a). `tasks.all`; the handler is `createCardTask` in `./cards` (person lock, open-task
 * lookup, crm's `createTask` with the card's dedupe key). Audited as `task.created` when a task
 * is made; a repeat click returns the existing task without a second audit row.
 */
import { z } from "zod";
import { CreateTaskFromCardInput } from "@beam/core/ops";
import { action } from "@/lib/action";
import { createCardTask } from "./cards";
import { createFillDraft, getFillAudience } from "./fill-session";

const FillSessionInput = z.object({ sessionId: z.uuid() });

/** "Fill this session", step 1: how many people the draft would reach, per reason (`email.write`). */
export const previewFillSession = action(
  { name: "ops.preview_fill_session", audience: "staff", permission: "email.write", input: FillSessionInput, audit: false },
  (ctx, input) => getFillAudience(ctx.tx, { sessionId: input.sessionId, now: ctx.now }),
);

/** "Fill this session", step 2: a static segment of that audience and a campaign draft aimed at it; never sends. */
export const createFillSessionDraft = action(
  { name: "ops.create_fill_session_draft", audience: "staff", permission: "email.write", input: FillSessionInput, audit: false },
  (ctx, input) => createFillDraft(ctx.tx, ctx, { sessionId: input.sessionId, locale: ctx.locale }),
);

export const createTaskFromCard = action(
  { name: "ops.create_dashboard_task", audience: "staff", permission: "tasks.all", input: CreateTaskFromCardInput, audit: false },
  async (ctx, input) => {
    const result = await createCardTask(ctx.tx, ctx, input);
    if (result.created) {
      await ctx.audit({
        action: "task.created",
        entityType: "task",
        entityId: result.taskId,
        personId: input.personId,
        newValue: { card: input.card, refId: input.refId ?? input.personId },
      });
    }
    return result;
  },
);
