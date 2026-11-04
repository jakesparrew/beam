import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, makeUser } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { auditLog } from "@beam/db/schema";
import { getGoLiveGate, getSystemOverview, listFlags, listRoles, listSettings, listStaffUsers, PAGE_SIZE, searchAudit } from "./queries";
import { resetRuntime } from "@/lib/testing";

let handle: DbHandle;
let actorA: string;
let actorB: string;
const base = Date.parse("2026-10-01T08:00:00Z");

beforeAll(async () => {
  handle = await createTestDb();
  actorA = (await makeUser(handle.db, { roleKey: "owner" })).id;
  actorB = (await makeUser(handle.db, { roleKey: "reception" })).id;
  // 120 rows by A (settings.update), 30 by B (users.update); several share a timestamp, so the id breaks ties.
  const rows = Array.from({ length: 150 }, (_, i) => ({
    actor: { kind: "staff" as const, id: i < 120 ? actorA : actorB, role_key: i < 120 ? "owner" : "reception" },
    action: i < 120 ? "settings.update" : "users.update",
    entityType: i < 120 ? "settings" : "users",
    entityId: i < 120 ? `key_${i % 7}` : actorA,
    createdAt: new Date(base + Math.floor(i / 3) * 60_000),
  }));
  await handle.db.insert(auditLog).values(rows);
});
afterAll(async () => {
  resetRuntime();
  await handle.close();
});

async function all(input: Parameters<typeof searchAudit>[1]) {
  const seen: { id: string; createdAt: Date }[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page = await searchAudit(handle.db, { ...input, cursor });
    expect(page.rows.length).toBeLessThanOrEqual(PAGE_SIZE);
    seen.push(...page.rows);
    cursor = page.nextCursor;
    pages++;
  } while (cursor && pages < 20);
  return { seen, pages };
}

describe("searchAudit (keyset pagination on created_at, id)", () => {
  it("walks every matching row exactly once, newest first", async () => {
    const { seen, pages } = await all({ actorId: actorA });
    expect(pages).toBe(3);
    expect(seen).toHaveLength(120);
    expect(new Set(seen.map((r) => r.id)).size).toBe(120);
    for (let i = 1; i < seen.length; i++) {
      const prev = seen[i - 1]!;
      const cur = seen[i]!;
      expect(prev.createdAt.getTime() > cur.createdAt.getTime() || (prev.createdAt.getTime() === cur.createdAt.getTime() && prev.id > cur.id)).toBe(true);
    }
  });

  it("combines filters: actor, action, entity, date range", async () => {
    expect((await all({ action: "users.update" })).seen).toHaveLength(30);
    expect((await all({ actorId: actorB, entityType: "users", entityId: actorA })).seen).toHaveLength(30);
    expect((await all({ action: "settings.", entityId: "key_0" })).seen).toHaveLength(18);
    const from = new Date(base + 10 * 60_000);
    const to = new Date(base + 20 * 60_000);
    expect((await all({ from, to })).seen).toHaveLength(30);
    expect((await all({ actorId: randomUUID() })).seen).toHaveLength(0);
  });

  it("ignores a malformed cursor", async () => {
    const page = await searchAudit(handle.db, { actorId: actorB, cursor: "not-a-cursor" });
    expect(page.rows).toHaveLength(30);
    expect(page.nextCursor).toBeNull();
  });
});

describe("admin read models", () => {
  it("lists staff users, roles, settings and flags from the registries", async () => {
    expect((await listStaffUsers(handle.db, { roleKey: "owner" })).rows.map((r) => r.id)).toEqual([actorA]);
    const roles = await listRoles(handle.db);
    expect(roles.find((r) => r.key === "owner")).toMatchObject({ members: 1, permissions: ["*"], unknownPermissions: [] });
    expect((await listSettings(handle.db)).map((s) => s.key)).toContain("support");
    for (const f of await listFlags(handle.db)) expect(f.state).toBe("off");
    expect(await getGoLiveGate(handle.db)).toMatchObject({ confirmed: 0, total: 13, complete: false });
    expect(await getSystemOverview(handle.db)).toMatchObject({ dead: 0, openIncidents: 0, gate: { confirmed: 0, total: 13 } });
  });
});
