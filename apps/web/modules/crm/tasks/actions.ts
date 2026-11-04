"use server";
/**
 * Task actions (crm spec 4.1, rules 3.42 to 3.44), crm-P6. Permission `persons.read` for own
 * tasks; the handlers in `./api` require `tasks.all` for anyone else's task. Each handler
 * writes its own audit row (`task.save`, `task.status`), so the wrapper's row is off.
 */
import { z } from "zod";
import { action } from "@/lib/action";
import { saveStaffTask, transitionTask } from "./api";

const TaskInput = z.object({
  id: z.uuid().optional(),
  title: z.string().trim().min(1).max(200),
  kind: z.enum(["call", "follow_up", "payment", "proposal", "review", "other"]),
  dueAt: z.coerce.date().optional(),
  priority: z.enum(["low", "normal", "high"]),
  ownerUserId: z.uuid(),
  personId: z.uuid().optional(),
  companyId: z.uuid().optional(),
  notes: z.string().max(5000).optional(),
});
const ById = z.object({ id: z.uuid() });

export const createTask = action(
  { name: "crm.save_task", audience: "staff", permission: "persons.read", input: TaskInput.omit({ id: true }), audit: false },
  (ctx, input) => saveStaffTask(ctx, input),
);

export const updateTask = action(
  { name: "crm.save_task", audience: "staff", permission: "persons.read", input: TaskInput.extend({ id: z.uuid() }), audit: false },
  (ctx, input) => saveStaffTask(ctx, input),
);

export const completeTask = action(
  { name: "crm.complete_task", audience: "staff", permission: "persons.read", input: ById, audit: false },
  (ctx, input) => transitionTask(ctx, input.id, "complete"),
);

export const cancelTask = action(
  { name: "crm.cancel_task", audience: "staff", permission: "persons.read", input: ById, audit: false },
  (ctx, input) => transitionTask(ctx, input.id, "cancel"),
);

export const reopenTask = action(
  { name: "crm.reopen_task", audience: "staff", permission: "persons.read", input: ById, audit: false },
  (ctx, input) => transitionTask(ctx, input.id, "reopen"),
);
