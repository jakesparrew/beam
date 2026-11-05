/**
 * ops rule 20 (ops-P7): the weekly retention list. One database for the file; before each case
 * every existing person becomes a tester (testers never appear in `v_retention_candidates`, rule
 * 19) and the lists are emptied, so each case sees only its own candidates.
 *
 * Candidates come from `high_value_inactive` (person stats: revenue and last activity give an
 * exact score, `50 + least(30, revenue / 20000) + least(20, days / 10)`) and from grants that
 * are nearly used up or expiring.
 */
import { randomUUID } from "node:crypto";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle, Tx } from "@beam/db";
import { personStats, retentionListItems, retentionLists, tasks } from "@beam/db/schema";
import { RETENTION_DEFAULTS } from "@beam/core/ops";
import { createTestDb, makeUser } from "@beam/db/testing";
import { makeCreditGrant, makeEntry } from "@beam/db/testing/credits-factories";

vi.mock("@/lib/alerts", async (orig) => ({ ...(await orig<Record<string, unknown>>()), notifySlack: vi.fn() }));

const { notifySlack } = await import("@/lib/alerts");
const { asc, eq, sql } = await import("@/lib/ctx");
const { makeCtx, resetRuntime } = await import("@/lib/testing");
const { ago, ahead, makeBookingAt, makeCustomer } = await import("../dashboard/ops-p3.fixtures");
const { buildWeeklyRetentionList, postRetentionNotice, weekStartOf } = await import("./build-list");

let h: DbHandle;
const WEEK = "2026-11-02";
const dialect = new PgDialect();

beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  await h.db.execute(sql`update persons set is_tester = true where is_tester = false`);
  await h.db.delete(retentionLists);
  vi.mocked(notifySlack).mockReset().mockResolvedValue({ jobId: randomUUID(), inserted: true });
});

const build = (week = WEEK, cfg = RETENTION_DEFAULTS) => h.db.transaction((tx: Tx) => buildWeeklyRetentionList(tx, week, cfg));
const items = (listId: string) => h.db.select().from(retentionListItems).where(eq(retentionListItems.listId, listId)).orderBy(asc(retentionListItems.rank));

/** A high-value customer inactive for `days` days: score 50 + revenue / 20000 (max 30) + days / 10 (max 20). */
async function inactiveVip(revenueCents: number, days = 61, over: Parameters<typeof makeCustomer>[1] = {}) {
  const p = await makeCustomer(h.db, over);
  await h.db.insert(personStats).values({ personId: p.id, revenueCents, purchases: 3, lastActivityAt: ago(days) });
  return p;
}

