/**
 * ops rule 22a (ops-P3): "Create task" on a dashboard card row. crm's `createTask` is wrapped in
 * a `vi.fn` that calls the real one, so the test sees the exact arguments and the real task row
 * (rule 3.44 dedupe). Checks: `ref` and `dedupeKey`, task kind per card, source `retention` for
 * the retention-reason cards and `manual` for the others, the title in the owner's locale, due
 * the next business day at 10:00 Brussels (booking hours, closed days, Belgian holidays), and two
 * concurrent clicks returning one task.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { DbHandle, Tx } from "@beam/db";
import { sessionExceptions, tasks } from "@beam/db/schema";
import { t } from "@beam/core/i18n";
import { createTestDb, makeUser } from "@beam/db/testing";
import type * as CrmApi from "@/modules/crm/api";

const crm = vi.hoisted(() => ({ createTask: undefined as unknown as Mock<typeof CrmApi.createTask> }));
vi.mock("@/modules/crm/api", async (importOriginal) => {
  const actual = await importOriginal<typeof CrmApi>();
  crm.createTask = vi.fn(actual.createTask);
  return { ...actual, createTask: crm.createTask };
});

const { createCtx, and, eq } = await import("@/lib/ctx");
const { resetRuntime, staffActor } = await import("@/lib/testing");
const { createCardTask, taskKindFor, taskSourceFor } = await import("./cards");
const { makeCustomer } = await import("./ops-p3.fixtures");

let h: DbHandle;

beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(() => {
  crm.createTask.mockClear();
});

async function click(input: Parameters<typeof createCardTask>[2], opts: { now?: Date; userId?: string } = {}) {
  const userId = opts.userId ?? (await makeUser(h.db, { roleKey: "customer_service" })).id;
  return h.db.transaction((tx: Tx) =>
    createCardTask(tx, createCtx({ tx, actor: staffActor({ userId, permissions: ["tasks.all"] }), now: opts.now ?? new Date("2026-11-10T14:00:00Z"), durableMode: "immediate" }), input),
  );
}

describe("rule 22a: createTaskFromCard", () => {
  it("passes ref { type: 'action_card:<card>', id } and the dedupe key to crm's createTask", async () => {
    const p = await makeCustomer(h.db);
    const refId = "9b0b4f8e-6d1c-4e0a-9f53-2d7c1a1e0001";
    const result = await click({ card: "failed_payments", personId: p.id, refId });
    expect(result.created).toBe(true);
    expect(crm.createTask).toHaveBeenCalledTimes(1);
    const input = crm.createTask.mock.calls[0]![2];
    expect(input).toMatchObject({
      personId: p.id,
      kind: "payment",
      source: "manual",
      priority: "normal",
      ref: { type: "action_card:failed_payments", id: refId },
      dedupeKey: `card:failed_payments:${p.id}:${refId}`,
    });
    const [row] = await h.db.select().from(tasks).where(eq(tasks.id, result.taskId));
    expect(row).toMatchObject({ refType: "action_card:failed_payments", refId, status: "open", kind: "payment" });
  });

  it("a row without its own reference uses the person id", async () => {
    const p = await makeCustomer(h.db);
    await click({ card: "new_leads_follow_up", personId: p.id });
    expect(crm.createTask.mock.calls[0]![2]).toMatchObject({ ref: { type: "action_card:new_leads_follow_up", id: p.id }, dedupeKey: `card:new_leads_follow_up:${p.id}:${p.id}` });
  });

  it("task kind per card; source retention for the retention-reason cards, manual for the others", () => {
    expect(taskKindFor("failed_payments")).toBe("payment");
    expect(taskKindFor("b2b_proposals")).toBe("proposal");
    expect(taskKindFor("shared_package_abuse")).toBe("review");
    for (const k of ["packages_nearing_completion", "vip_inactive", "new_leads_follow_up", "memberships_expiring", "webinar_leads_not_booked", "unused_packages_expiring"] as const) expect(taskKindFor(k)).toBe("follow_up");
    for (const k of ["packages_nearing_completion", "vip_inactive", "unused_packages_expiring"] as const) expect(taskSourceFor(k)).toBe("retention");
    for (const k of ["new_leads_follow_up", "memberships_expiring", "failed_payments", "webinar_leads_not_booked", "b2b_proposals", "shared_package_abuse"] as const) expect(taskSourceFor(k)).toBe("manual");
  });

  it("the title is in the owner's locale (the reason's task title for a retention card)", async () => {
    const owner = await makeUser(h.db, { roleKey: "sales", locale: "fr-BE" });
    const p = await makeCustomer(h.db);
    const r = await click({ card: "vip_inactive", personId: p.id, ownerUserId: owner.id });
    const [row] = await h.db.select().from(tasks).where(eq(tasks.id, r.taskId));
    expect(row).toMatchObject({ ownerUserId: owner.id, source: "retention", kind: "follow_up", title: t("fr-BE", "ops.retention.task_title.high_value_inactive") });
    expect(row!.title).not.toBe(t("en", "ops.retention.task_title.high_value_inactive"));

    const nl = await makeUser(h.db, { roleKey: "sales", locale: "nl-BE" });
    const q = await makeCustomer(h.db);
    const r2 = await click({ card: "memberships_expiring", personId: q.id, refId: "9b0b4f8e-6d1c-4e0a-9f53-2d7c1a1e0002" }, { userId: nl.id });
    const [row2] = await h.db.select().from(tasks).where(eq(tasks.id, r2.taskId));
    expect(row2).toMatchObject({ ownerUserId: nl.id, title: t("nl-BE", "ops.dashboard.card.memberships_expiring.title"), source: "manual" });
  });

  it("is due the next business day at 10:00 Brussels: skips 11 November, closed Mondays and booking closed days", async () => {
    // Tuesday 10 November 2026: Wednesday 11 November is a public holiday, so Thursday 12 at 10:00 CET.
    const a = await click({ card: "new_leads_follow_up", personId: (await makeCustomer(h.db)).id }, { now: new Date("2026-11-10T14:00:00Z") });
    expect((await h.db.select().from(tasks).where(eq(tasks.id, a.taskId)))[0]!.dueAt).toEqual(new Date("2026-11-12T09:00:00Z"));
    // Sunday 15 November: Monday is closed in booking's default hours.
    const b = await click({ card: "new_leads_follow_up", personId: (await makeCustomer(h.db)).id }, { now: new Date("2026-11-15T11:00:00Z") });
    expect((await h.db.select().from(tasks).where(eq(tasks.id, b.taskId)))[0]!.dueAt).toEqual(new Date("2026-11-17T09:00:00Z"));
    // A booking closed day for every template on Thursday 12 November moves it to Friday.
    await h.db.insert(sessionExceptions).values({ onDate: "2026-11-12", kind: "closed", name: { "nl-BE": "Gesloten", "fr-BE": "Fermé", en: "Closed" } });
    const c = await click({ card: "new_leads_follow_up", personId: (await makeCustomer(h.db)).id }, { now: new Date("2026-11-10T14:00:00Z") });
    expect((await h.db.select().from(tasks).where(eq(tasks.id, c.taskId)))[0]!.dueAt).toEqual(new Date("2026-11-13T09:00:00Z"));
  });

  it("returns the open task on a second click, and two concurrent clicks give one task", async () => {
    const p = await makeCustomer(h.db);
    const refId = "9b0b4f8e-6d1c-4e0a-9f53-2d7c1a1e0003";
    const user = await makeUser(h.db, { roleKey: "reception" });
    const [one, two] = await Promise.all([
      click({ card: "unused_packages_expiring", personId: p.id, refId }, { userId: user.id }),
      click({ card: "unused_packages_expiring", personId: p.id, refId }, { userId: user.id }),
    ]);
    expect(one.taskId).toBe(two.taskId);
    expect([one.created, two.created].sort()).toEqual([false, true]);
    const again = await click({ card: "unused_packages_expiring", personId: p.id, refId }, { userId: user.id });
    expect(again).toEqual({ taskId: one.taskId, created: false });
    const rows = await h.db.select().from(tasks).where(and(eq(tasks.personId, p.id), eq(tasks.refType, "action_card:unused_packages_expiring")));
    expect(rows).toHaveLength(1);
  });

  it("refuses the cards that make no tasks and an unknown person", async () => {
    const p = await makeCustomer(h.db);
    await expect(click({ card: "overdue_tasks", personId: p.id })).rejects.toThrow(/validation/);
    await expect(click({ card: "vip_inactive", personId: "9b0b4f8e-6d1c-4e0a-9f53-2d7c1a1e00ff" })).rejects.toThrow(/person/);
    expect(crm.createTask).not.toHaveBeenCalled();
  });
});
