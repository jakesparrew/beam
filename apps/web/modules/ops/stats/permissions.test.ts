/**
 * ops area `stats`: permissions (ops spec 4.1, 4.2 and 7). `recalculatePersonStats` is a staff
 * action behind `persons.read`, audited once as `stats.recalculated`; the person page panel
 * query needs `persons.read`; ops declares `reports.read`, `dashboards.manage` and `privacy.run`.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { auditLog, personStats, roles } from "@beam/db/schema";
import { createTestDb, makeUser } from "@beam/db/testing";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.10" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));

const { recalculatePersonStats } = await import("./actions");
const { getPersonStatsPanel } = await import("./queries");
const { permissions } = await import("../permissions");
const { createAuthSession, SESSION_COOKIE } = await import("@/lib/auth");
const { and, eq, setAppDb } = await import("@/lib/ctx");
const { resetRuntime } = await import("@/lib/testing");
const { daysAgo, makeBooking, makeCustomer } = await import("./ops-p2.fixtures");

let h: DbHandle;

async function asStaff(perms: string[]) {
  const user = await makeUser(h.db, { roleKey: "reception" });
  await h.db.update(roles).set({ permissions: perms }).where(eq(roles.key, "reception"));
  const { token } = await createAuthSession(h.db, { userId: user.id, audience: "staff", roleKey: "reception", now: new Date(), mfaAt: new Date() });
  jar.set(SESSION_COOKIE, token);
  return user;
}

async function asCustomer() {
  const user = await makeUser(h.db, { audience: "customer" });
  const { token } = await createAuthSession(h.db, { userId: user.id, audience: "customer", roleKey: null, now: new Date() });
  jar.set(SESSION_COOKIE, token);
  return user;
}

beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(() => jar.clear());

describe("ops stats permissions (spec 7)", () => {
  it("ops declares reports.read, dashboards.manage and privacy.run", () => {
    for (const p of ["reports.read", "dashboards.manage", "privacy.run"]) expect(permissions).toContain(p);
  });

  it("recalculatePersonStats: anonymous and customers are unauthorized, staff without persons.read forbidden", async () => {
    const p = await makeCustomer(h.db);
    expect(await recalculatePersonStats({ personId: p.id })).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    await asCustomer();
    expect(await recalculatePersonStats({ personId: p.id })).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    await asStaff(["persons.write", "reports.read"]);
    expect(await recalculatePersonStats({ personId: p.id })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await h.db.select().from(personStats).where(eq(personStats.personId, p.id))).toEqual([]);
  });

  it("recalculatePersonStats with persons.read refreshes the row and audits stats.recalculated once", async () => {
    const p = await makeCustomer(h.db);
    await makeBooking(h.db, { personId: p.id, startsAt: daysAgo(2), status: "attended" });
    const user = await asStaff(["persons.read"]);
    const result = await recalculatePersonStats({ personId: p.id });
    expect(result).toMatchObject({ ok: true, data: { personId: p.id, visits: 1, b2cStage: "first_visit" } });
    const audits = await h.db.select().from(auditLog).where(and(eq(auditLog.entityId, p.id)));
    expect(audits.map((a) => a.action)).toEqual(["stats.recalculated"]);
    expect(audits[0]).toMatchObject({ entityType: "person", personId: p.id });
    expect((audits[0]!.actor as { id: string }).id).toBe(user.id);
  });

  it("recalculatePersonStats validates its input and answers not_found for an unknown person", async () => {
    await asStaff(["persons.read"]);
    expect(await recalculatePersonStats({ personId: "nope" })).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(await recalculatePersonStats({ personId: randomUUID() })).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("getPersonStatsPanel needs persons.read", async () => {
    const p = await makeCustomer(h.db);
    await asStaff(["reports.read"]);
    await expect(getPersonStatsPanel(h.db, p.id)).rejects.toThrow();
    await asStaff(["persons.read"]);
    expect(await getPersonStatsPanel(h.db, p.id)).toEqual({ stats: null, reasons: [] });
  });
});
