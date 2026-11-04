/**
 * Task api (crm rules 3.42 to 3.44), crm-P6. `createTask` and `countOpenTasks` are the
 * cross-module door (re-exported by `../api`); `saveStaffTask` and `transitionTask` are the
 * handlers of the staff actions in `./actions`, kept here so the actions file stays thin and
 * the rules are testable with a plain `Ctx`.
 */
import type { DbOrTx, Tx } from "@beam/db";
import { tasks, type RoleKey } from "@beam/db/schema";
import { ForbiddenError } from "@beam/core/errors";
import type { TaskKind, TaskPriority, TaskSource, TaskStatus } from "@beam/core/crm";
import { actorHasPermission, actorJson, and, ConflictError, eq, lt, NotFoundError, sql, ValidationError, type Actor, type Ctx, type SQL } from "@/lib/ctx";
import { listStaffForAssignment } from "@/modules/platform/api";
import type { EventCtx } from "../api";

export type TaskTransition = "complete" | "cancel" | "reopen";

/** Rule 3.42: the only allowed transitions; anything else is `conflict`. */
const TRANSITIONS: Record<TaskTransition, { from: readonly TaskStatus[]; to: TaskStatus; event: "task.completed" | "task.cancelled" | "task.reopened" }> = {
  complete: { from: ["open"], to: "done", event: "task.completed" },
  cancel: { from: ["open"], to: "cancelled", event: "task.cancelled" },
  reopen: { from: ["done", "cancelled"], to: "open", event: "task.reopened" },
};

/** The status a transition leads to, or `null` when rule 3.42 does not allow it. */
export function nextTaskStatus(from: TaskStatus, transition: TaskTransition): TaskStatus | null {
  const t = TRANSITIONS[transition];
  return t.from.includes(from) ? t.to : null;
}

/** `ownerUserId`, else the first active user of `ownerRole`, else the first active owner (rule 3.42: a task needs an owner). */
export async function resolveTaskOwner(tx: DbOrTx, input: { ownerUserId?: string; ownerRole?: RoleKey }, actor?: Actor): Promise<string> {
  if (input.ownerUserId) return input.ownerUserId;
  if (input.ownerRole) {
    const [first] = await listStaffForAssignment(tx, { roleKey: input.ownerRole });
    if (first) return first.userId;
  } else if (actor?.kind === "staff") {
    return actor.userId;
  }
  const [owner] = await listStaffForAssignment(tx, { roleKey: "owner" });
  if (!owner) throw new ValidationError("task_owner_missing", { ownerUserId: "task_owner_missing" });
  return owner.userId;
}

type TaskRecord = typeof tasks.$inferSelect;

async function recordTaskEvent(ctx: EventCtx, task: Pick<TaskRecord, "id" | "personId" | "companyId">, kind: TaskTransition | "created", extra: Record<string, unknown> = {}): Promise<void> {
  if (!task.personId && !task.companyId) return; // `task.*` events need a subject; a free-standing task has no timeline
  const eventKind = kind === "created" ? "task.created" : TRANSITIONS[kind].event;
  await ctx.recordEvent({
    kind: eventKind,
    ...(task.personId ? { personId: task.personId } : {}),
    ...(task.companyId ? { companyId: task.companyId } : {}),
    ref: { type: "task", id: task.id },
    data: { task_id: task.id, ...extra },
    ...(kind === "created" ? { dedupeKey: `task:${task.id}:created` } : {}),
  });
}

/**
 * Creates one task (rule 3.44: a `dedupeKey` is created at most once; a repeat returns the
 * existing task with `created: false`). `ownerRole` resolves to the first active user of that
 * role, else the owner role holder.
 */
export async function createTask(
  tx: Tx,
  ctx: EventCtx,
  input: {
    title: string;
    kind: TaskKind;
    ownerUserId?: string;
    ownerRole?: RoleKey;
    dueAt?: Date;
    priority?: TaskPriority;
    personId?: string;
    companyId?: string;
    source: TaskSource;
    ref?: { type: string; id: string };
    notes?: string;
    dedupeKey?: string;
  },
): Promise<{ taskId: string; created: boolean }> {
  const title = input.title.trim().slice(0, 200);
  if (!title) throw new ValidationError("validation", { title: "required" });
  if (input.dedupeKey) {
    const existing = await findByDedupeKey(tx, input.dedupeKey);
    if (existing) return { taskId: existing, created: false };
  }
  const ownerUserId = await resolveTaskOwner(tx, input, ctx.actor);
  const [row] = await tx
    .insert(tasks)
    .values({
      ownerUserId,
      title,
      kind: input.kind,
      dueAt: input.dueAt ?? null,
      priority: input.priority ?? "normal",
      source: input.source,
      personId: input.personId ?? null,
      companyId: input.companyId ?? null,
      refType: input.ref?.type ?? null,
      refId: input.ref?.id ?? null,
      notes: input.notes ?? null,
      createdBy: actorJson(ctx.actor),
      dedupeKey: input.dedupeKey ?? null,
    })
    .onConflictDoNothing({ target: tasks.dedupeKey })
    .returning();
  if (!row) {
    const existing = input.dedupeKey ? await findByDedupeKey(tx, input.dedupeKey) : null;
    if (!existing) throw new ConflictError("task_dedupe_race");
    return { taskId: existing, created: false };
  }
  await recordTaskEvent(ctx, row, "created", { kind: row.kind, source: row.source });
  return { taskId: row.id, created: true };
}

