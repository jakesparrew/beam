/**
 * ops-P3 permissions (ops spec 7): the action dashboard needs `reports.read` or `tasks.all`;
 * "Create task" from a card needs `tasks.all` and audits `task.created` once; the revenue report
 * and the prepaid credits need `reports.read`; the report CSV route answers 401 without a staff
 * session, 403 without `reports.read`, 404 for an unknown report, and streams with
 * `data.exported` audited otherwise. External partners hold none of these.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { auditLog, roles, tasks } from "@beam/db/schema";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import { makePaidOrder } from "@beam/db/testing/commerce-factories";

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

const { createTaskFromCard } = await import("../dashboard/actions");
const { getActionDashboard } = await import("../dashboard/queries");
const { getCreditLiability, getRevenueReport, listReportPages } = await import("./queries");
const { GET } = await import("@/app/(admin)/admin/reports/[report]/csv/route");
const { createAuthSession, SESSION_COOKIE } = await import("@/lib/auth");
const { and, eq, setAppDb } = await import("@/lib/ctx");
const { resetRuntime, staffActor } = await import("@/lib/testing");

let h: DbHandle;

async function asStaff(perms: string[], opts: { mfa?: boolean } = {}) {
  const user = await makeUser(h.db, { roleKey: "reception" });
  await h.db.update(roles).set({ permissions: perms }).where(eq(roles.key, "reception"));
  const { token } = await createAuthSession(h.db, { userId: user.id, audience: "staff", roleKey: "reception", now: new Date(), ...(opts.mfa === false ? {} : { mfaAt: new Date() }) });
  jar.set(SESSION_COOKIE, token);
  return user;
}

async function asCustomer() {
  const user = await makeUser(h.db, { audience: "customer" });
  const { token } = await createAuthSession(h.db, { userId: user.id, audience: "customer", roleKey: null, now: new Date() });
  jar.set(SESSION_COOKIE, token);
}

const csv = (report: string, query = "") => GET(new Request(`https://beam.example.com/admin/reports/${report}/csv${query}`), { params: Promise.resolve({ report }) });
const readCtx = (permissions: string[]) => ({ tx: h.db, actor: staffActor({ permissions }), now: new Date(), locale: "en" as const });

beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(() => {
  jar.clear();
});

describe("createTaskFromCard (tasks.all)", () => {
  it("anonymous and customers are unauthorized, staff without tasks.all forbidden; nothing is created", async () => {
    const p = await makePerson(h.db, { isTester: false });
    const input = { card: "vip_inactive", personId: p.id };
    expect(await createTaskFromCard(input)).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    await asCustomer();
    expect(await createTaskFromCard(input)).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    await asStaff(["reports.read", "credits.read", "commerce.sell"]);
    expect(await createTaskFromCard(input)).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await h.db.select().from(tasks).where(eq(tasks.personId, p.id))).toEqual([]);
  });

  it("with tasks.all creates the task once and audits task.created once", async () => {
    const p = await makePerson(h.db, { isTester: false });
    const user = await asStaff(["tasks.all"]);
    const first = await createTaskFromCard({ card: "vip_inactive", personId: p.id });
    expect(first).toMatchObject({ ok: true, data: { created: true } });
    const second = await createTaskFromCard({ card: "vip_inactive", personId: p.id });
    expect(second).toMatchObject({ ok: true, data: { created: false } });
    if (!first.ok || !second.ok) throw new Error("unreachable");
    expect(second.data.taskId).toBe(first.data.taskId);
    const audits = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "task.created"), eq(auditLog.personId, p.id)));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ entityType: "task", entityId: first.data.taskId });
    expect((audits[0]!.actor as { id: string }).id).toBe(user.id);
  });

  it("validates its input", async () => {
    await asStaff(["tasks.all"]);
    expect(await createTaskFromCard({ card: "nope", personId: "x" })).toMatchObject({ ok: false, error: { code: "validation" } });
  });
});

describe("dashboard and report queries", () => {
  it("the dashboard opens with reports.read or tasks.all, not with credits.read alone or for external partners", async () => {
    await expect(getActionDashboard(readCtx(["credits.read"]))).rejects.toThrow(/forbidden/);
    await expect(getActionDashboard(readCtx(["partner.own"]))).rejects.toThrow(/forbidden/);
    expect((await getActionDashboard(readCtx(["reports.read"]))).length).toBeGreaterThan(0);
    expect((await getActionDashboard(readCtx(["tasks.all"]))).length).toBeGreaterThan(0);
  });

  it("the revenue report, the credit liability and the report index need reports.read", async () => {
    for (const perms of [["tasks.all"], ["credits.read", "commerce.sell"], ["partner.own"]]) {
      await expect(getRevenueReport(readCtx(perms), { period: "day", at: new Date() })).rejects.toThrow(/forbidden/);
      await expect(getCreditLiability(readCtx(perms))).rejects.toThrow(/forbidden/);
      expect(() => listReportPages(readCtx(perms))).toThrow(/forbidden/);
    }
    expect((await getRevenueReport(readCtx(["reports.read"]), { period: "day", at: new Date() })).period).toBe("day");
    expect(listReportPages(readCtx(["reports.read"])).map((p) => p.href)).toContain("/admin/reports/revenue");
  });
});

describe("GET /admin/reports/[report]/csv (reports.read, audited)", () => {
  it("401 without a staff session or before MFA, 403 without reports.read, 404 for an unknown report", async () => {
    expect((await csv("revenue")).status).toBe(401);
    await asCustomer();
    expect((await csv("revenue")).status).toBe(401);
    await asStaff(["reports.read"], { mfa: false });
    expect((await csv("revenue")).status).toBe(401);
    await asStaff(["tasks.all", "credits.read"]);
    expect((await csv("revenue")).status).toBe(403);
    await asStaff(["reports.read"]);
    expect((await csv("not-a-report")).status).toBe(404);
  });

  it("streams the revenue CSV of the period and audits data.exported with the filters and row count", async () => {
    const p = await makePerson(h.db, { isTester: false });
    await makePaidOrder(h.db, { personId: p.id, lines: [{ productKind: "package", unitAmountCents: 12_100 }], order: { paidAt: new Date("2024-02-14T10:00:00Z") } });
    const user = await asStaff(["reports.read"]);
    const res = await csv("revenue", "?period=month&at=2024-02-20&vat=incl");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("cache-control")).toContain("no-store");
    const text = (await res.text()).replace(/^﻿/, "");
    const lines = text.trim().split(/\r?\n/);
    expect(lines[0]).toContain("day");
    expect(lines[0]).toContain("net_cents");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("2024-02-14");
    expect(lines[1]).toContain("12100");
    const [audit] = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "data.exported"), eq(auditLog.entityType, "report")));
    expect(audit).toMatchObject({ newValue: { report: "revenue", filters: { period: "month", at: "2024-02-20", vat: "incl" }, rows: 1 } });
    expect((audit!.actor as { id: string }).id).toBe(user.id);
  });

  it("serves the liability CSV", async () => {
    await asStaff(["reports.read"]);
    const res = await csv("liability");
    expect(res.status).toBe(200);
    expect((await res.text()).replace(/^﻿/, "")).toMatch(/^as_of[,;]credit_kind/);
  });
});
