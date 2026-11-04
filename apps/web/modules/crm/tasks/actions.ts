"use server";
/**
 * Task actions (crm spec 4.1, rules 3.42 to 3.44), implemented by crm-P6. crm-P1 stubs.
 * Permission `persons.read` for own tasks; the handler requires `tasks.all` for others' tasks.
 */
import { z } from "zod";
import { NotImplementedError } from "@beam/core/errors";
import { action } from "@/lib/action";

const todo =
  <O>(name: string) =>
  (): Promise<O> =>
    Promise.reject(new NotImplementedError(name));

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

export const createTask = action({ name: "crm.save_task", audience: "staff", permission: "persons.read", input: TaskInput }, todo<{ taskId: string }>("crm.save_task"));

export const updateTask = action(
  { name: "crm.save_task", audience: "staff", permission: "persons.read", input: TaskInput.extend({ id: z.uuid() }) },
  todo<{ taskId: string }>("crm.save_task"),
);

export const completeTask = action({ name: "crm.complete_task", audience: "staff", permission: "persons.read", input: ById }, todo<Record<string, never>>("crm.complete_task"));

export const cancelTask = action({ name: "crm.cancel_task", audience: "staff", permission: "persons.read", input: ById }, todo<Record<string, never>>("crm.cancel_task"));

export const reopenTask = action({ name: "crm.reopen_task", audience: "staff", permission: "persons.read", input: ById }, todo<Record<string, never>>("crm.reopen_task"));
