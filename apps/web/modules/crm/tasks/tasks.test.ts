/**
 * crm-P6 tasks (rules 3.42 to 3.44): every allowed transition and `conflict` on the others
 * (`done → cancelled` among them), reopen clears `done_at`, own-only without `tasks.all`,
 * overdue and due today in Brussels time, the dedupe key, and owner role resolution.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { activityEvents, auditLog, tasks } from "@beam/db/schema";
import type { TaskStatus } from "@beam/core/crm";

process.env.SENSITIVE_DATA_KEY_V1 ??= randomBytes(32).toString("base64");
process.env.AUTH_SECRET = "crm-p6-tasks-secret";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.61" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));

const api = await import("./api");
const actions = await import("./actions");
const { listTasks, getTaskCounts } = await import("./queries");
const auth = await import("@/lib/auth");
const { and, eq, setAppDb } = await import("@/lib/ctx");
const { makeCtx, resetRuntime, staffActor } = await import("@/lib/testing");

let h: DbHandle;

beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(() => jar.clear());

type Staff = ReturnType<typeof staffActor>;
const tx = () => h.db as unknown as Parameters<typeof api.createTask>[0];

async function staff(permissions: string[] = ["persons.read"], overrides: Parameters<typeof makeUser>[1] = {}): Promise<Staff> {
  const user = await makeUser(h.db, { roleKey: "customer_service", ...overrides });
  return staffActor({ userId: user.id, roleKey: user.roleKey ?? "customer_service", permissions });
}

const ctxFor = (actor: Staff, now = new Date()) => makeCtx(h.db, { actor, now });

async function newTask(owner: Staff, extra: Partial<Parameters<typeof api.createTask>[2]> = {}) {
  const person = await makePerson(h.db);
  const { taskId } = await api.createTask(tx(), ctxFor(owner), { title: "Call back", kind: "call", source: "manual", ownerUserId: owner.userId, personId: person.id, ...extra });
  return { taskId, personId: person.id };
}

const taskRow = async (id: string) => (await h.db.select().from(tasks).where(eq(tasks.id, id)))[0]!;
const eventsOf = (taskId: string) =>
  h.db
    .select()
    .from(activityEvents)
    .where(and(eq(activityEvents.refType, "task"), eq(activityEvents.refId, taskId)));

describe("rule 3.42 transitions", () => {
  it("allows exactly open → done, open → cancelled, done → open and cancelled → open", () => {
    const statuses: TaskStatus[] = ["open", "done", "cancelled"];
    const allowed = new Set(["open:complete:done", "open:cancel:cancelled", "done:reopen:open", "cancelled:reopen:open"]);
    for (const from of statuses) {
      for (const t of ["complete", "cancel", "reopen"] as const) {
        const to = api.nextTaskStatus(from, t);
        if (to) expect(allowed.has(`${from}:${t}:${to}`)).toBe(true);
        else expect([...allowed].some((a) => a.startsWith(`${from}:${t}:`))).toBe(false);
      }
    }
  });

  it("completes, refuses done → cancelled, reopens (clearing done_at and done_by), cancels and reopens", async () => {
    const owner = await staff();
    const { taskId, personId } = await newTask(owner);
    const ctx = ctxFor(owner);

    expect(await api.transitionTask(ctx, taskId, "complete")).toEqual({ status: "done" });
    let row = await taskRow(taskId);
    expect(row.status).toBe("done");
    expect(row.doneAt).toBeInstanceOf(Date);
    expect(row.doneByUserId).toBe(owner.userId);

    await expect(api.transitionTask(ctx, taskId, "cancel")).rejects.toMatchObject({ code: "conflict" });
    await expect(api.transitionTask(ctx, taskId, "complete")).rejects.toMatchObject({ code: "conflict" });

    expect(await api.transitionTask(ctx, taskId, "reopen")).toEqual({ status: "open" });
    row = await taskRow(taskId);
    expect(row).toMatchObject({ status: "open", doneAt: null, doneByUserId: null });
    await expect(api.transitionTask(ctx, taskId, "reopen")).rejects.toMatchObject({ code: "conflict" });

    expect(await api.transitionTask(ctx, taskId, "cancel")).toEqual({ status: "cancelled" });
    await expect(api.transitionTask(ctx, taskId, "complete")).rejects.toMatchObject({ code: "conflict" });
    await expect(api.transitionTask(ctx, taskId, "cancel")).rejects.toMatchObject({ code: "conflict" });
    expect(await api.transitionTask(ctx, taskId, "reopen")).toEqual({ status: "open" });

    const kinds = (await eventsOf(taskId)).map((e) => e.kind);
    expect(kinds).toEqual(["task.created", "task.completed", "task.reopened", "task.cancelled", "task.reopened"]);
    expect((await eventsOf(taskId)).every((e) => e.personId === personId)).toBe(true);
    const audits = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "task.status"), eq(auditLog.entityId, taskId)));
    expect(audits).toHaveLength(4);
  });

  it("answers an invalid transition through the action with `conflict`", async () => {
    const owner = await makeUser(h.db, { roleKey: "owner" });
    const { token } = await auth.createAuthSession(h.db, { userId: owner.id, audience: "staff", roleKey: "owner", now: new Date(), mfaAt: new Date() });
    jar.set(auth.SESSION_COOKIE, token);
    const created = await actions.createTask({ title: "Send the proposal", kind: "proposal", priority: "high", ownerUserId: owner.id });
    expect(created.ok).toBe(true);
    const id = (created as { data: { taskId: string } }).data.taskId;
    expect(await actions.completeTask({ id })).toEqual({ ok: true, data: { status: "done" } });
    expect(await actions.cancelTask({ id })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(await actions.reopenTask({ id })).toEqual({ ok: true, data: { status: "open" } });
    expect(await h.db.select().from(auditLog).where(and(eq(auditLog.action, "task.save"), eq(auditLog.entityId, id)))).toHaveLength(1);
  });
});

describe("own-only without tasks.all (rule 3.42)", () => {
  it("lets a user without tasks.all create, edit and move only their own tasks", async () => {
    const me = await staff();
    const other = await staff();
    const { taskId: othersTask } = await newTask(other);

    await expect(api.saveStaffTask(ctxFor(me), { title: "For someone else", kind: "other", priority: "normal", ownerUserId: other.userId })).rejects.toMatchObject({
      name: "ForbiddenError",
    });
    await expect(api.transitionTask(ctxFor(me), othersTask, "complete")).rejects.toMatchObject({ name: "ForbiddenError" });
    await expect(
      api.saveStaffTask(ctxFor(me), { id: othersTask, title: "Take over", kind: "call", priority: "normal", ownerUserId: me.userId }),
    ).rejects.toMatchObject({ name: "ForbiddenError" });

    const { taskId: mine } = await api.saveStaffTask(ctxFor(me), { title: "Mine", kind: "follow_up", priority: "low", ownerUserId: me.userId });
    await expect(api.saveStaffTask(ctxFor(me), { id: mine, title: "Hand over", kind: "follow_up", priority: "low", ownerUserId: other.userId })).rejects.toMatchObject({
      name: "ForbiddenError",
    });
    expect((await taskRow(mine)).ownerUserId).toBe(me.userId);

    const mineOnly = await listTasks(h.db, { userId: me.userId, scope: "mine" });
    expect(mineOnly.map((t) => t.id)).toEqual([mine]);
  });

  it("lets a user with tasks.all reassign and complete anyone's task", async () => {
    const lead = await staff(["persons.read", "tasks.all"]);
    const other = await staff();
    const { taskId } = await newTask(other);
    await api.saveStaffTask(ctxFor(lead), { id: taskId, title: "Call back today", kind: "call", priority: "high", ownerUserId: lead.userId });
    expect(await taskRow(taskId)).toMatchObject({ ownerUserId: lead.userId, title: "Call back today", priority: "high" });
    expect(await api.transitionTask(ctxFor(lead), taskId, "complete")).toEqual({ status: "done" });
    expect((await taskRow(taskId)).doneByUserId).toBe(lead.userId);
    const all = await listTasks(h.db, { userId: lead.userId, scope: "all" });
    expect(all.some((t) => t.id === taskId)).toBe(true);
  });
});

describe("overdue and due today (rule 3.43, Europe/Brussels)", () => {
  it("uses the Brussels calendar day and lists overdue tasks first", async () => {
    const owner = await staff();
    // 23:30 in Brussels (CET, UTC+1) on 10 March; in UTC it is still 10 March, 22:30.
    const now = new Date("2026-03-10T22:30:00Z");
    const make = (title: string, dueAt: Date | undefined) => api.createTask(tx(), ctxFor(owner, now), { title, kind: "call", source: "manual", ownerUserId: owner.userId, ...(dueAt ? { dueAt } : {}) });

    const earlyToday = await make("00:30 Brussels today (9 March in UTC)", new Date("2026-03-09T23:30:00Z"));
    const laterToday = await make("23:45 Brussels today", new Date("2026-03-10T22:45:00Z"));
    const tomorrow = await make("00:15 Brussels tomorrow (10 March in UTC)", new Date("2026-03-10T23:15:00Z"));
    const yesterday = await make("Yesterday in Brussels", new Date("2026-03-09T22:30:00Z"));
    const noDue = await make("No deadline", undefined);
    const doneLate = await make("Done although late", new Date("2026-03-01T09:00:00Z"));
    await api.transitionTask(ctxFor(owner, now), doneLate.taskId, "complete");

    const rows = await listTasks(h.db, { userId: owner.userId, scope: "mine", now });
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(earlyToday.taskId)).toMatchObject({ isOverdue: true, isDueToday: true });
    expect(byId.get(laterToday.taskId)).toMatchObject({ isOverdue: false, isDueToday: true });
    expect(byId.get(tomorrow.taskId)).toMatchObject({ isOverdue: false, isDueToday: false });
    expect(byId.get(yesterday.taskId)).toMatchObject({ isOverdue: true, isDueToday: false });
    expect(byId.get(noDue.taskId)).toMatchObject({ isOverdue: false, isDueToday: false });
    expect(byId.get(doneLate.taskId)).toMatchObject({ isOverdue: false, status: "done" });

    // Overdue first (oldest due first), then the other open tasks by due date, then closed ones.
    expect(rows.map((r) => r.id)).toEqual([yesterday.taskId, earlyToday.taskId, laterToday.taskId, tomorrow.taskId, noDue.taskId, doneLate.taskId]);

    const today = await listTasks(h.db, { userId: owner.userId, scope: "mine", dueToday: true, now });
    expect(today.map((r) => r.id).sort()).toEqual([earlyToday.taskId, laterToday.taskId].sort());
    const overdue = await listTasks(h.db, { userId: owner.userId, scope: "mine", overdueOnly: true, now });
    expect(overdue.map((r) => r.id)).toEqual([yesterday.taskId, earlyToday.taskId]);

    expect(await getTaskCounts(h.db, owner.userId, { now })).toEqual({ open: 5, overdue: 2, dueToday: 2 });
  });

  it("counts open and overdue tasks across owners for the ops digest", async () => {
    const owner = await staff();
    const before = { open: await api.countOpenTasks(h.db, { source: "retention" }), overdue: await api.countOpenTasks(h.db, { overdue: true, source: "retention" }) };
    await api.createTask(tx(), ctxFor(owner), { title: "Win back", kind: "call", source: "retention", ownerUserId: owner.userId, dueAt: new Date(Date.now() - 3_600_000) });
    await api.createTask(tx(), ctxFor(owner), { title: "Win back later", kind: "call", source: "retention", ownerUserId: owner.userId, dueAt: new Date(Date.now() + 86_400_000) });
    expect(await api.countOpenTasks(h.db, { source: "retention" })).toBe(before.open + 2);
    expect(await api.countOpenTasks(h.db, { overdue: true, source: "retention" })).toBe(before.overdue + 1);
    expect(await api.countOpenTasks(h.db, { kind: "payment", source: "retention" })).toBe(0);
  });
});

describe("dedupe key (rule 3.44)", () => {
  it("creates a task with a dedupe key at most once", async () => {
    const owner = await staff();
    const person = await makePerson(h.db);
    const key = `automation:${randomUUID()}:call_step`;
    const input = { title: "Call after the workshop", kind: "call" as const, source: "automation" as const, ownerUserId: owner.userId, personId: person.id, dedupeKey: key };
    const system = makeCtx(h.db);
    const first = await api.createTask(tx(), system, input);
    const second = await api.createTask(tx(), system, { ...input, title: "Changed title" });
    expect(first.created).toBe(true);
    expect(second).toEqual({ taskId: first.taskId, created: false });
    const rows = await h.db.select().from(tasks).where(eq(tasks.dedupeKey, key));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: "Call after the workshop", source: "automation", createdBy: { kind: "system" } });
    expect(await eventsOf(first.taskId)).toHaveLength(1);
  });
});

describe("owner resolution (rule 3.42: a task needs an owner)", () => {
  it("takes the first active user of ownerRole, else the owner role holder", async () => {
    await makeUser(h.db, { roleKey: "finance", name: "Aaron Disabled", status: "disabled" });
    const first = await makeUser(h.db, { roleKey: "finance", name: "Abby Finance" });
    await makeUser(h.db, { roleKey: "finance", name: "Zoe Finance" });
    const ownerHolder = await makeUser(h.db, { roleKey: "owner", name: "Aaa Owner" });
    const system = makeCtx(h.db);

    const byRole = await api.createTask(tx(), system, { title: "Payment failed", kind: "payment", source: "system", ownerRole: "finance" });
    expect((await taskRow(byRole.taskId)).ownerUserId).toBe(first.id);

    const fallback = await api.createTask(tx(), system, { title: "No marketing user yet", kind: "review", source: "system", ownerRole: "marketing" });
    expect((await taskRow(fallback.taskId)).ownerUserId).toBe(ownerHolder.id);

    const none = await api.createTask(tx(), system, { title: "No owner given", kind: "other", source: "system" });
    expect((await taskRow(none.taskId)).ownerUserId).toBe(ownerHolder.id);

    const me = await staff();
    const own = await api.createTask(tx(), ctxFor(me), { title: "Mine by default", kind: "other", source: "manual" });
    expect((await taskRow(own.taskId)).ownerUserId).toBe(me.userId);
  });

  it("records no timeline event for a task without a person or company", async () => {
    const me = await staff();
    const { taskId } = await api.createTask(tx(), ctxFor(me), { title: "Tidy the desk", kind: "other", source: "manual", ownerUserId: me.userId });
    await api.transitionTask(ctxFor(me), taskId, "complete");
    expect(await eventsOf(taskId)).toHaveLength(0);
  });
});
