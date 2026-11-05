"use server";
/**
 * ops server actions, area `retention`: the weekly retention list (R2, ops spec 4.1, rules
 * 20-22). Each action wraps a function of `./build-list` in `action()` and writes its own audit
 * row (`retention.task_created`, `retention.tasks_created`, `retention.dismissed`,
 * `retention.rebuilt`). A "use server" file exports async functions only.
 */
import { CreateAllRetentionTasksInput, CreateRetentionTaskInput, DismissRetentionItemInput, RebuildRetentionListInput } from "@beam/core/ops";
import { action } from "@/lib/action";
import { buildWeeklyRetentionList, createAllRetentionItemTasks, createRetentionItemTask, dismissRetentionListItem, readRetentionDefaults, weekStartOf } from "./build-list";

/** Rule 21: one crm task for the item; a second click returns the same task. */
export const createRetentionTask = action(
  { name: "ops.retention_create_task", audience: "staff", permission: "tasks.all", input: CreateRetentionTaskInput, audit: false },
  async (ctx, input) => {
    const result = await createRetentionItemTask(ctx.tx, ctx, input);
    if (result.created) {
      await ctx.audit({ action: "retention.task_created", entityType: "retention_list_item", entityId: input.itemId, newValue: { taskId: result.taskId } });
    }
    return { taskId: result.taskId };
  },
);

/** Rule 21 "Create all tasks": every open item of the list, in one transaction. */
export const createAllRetentionTasks = action(
  { name: "ops.retention_create_all", audience: "staff", permission: "tasks.all", input: CreateAllRetentionTasksInput, audit: false },
  async (ctx, input) => {
    const result = await createAllRetentionItemTasks(ctx.tx, ctx, input);
    await ctx.audit({ action: "retention.tasks_created", entityType: "retention_list", entityId: input.listId, newValue: { created: result.created } });
    return { created: result.created };
  },
);

/** Rule 22: dismissing needs a reason and keeps the row. */
export const dismissRetentionItem = action(
  { name: "ops.retention_dismiss", audience: "staff", permission: "tasks.all", input: DismissRetentionItemInput, audit: false },
  async (ctx, input) => {
    const result = await dismissRetentionListItem(ctx.tx, ctx, input);
    if (!result.alreadyDismissed) {
      await ctx.audit({
        action: "retention.dismissed",
        entityType: "retention_list_item",
        entityId: input.itemId,
        personId: result.personId,
        newValue: { reason: input.reason, ...(input.note ? { note: input.note } : {}) },
      });
    }
    return { ok: true as const };
  },
);

/** Rule 20: rebuilds this week's list inside the action's transaction (the list lock). */
export const rebuildRetentionList = action(
  { name: "ops.retention_rebuild", audience: "staff", permission: "reports.read", input: RebuildRetentionListInput, audit: false },
  async (ctx) => {
    ctx.require("tasks.all");
    const weekStartOn = weekStartOf(ctx.now);
    const { listId, size } = await buildWeeklyRetentionList(ctx.tx, weekStartOn, await readRetentionDefaults(ctx.tx));
    await ctx.audit({ action: "retention.rebuilt", entityType: "retention_list", entityId: listId, newValue: { weekStartOn, size } });
    return { listId };
  },
);