describe("rule 20: buildWeeklyRetentionList", () => {
  it("keeps the top 25 by score, then revenue, then person id", async () => {
    const people = [];
    for (let i = 0; i < 27; i++) people.push(await inactiveVip(100_000 + i * 20_000));
    const { listId, size } = await build();
    expect(size).toBe(25);
    const rows = await items(listId);
    expect(rows.map((r) => r.rank)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    // i = 25 and 26 both reach the value cap (30): equal score 86, the higher revenue first.
    expect(rows[0]).toMatchObject({ personId: people[26]!.id, score: 86, primaryReason: "high_value_inactive" });
    expect(rows[1]).toMatchObject({ personId: people[25]!.id, score: 86 });
    expect(rows[2]).toMatchObject({ personId: people[24]!.id, score: 85 });
    expect(rows.map((r) => r.personId)).not.toContain(people[0]!.id);
    expect(rows.map((r) => r.personId)).not.toContain(people[1]!.id);
    const scores = rows.map((r) => r.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    const [list] = await h.db.select().from(retentionLists).where(eq(retentionLists.id, listId));
    expect(list).toMatchObject({ weekStartOn: WEEK, size: 25 });
    expect(list!.thresholds).toMatchObject({ weekly_list_size: 25, task_cooldown_days: 14 });
  });

  it("one row per person with the highest score as primary reason and every reason", async () => {
    const p = await inactiveVip(100_000);
    const grant = await makeCreditGrant(h.db, { personId: p.id, units: 10, expiresAt: ahead(10.5) });
    await makeEntry(h.db, { grantId: grant.id, kind: "consume", quantity: -8 });
    const { listId } = await build();
    const rows = await items(listId);
    expect(rows).toHaveLength(1);
    // high_value_inactive 50 + 5 + 6 = 61; package_expiring 45 + 5 + (20 - 10) = 60; package_nearly_finished 35 + 5 = 40.
    expect(rows[0]).toMatchObject({ personId: p.id, score: 61, primaryReason: "high_value_inactive" });
    expect(rows[0]!.reasons).toEqual(["high_value_inactive", "package_expiring", "package_nearly_finished"]);
    expect(rows[0]!.detail).toMatchObject({ ref_type: "person", ref_id: p.id, days_since_activity: 61 });
  });

  it("leaves out people with an open or done retention task in the cooldown, not older or cancelled ones", async () => {
    const owner = await makeUser(h.db, { roleKey: "customer_service" });
    const task = async (personId: string, status: "open" | "done" | "cancelled", createdAt: Date, source: "retention" | "manual" = "retention") =>
      h.db.insert(tasks).values({ ownerUserId: owner.id, personId, title: "Call", kind: "follow_up", source, status, createdAt, createdBy: { kind: "system", id: null },
        ...(status === "done" ? { doneAt: createdAt, doneByUserId: owner.id } : {}) });
    const open = await inactiveVip(100_000);
    const done = await inactiveVip(100_000);
    const old = await inactiveVip(100_000);
    const cancelled = await inactiveVip(100_000);
    const manual = await inactiveVip(100_000);
    await task(open.id, "open", ago(2));
    await task(done.id, "done", ago(13));
    await task(old.id, "open", ago(15));
    await task(cancelled.id, "cancelled", ago(1));
    await task(manual.id, "open", ago(1), "manual");
    const ids = (await items((await build()).listId)).map((r) => r.personId);
    expect(ids).not.toContain(open.id);
    expect(ids).not.toContain(done.id);
    expect(ids).toEqual(expect.arrayContaining([old.id, cancelled.id, manual.id]));
  });

  it("a future booking removes the inactivity reasons but keeps the package reasons", async () => {
    const p = await inactiveVip(100_000);
    await makeCreditGrant(h.db, { personId: p.id, units: 10, expiresAt: ahead(10.5) });
    await makeBookingAt(h.db, { personId: p.id, startsAt: ahead(3) });
    const rows = await items((await build()).listId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.primaryReason).toBe("package_expiring");
    expect(rows[0]!.reasons).toEqual(["package_expiring"]);
  });

  it("builds a shorter list when there are fewer than 25 candidates", async () => {
    for (const r of [100_000, 120_000, 140_000]) await inactiveVip(r);
    const { listId, size } = await build();
    expect(size).toBe(3);
    expect((await items(listId)).map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it("a rebuild in the same week keeps items with a task or a dismissal, rank and all, and replaces the others", async () => {
    const owner = await makeUser(h.db, { roleKey: "customer_service" });
    const people = [];
    for (let i = 0; i < 4; i++) people.push(await inactiveVip(100_000 + i * 20_000));
    const first = await build(WEEK, { ...RETENTION_DEFAULTS, weekly_list_size: 3 });
    const before = await items(first.listId);
    expect(before.map((r) => r.personId)).toEqual([people[3]!.id, people[2]!.id, people[1]!.id]);
    const [task] = await h.db
      .insert(tasks)
      .values({ ownerUserId: owner.id, personId: people[2]!.id, title: "Call", kind: "follow_up", source: "manual", createdBy: { kind: "system", id: null } })
      .returning();
    await h.db.update(retentionListItems).set({ taskId: task!.id, actionedAt: new Date() }).where(eq(retentionListItems.id, before[1]!.id));
    await h.db.update(retentionListItems).set({ dismissedAt: new Date(), dismissReason: "other" }).where(eq(retentionListItems.id, before[2]!.id));
    const newcomer = await inactiveVip(400_000);

    const second = await build(WEEK, { ...RETENTION_DEFAULTS, weekly_list_size: 3 });
    expect(second.listId).toBe(first.listId);
    const after = await items(second.listId);
    expect(after).toHaveLength(3);
    expect(after.find((r) => r.id === before[1]!.id)).toMatchObject({ rank: 2, taskId: task!.id, personId: people[2]!.id });
    expect(after.find((r) => r.id === before[2]!.id)).toMatchObject({ rank: 3, dismissReason: "other", personId: people[1]!.id });
    expect(after.find((r) => r.rank === 1)).toMatchObject({ personId: newcomer.id });
    expect(after.map((r) => r.id)).not.toContain(before[0]!.id);
  });

  it("a concurrent rebuild waits on the list lock: one list, no duplicate rank or person", async () => {
    for (let i = 0; i < 5; i++) await inactiveVip(100_000 + i * 20_000);
    const statements: string[] = [];
    const traced = (tx: Tx) =>
      new Proxy(tx, {
        get(target, prop, receiver) {
          if (prop === "execute") {
            return (q: Parameters<Tx["execute"]>[0]) => {
              statements.push(dialect.sqlToQuery(q as never).sql.replace(/\s+/g, " "));
              return target.execute(q);
            };
          }
          return Reflect.get(target, prop, receiver) as unknown;
        },
      });
    const [a, b] = await Promise.all([
      h.db.transaction((tx: Tx) => buildWeeklyRetentionList(traced(tx), WEEK, RETENTION_DEFAULTS)),
      h.db.transaction((tx: Tx) => buildWeeklyRetentionList(traced(tx), WEEK, RETENTION_DEFAULTS)),
    ]);
    expect(a.listId).toBe(b.listId);
    expect(a.size).toBe(5);
    expect(b.size).toBe(5);
    const rows = await items(a.listId);
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((r) => r.personId)).size).toBe(5);
    expect(await h.db.select().from(retentionLists)).toHaveLength(1);
    const insertAt = statements.findIndex((s) => s.startsWith("insert into retention_lists") && s.includes("on conflict (week_start_on) do nothing"));
    const lockAt = statements.findIndex((s) => s.includes("from retention_lists where week_start_on") && s.endsWith("for update"));
    const readAt = statements.findIndex((s) => s.includes("v_retention_candidates"));
    expect(insertAt).toBeGreaterThanOrEqual(0);
    expect(lockAt).toBeGreaterThan(insertAt);
    expect(readAt).toBeGreaterThan(lockAt);
  });

  it("weekStartOf gives the Brussels Monday", () => {
    expect(weekStartOf(new Date("2026-11-02T05:10:00Z"))).toBe("2026-11-02");
    expect(weekStartOf(new Date("2026-11-08T23:30:00Z"))).toBe("2026-11-09");
    expect(weekStartOf(new Date("2026-11-08T22:30:00Z"))).toBe("2026-11-02");
    expect(weekStartOf(new Date("2026-11-08T12:00:00Z"))).toBe("2026-11-02");
  });
});

describe("rule 20: the Slack notice", () => {
  it("has the counts per primary reason and the link, no names, with fingerprint retention-list:<week>", async () => {
    const vip = await inactiveVip(100_000, 61, { firstName: "Ottilie", lastName: "Vandersteen" });
    const other = await makeCustomer(h.db, { firstName: "Bastiaan", lastName: "Claeys" });
    await makeCreditGrant(h.db, { personId: other.id, units: 10, expiresAt: ahead(5) });
    const { listId } = await build();
    await postRetentionNotice(makeCtx(h.db), listId, WEEK);
    expect(vi.mocked(notifySlack)).toHaveBeenCalledTimes(1);
    const { fingerprint, severity, text } = vi.mocked(notifySlack).mock.calls[0]![1];
    expect({ fingerprint, severity }).toEqual({ fingerprint: `retention-list:${WEEK}`, severity: "normal" });
    expect(text).toContain("Weekly retention list ready for the week of 2026-11-02: 2 people, 1 package expiring");
    expect(text).toContain("High-value customer inactive: 1");
    expect(text).toContain("Package expiring: 1");
    expect(text).toContain("/admin/dashboard/retention");
    for (const secret of [vip.firstName!, vip.lastName!, other.firstName!, other.lastName!, vip.email!, other.email!]) expect(text).not.toContain(secret);
    expect(text).not.toMatch(/[^\s@]+@[^\s@]+\.[a-z]{2,}/i);
  });
});
