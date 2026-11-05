/**
 * ops rules 21 and 22 (ops-P7): "Create task", "Create all tasks" and "Dismiss" on the weekly
 * retention list. The handlers of the actions in `./actions` are the `./build-list` functions
 * tested here with a staff context; crm's `createTask` is wrapped in a `vi.fn` that calls the
 * real one, so the test sees its exact arguments and the real task rows.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { DbHandle, Tx } from "@beam/db";
import { personStats, retentionListItems, retentionLists, tasks } from "@beam/db/schema";
import { t } from "@beam/core/i18n";
import { DismissRetentionItemInput, RETENTION_DEFAULTS } from "@beam/core/ops";
import { createTestDb, makeUser } from "@beam/db/testing";
import type * as CrmApi from "@/modules/crm/api";

const crm = vi.hoisted(() => ({ createTask: undefined as unknown as Mock<typeof CrmApi.createTask>, failFor: new Set<string>() }));
vi.mock("@/modules/crm/api", async (importOriginal) => {
  const actual = await importOriginal<typeof CrmApi>();
  crm.createTask = vi.fn((tx, ctx, input) => {
    if (input.personId && crm.failFor.has(input.personId)) throw new Error("crm down");
    return actual.createTask(tx, ctx, input);
  });
  return { ...actual, createTask: crm.createTask };
});

const { asc, createCtx, eq, inArray, sql, ValidationError } = await import("@/lib/ctx");
const { resetRuntime, staffActor } = await import("@/lib/testing");
const { ago, makeCustomer } = await import("../dashboard/ops-p3.fixtures");
const { buildWeeklyRetentionList, createAllRetentionItemTasks, createRetentionItemTask, dismissRetentionListItem } = await import("./build-list");

let h: DbHandle;
const NOW = new Date("2026-11-10T14:00:00Z"); // a Tuesday: the next business day is Wednesday 11 November... a Belgian holiday

beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  crm.createTask.mockClear();
  crm.failFor.clear();
  await h.db.execute(sql`update persons set is_tester = true where is_tester = false`);
  await h.db.delete(retentionLists);
});

const ctxFor = (tx: Tx, userId: string) => createCtx({ tx, actor: staffActor({ userId, permissions: ["tasks.all", "reports.read"] }), now: NOW, durableMode: "immediate" });

/** A list with one item per revenue figure (high-value inactive customers, ranked by revenue). */
async function list(revenues: number[]) {
  for (const revenueCents of revenues) {
    const p = await makeCustomer(h.db);
    await h.db.insert(personStats).values({ personId: p.id, revenueCents, purchases: 2, lastActivityAt: ago(61) });
  }
  const { listId } = await h.db.transaction((tx: Tx) => buildWeeklyRetentionList(tx, "2026-11-09", RETENTION_DEFAULTS));
  const rows = await h.db.select().from(retentionListItems).where(eq(retentionListItems.listId, listId)).orderBy(asc(retentionListItems.rank));
  return { listId, rows };
}

