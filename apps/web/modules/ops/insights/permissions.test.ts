/**
 * ops-P9 permissions (ops spec 7, rule 79): custom dashboards need `reports.read` and
 * `ff_ops_ai`; the creator owns a dashboard; a shared dashboard is visible to every user with
 * `reports.read` but read-only for non-owners without `dashboards.manage`; a private one is not
 * found for them; `dashboards.manage` edits and deletes any visible dashboard. Saves and deletes
 * are audited (`dashboard.saved`, `dashboard.deleted`).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { auditLog, dashboards, featureFlags, roles } from "@beam/db/schema";
import { ForbiddenError } from "@beam/core/errors";
import type { RoleKey } from "@beam/core/platform";
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

const { saveDashboard, deleteDashboard } = await import("./actions");
const q = await import("./queries");
const { createAuthSession, SESSION_COOKIE } = await import("@/lib/auth");
const { eq } = await import("@/lib/ctx");
const { clearFlagCache } = await import("@/lib/flags");
const { resetRuntime, staffActor } = await import("@/lib/testing");
const { setAppDb } = await import("@/lib/ctx");

let h: DbHandle;
type Who = { id: string; roleKey: RoleKey; token: string; perms: string[] };
const users: Record<"owner" | "colleague" | "manager" | "reception", Who> = {} as never;

const definition = (n = 1) => ({ widgets: Array.from({ length: n }, (_, i) => ({ id: `w${i}`, kpi: "revenue_net", period: "month", compare: true, viz: "number" })) });
const as = (who: keyof typeof users) => void jar.set(SESSION_COOKIE, users[who].token);
const readCtx = (who: keyof typeof users) => ({ tx: h.db, actor: staffActor({ userId: users[who].id, permissions: users[who].perms }), now: new Date(), locale: "en" as const });

async function staff(roleKey: RoleKey, perms: string[]): Promise<Who> {
  const user = await makeUser(h.db, { roleKey });
  await h.db.update(roles).set({ permissions: perms }).where(eq(roles.key, roleKey));
  const { token } = await createAuthSession(h.db, { userId: user.id, audience: "staff", roleKey, now: new Date(), mfaAt: new Date() });
  return { id: user.id, roleKey, token, perms };
}

beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
  users.owner = await staff("marketing", ["reports.read"]);
  users.colleague = await staff("sales", ["reports.read"]);
  users.manager = await staff("management", ["reports.read", "dashboards.manage"]);
  users.reception = await staff("reception", ["tasks.all"]);
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(() => jar.clear());

describe("behind ff_ops_ai", () => {
  it("refuses saving while the flag is off", async () => {
    as("owner");
    expect(await saveDashboard({ name: "Flag off", definition: definition(), isShared: false })).toMatchObject({ ok: false, error: { code: "not_found" } });
    await h.db.insert(featureFlags).values({ key: "ff_ops_ai", state: "on" });
    clearFlagCache();
  });
});

describe("custom dashboards (reports.read, dashboards.manage)", () => {
  let shared = "";
  let privateId = "";

  it("needs a session and reports.read", async () => {
    expect(await saveDashboard({ name: "Anon", definition: definition(), isShared: false })).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    as("reception");
    expect(await saveDashboard({ name: "No reports", definition: definition(), isShared: false })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    await expect(q.listDashboards(readCtx("reception"))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("the creator owns the dashboard; saving is audited", async () => {
    as("owner");
    const s = await saveDashboard({ name: "Team view", definition: definition(2), isShared: true });
    const p = await saveDashboard({ name: "My notes", definition: definition(), isShared: false });
    expect(s).toMatchObject({ ok: true });
    expect(p).toMatchObject({ ok: true });
    if (!s.ok || !p.ok) return;
    shared = s.data.id;
    privateId = p.data.id;
    const [row] = await h.db.select().from(dashboards).where(eq(dashboards.id, shared));
    expect(row).toMatchObject({ ownerUserId: users.owner.id, isShared: true, name: "Team view" });
    const audits = await h.db.select().from(auditLog).where(eq(auditLog.action, "dashboard.saved"));
    expect(audits.map((a) => a.entityId)).toEqual(expect.arrayContaining([shared, privateId]));
    expect((await q.getDashboard(readCtx("owner"), shared)).canEdit).toBe(true);
  });

  it("a shared dashboard is read-only for a colleague without dashboards.manage", async () => {
    const list = await q.listDashboards(readCtx("colleague"));
    expect(list.map((d) => d.id)).toContain(shared);
    expect(list.map((d) => d.id)).not.toContain(privateId);
    expect(list.find((d) => d.id === shared)).toMatchObject({ isOwn: false, isShared: true, widgetCount: 2 });
    expect(await q.getDashboard(readCtx("colleague"), shared)).toMatchObject({ canEdit: false, name: "Team view" });
    as("colleague");
    expect(await saveDashboard({ id: shared, name: "Taken over", definition: definition(), isShared: false })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await deleteDashboard({ id: shared })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    const [row] = await h.db.select().from(dashboards).where(eq(dashboards.id, shared));
    expect(row).toMatchObject({ name: "Team view", isShared: true });
  });

  it("a private dashboard of someone else is not found", async () => {
    await expect(q.getDashboard(readCtx("colleague"), privateId)).rejects.toMatchObject({ code: "not_found" });
    as("colleague");
    expect(await saveDashboard({ id: privateId, name: "Peek", definition: definition(), isShared: true })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await deleteDashboard({ id: privateId })).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("a definition of 25 widgets or with an unknown KPI is refused", async () => {
    as("owner");
    expect(await saveDashboard({ id: shared, name: "Too big", definition: definition(25), isShared: true })).toMatchObject({ ok: false, error: { code: "validation" } });
    const bad = { widgets: [{ id: "w1", kpi: "select * from persons", period: "month", compare: false, viz: "number" }] };
    expect(await saveDashboard({ name: "Free SQL", definition: bad, isShared: false })).toMatchObject({ ok: false, error: { code: "validation" } });
  });

  it("dashboards.manage edits and deletes a shared dashboard of someone else", async () => {
    expect((await q.getDashboard(readCtx("manager"), shared)).canEdit).toBe(true);
    as("manager");
    expect(await saveDashboard({ id: shared, name: "Management view", definition: definition(3), isShared: true })).toMatchObject({ ok: true });
    const [row] = await h.db.select().from(dashboards).where(eq(dashboards.id, shared));
    expect(row).toMatchObject({ name: "Management view", ownerUserId: users.owner.id });
    const [edit] = await h.db.select().from(auditLog).where(eq(auditLog.entityId, shared)).orderBy(auditLog.createdAt);
    expect(edit).toBeDefined();
    expect(await deleteDashboard({ id: shared })).toMatchObject({ ok: true, data: { ok: true } });
    expect(await h.db.select().from(dashboards).where(eq(dashboards.id, shared))).toEqual([]);
    expect(await h.db.select().from(auditLog).where(eq(auditLog.action, "dashboard.deleted"))).toHaveLength(1);
  });

  it("the owner deletes their own dashboard with reports.read only", async () => {
    as("owner");
    expect(await deleteDashboard({ id: privateId })).toMatchObject({ ok: true });
  });

  it("widgets evaluate for a reader; a widget the reader may not see reports an error", async () => {
    const def = {
      widgets: [
        { id: "a", kpi: "revenue_orders", period: "month" as const, compare: false, viz: "number" as const },
        { id: "b", kpi: "finance_cash_in_cents", period: "month" as const, compare: false, viz: "number" as const },
      ],
    };
    const res = await q.evaluateDashboard(readCtx("colleague"), def, new Date());
    expect(res[0]).toMatchObject({ widgetId: "a", error: null, value: { current: 0 } });
    expect(res[1]).toMatchObject({ widgetId: "b", value: null, error: "forbidden" });
  });
});