async function findByDedupeKey(tx: DbOrTx, key: string): Promise<string | null> {
  const [row] = await tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.dedupeKey, key)).limit(1);
  return row?.id ?? null;
}

/** Open tasks across all owners (ops daily digest); `overdue` counts `due_at < now()` only (rule 3.43). */
export async function countOpenTasks(tx: DbOrTx, filter: { overdue?: boolean; kind?: TaskKind; source?: TaskSource }): Promise<number> {
  const where: SQL[] = [eq(tasks.status, "open")];
  if (filter.overdue) where.push(lt(tasks.dueAt, sql`now()`));
  if (filter.kind) where.push(eq(tasks.kind, filter.kind));
  if (filter.source) where.push(eq(tasks.source, filter.source));
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(tasks)
    .where(and(...where));
  return Number(row?.n ?? 0);
}

// ---------------------------------------------------------------------------
// Staff handlers (the actions in ./actions)
// ---------------------------------------------------------------------------

export type StaffTaskInput = {
  id?: string;
  title: string;
  kind: TaskKind;
  dueAt?: Date;
  priority: TaskPriority;
  ownerUserId: string;
  personId?: string;
  companyId?: string;
  notes?: string;
};

function staffOf(ctx: Ctx): Extract<Actor, { kind: "staff" }> {
  if (ctx.actor.kind !== "staff") throw new ForbiddenError("forbidden: staff", "persons.read");
  return ctx.actor;
}

/** Rule 3.42: without `tasks.all` a user only touches tasks they own. */
function requireOwnOrAll(actor: Extract<Actor, { kind: "staff" }>, ownerUserId: string): void {
  if (ownerUserId !== actor.userId && !actorHasPermission(actor, "tasks.all")) throw new ForbiddenError("forbidden: tasks.all", "tasks.all");
}

async function lockTask(tx: Tx, id: string): Promise<TaskRecord> {
  const [row] = await tx.select().from(tasks).where(eq(tasks.id, id)).for("update");
  if (!row) throw new NotFoundError("task_not_found");
  return row;
}

const auditView = (t: TaskRecord) => ({
  title: t.title,
  kind: t.kind,
  dueAt: t.dueAt,
  priority: t.priority,
  status: t.status,
  ownerUserId: t.ownerUserId,
  personId: t.personId,
  companyId: t.companyId,
  notes: t.notes,
});

/** `createTask` / `updateTask` (`crm.save_task`, audit `task.save`). */
export async function saveStaffTask(ctx: Ctx, input: StaffTaskInput): Promise<{ taskId: string }> {
  const actor = staffOf(ctx);
  requireOwnOrAll(actor, input.ownerUserId);
  if (!input.id) {
    const { taskId } = await createTask(ctx.tx, ctx, {
      title: input.title,
      kind: input.kind,
      ownerUserId: input.ownerUserId,
      priority: input.priority,
      source: "manual",
      ...(input.dueAt ? { dueAt: input.dueAt } : {}),
      ...(input.personId ? { personId: input.personId } : {}),
      ...(input.companyId ? { companyId: input.companyId } : {}),
      ...(input.notes ? { notes: input.notes } : {}),
    });
    const [row] = await ctx.tx.select().from(tasks).where(eq(tasks.id, taskId));
    await ctx.audit({ action: "task.save", entityType: "tasks", entityId: taskId, personId: input.personId ?? null, newValue: auditView(row!) });
    return { taskId };
  }
  const before = await lockTask(ctx.tx, input.id);
  requireOwnOrAll(actor, before.ownerUserId);
  const [after] = await ctx.tx
    .update(tasks)
    .set({
      title: input.title.trim(),
      kind: input.kind,
      dueAt: input.dueAt ?? null,
      priority: input.priority,
      ownerUserId: input.ownerUserId,
      personId: input.personId ?? null,
      companyId: input.companyId ?? null,
      notes: input.notes ?? null,
      updatedAt: ctx.now,
    })
    .where(eq(tasks.id, input.id))
    .returning();
  await ctx.audit({ action: "task.save", entityType: "tasks", entityId: input.id, personId: after!.personId, oldValue: auditView(before), newValue: auditView(after!) });
  return { taskId: input.id };
}

/** `completeTask` / `cancelTask` / `reopenTask` (rule 3.42, row locked `FOR UPDATE`, audit `task.status`). */
export async function transitionTask(ctx: Ctx, id: string, transition: TaskTransition): Promise<{ status: TaskStatus }> {
  const actor = staffOf(ctx);
  const before = await lockTask(ctx.tx, id);
  requireOwnOrAll(actor, before.ownerUserId);
  const to = nextTaskStatus(before.status, transition);
  if (!to) throw new ConflictError(`invalid_transition: ${before.status} -> ${TRANSITIONS[transition].to}`);
  const done = to === "done";
  const [after] = await ctx.tx
    .update(tasks)
    .set({ status: to, doneAt: done ? ctx.now : null, doneByUserId: done ? actor.userId : null, updatedAt: ctx.now })
    .where(eq(tasks.id, id))
    .returning();
  await recordTaskEvent(ctx, after!, transition);
  await ctx.audit({
    action: "task.status",
    entityType: "tasks",
    entityId: id,
    personId: after!.personId,
    oldValue: { status: before.status, doneAt: before.doneAt },
    newValue: { status: after!.status, doneAt: after!.doneAt },
  });
  return { status: to };
}