describe("rule 21: createRetentionTask", () => {
  it("creates one high-priority follow-up task in the owner's locale and stores task_id", async () => {
    const owner = await makeUser(h.db, { roleKey: "customer_service", locale: "fr-BE" });
    const { rows } = await list([600_000]); // score 50 + 30 + 6 = 86
    const item = rows[0]!;
    const result = await h.db.transaction((tx: Tx) => createRetentionItemTask(tx, ctxFor(tx, owner.id), { itemId: item.id }));
    expect(result.created).toBe(true);
    expect(crm.createTask.mock.calls[0]![2]).toMatchObject({
      title: t("fr-BE", "ops.retention.task_title.high_value_inactive"),
      kind: "follow_up",
      source: "retention",
      priority: "high",
      personId: item.personId,
      ownerUserId: owner.id,
      ref: { type: "retention_list_item", id: item.id },
    });
    // Wednesday 11 November is a Belgian public holiday: due Thursday 12 November at 10:00 Brussels.
    expect(crm.createTask.mock.calls[0]![2].dueAt).toEqual(new Date("2026-11-12T09:00:00Z"));
    const [stored] = await h.db.select().from(retentionListItems).where(eq(retentionListItems.id, item.id));
    expect(stored).toMatchObject({ taskId: result.taskId, actionedByUserId: owner.id });
    expect(stored!.actionedAt).not.toBeNull();
  });

  it("is idempotent: a second click and two concurrent clicks return the same single task", async () => {
    const owner = await makeUser(h.db, { roleKey: "customer_service" });
    const { rows } = await list([100_000]); // score 61: priority normal
    const item = rows[0]!;
    const [a, b] = await Promise.all([
      h.db.transaction((tx: Tx) => createRetentionItemTask(tx, ctxFor(tx, owner.id), { itemId: item.id })),
      h.db.transaction((tx: Tx) => createRetentionItemTask(tx, ctxFor(tx, owner.id), { itemId: item.id })),
    ]);
    expect(a.taskId).toBe(b.taskId);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    const again = await h.db.transaction((tx: Tx) => createRetentionItemTask(tx, ctxFor(tx, owner.id), { itemId: item.id }));
    expect(again).toEqual({ taskId: a.taskId, created: false });
    const made = await h.db.select().from(tasks).where(eq(tasks.personId, item.personId));
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ priority: "normal", source: "retention", refType: "retention_list_item", refId: item.id });
  });

  it("refuses an unknown item and a dismissed one", async () => {
    const owner = await makeUser(h.db, { roleKey: "customer_service" });
    const { rows } = await list([100_000]);
    await h.db.update(retentionListItems).set({ dismissedAt: NOW, dismissReason: "other" }).where(eq(retentionListItems.id, rows[0]!.id));
    await expect(h.db.transaction((tx: Tx) => createRetentionItemTask(tx, ctxFor(tx, owner.id), { itemId: rows[0]!.id }))).rejects.toMatchObject({ code: "conflict" });
    await expect(
      h.db.transaction((tx: Tx) => createRetentionItemTask(tx, ctxFor(tx, owner.id), { itemId: "0b5d1d6a-5a4e-4c1b-9d4e-6b1f2e3a4c5d" })),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("rule 21: createAllRetentionTasks", () => {
  it("creates a task for every open item in one transaction, skipping items with a task or a dismissal", async () => {
    const owner = await makeUser(h.db, { roleKey: "customer_service" });
    const { listId, rows } = await list([100_000, 120_000, 140_000, 160_000]);
    await h.db.transaction((tx: Tx) => createRetentionItemTask(tx, ctxFor(tx, owner.id), { itemId: rows[0]!.id }));
    await h.db.update(retentionListItems).set({ dismissedAt: NOW, dismissReason: "already_contacted" }).where(eq(retentionListItems.id, rows[1]!.id));
    crm.createTask.mockClear();
    const result = await h.db.transaction((tx: Tx) => createAllRetentionItemTasks(tx, ctxFor(tx, owner.id), { listId }));
    expect(result.created).toBe(2);
    expect(crm.createTask).toHaveBeenCalledTimes(2);
    const after = await h.db.select().from(retentionListItems).where(eq(retentionListItems.listId, listId)).orderBy(asc(retentionListItems.rank));
    expect(after.map((r) => r.taskId !== null)).toEqual([true, false, true, true]);
  });

  it("rolls back every task when one fails", async () => {
    const owner = await makeUser(h.db, { roleKey: "customer_service" });
    const { listId, rows } = await list([100_000, 120_000, 140_000]);
    crm.failFor.add(rows[2]!.personId);
    await expect(h.db.transaction((tx: Tx) => createAllRetentionItemTasks(tx, ctxFor(tx, owner.id), { listId }))).rejects.toThrow("crm down");
    const people = rows.map((r) => r.personId);
    expect(await h.db.select().from(tasks).where(inArray(tasks.personId, people))).toHaveLength(0);
    const after = await h.db.select().from(retentionListItems).where(eq(retentionListItems.listId, listId));
    expect(after.every((r) => r.taskId === null && r.actionedAt === null)).toBe(true);
  });
});

describe("rule 22: dismissRetentionItem", () => {
  it("requires a reason: the action input and the handler refuse a missing or unknown one", async () => {
    const owner = await makeUser(h.db, { roleKey: "customer_service" });
    const { rows } = await list([100_000]);
    const itemId = rows[0]!.id;
    expect(DismissRetentionItemInput.safeParse({ itemId }).success).toBe(false);
    expect(DismissRetentionItemInput.safeParse({ itemId, reason: "bored" }).success).toBe(false);
    expect(DismissRetentionItemInput.safeParse({ itemId, reason: "do_not_contact", note: "Asked us" }).success).toBe(true);
    await expect(
      h.db.transaction((tx: Tx) => dismissRetentionListItem(tx, ctxFor(tx, owner.id), { itemId, reason: undefined as never })),
    ).rejects.toBeInstanceOf(ValidationError);
    const [untouched] = await h.db.select().from(retentionListItems).where(eq(retentionListItems.id, itemId));
    expect(untouched!.dismissedAt).toBeNull();
  });

  it("keeps the row with the reason; a second dismissal keeps the first reason", async () => {
    const owner = await makeUser(h.db, { roleKey: "customer_service" });
    const { rows } = await list([100_000]);
    const itemId = rows[0]!.id;
    const first = await h.db.transaction((tx: Tx) => dismissRetentionListItem(tx, ctxFor(tx, owner.id), { itemId, reason: "not_relevant" }));
    expect(first).toMatchObject({ ok: true, alreadyDismissed: false, personId: rows[0]!.personId });
    const second = await h.db.transaction((tx: Tx) => dismissRetentionListItem(tx, ctxFor(tx, owner.id), { itemId, reason: "other" }));
    expect(second.alreadyDismissed).toBe(true);
    const [kept] = await h.db.select().from(retentionListItems).where(eq(retentionListItems.id, itemId));
    expect(kept).toMatchObject({ dismissReason: "not_relevant", actionedByUserId: owner.id });
    expect(kept!.dismissedAt).toEqual(NOW);
  });
});
