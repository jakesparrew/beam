"use server";
/**
 * ops server actions, area `dashboard` (ops spec 4.1, ops-P3): "Create task" on a card row
 * (rule 22a). `tasks.all`; the handler is `createCardTask` in `./cards` (person lock, open-task
 * lookup, crm's `createTask` with the card's dedupe key). Audited as `task.created` when a task
 * is made; a repeat click returns the existing task without a second audit row.
 */
import { CreateTaskFromCardInput } from "@beam/core/ops";
import { action } from "@/lib/action";
import { createCardTask } from "./cards";

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
