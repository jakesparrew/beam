/**
 * ops-P8 permissions (ops spec 7): the management and marketing dashboards, attribution, the
 * funnel and the ads report need `reports.read`; "Pull now" (`pullAdsNow`) needs
 * `settings.write` and audits `ads.pull_requested`; the `b2b_proposals` card is shown only with
 * `crm.b2b` (on top of the dashboard's own permission); the marketing report CSVs need
 * `reports.read` and audit `data.exported`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { auditLog, companies, featureFlags, jobs, opportunities, roles, settings } from "@beam/db/schema";
import { ForbiddenError } from "@beam/core/errors";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";

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

const { pullAdsNow } = await import("./actions");
const q = await import("./queries");
const { getActionDashboard } = await import("../dashboard/queries");
const { GET } = await import("@/app/(admin)/admin/reports/[report]/csv/route");
const { createAuthSession, SESSION_COOKIE } = await import("@/lib/auth");
const { eq, setAppDb, sql } = await import("@/lib/ctx");
const { resetRuntime, staffActor } = await import("@/lib/testing");

let h: DbHandle;
const NOW = new Date("2026-10-15T10:00:00.000Z");
const readCtx = (permissions: string[]) => ({ tx: h.db, actor: staffActor({ permissions }), now: NOW, locale: "en" as const });

async function asStaff(perms: string[]) {
  const user = await makeUser(h.db, { roleKey: "marketing" });
  await h.db.update(roles).set({ permissions: perms }).where(eq(roles.key, "marketing"));
  const { token } = await createAuthSession(h.db, { userId: user.id, audience: "staff", roleKey: "marketing", now: new Date(), mfaAt: new Date() });
  jar.set(SESSION_COOKIE, token);
  return user;
}

beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
  await h.db.insert(featureFlags).values({ key: "ff_ops_marketing", state: "on" });
  await h.db.insert(settings).values({ key: "ads", value: { meta_account_ids: ["act_1"], google_customer_ids: [] } });
  const owner = await makeUser(h.db, { roleKey: "sales" });
  const contact = await makePerson(h.db, { isTester: false, firstName: "Bea" });
  const [co] = await h.db.insert(companies).values({ name: "Example BV" }).returning();
  await h.db.insert(opportunities).values([
    { companyId: co!.id, title: "Team days", ownerUserId: owner.id, stage: "proposal", primaryContactPersonId: contact.id, valueCents: 50_000 },
    { companyId: co!.id, title: "Later", ownerUserId: owner.id, stage: "negotiation", nextActionAt: new Date(Date.now() + 30 * 86_400_000) },
    { companyId: co!.id, title: "Early", ownerUserId: owner.id, stage: "qualified" },
  ]);
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(() => jar.clear());

describe("marketing queries (reports.read)", () => {
  const calls: [string, (ctx: ReturnType<typeof readCtx>) => Promise<unknown>][] = [
    ["getManagementDashboard", (c) => q.getManagementDashboard(c, { period: "month", at: NOW })],
    ["getMarketingDashboard", (c) => q.getMarketingDashboard(c, {})],
    ["getAttributionReport", (c) => q.getAttributionReport(c, {})],
    ["getCampaignFunnel", (c) => q.getCampaignFunnel(c, {})],
    ["getAdsReport", (c) => q.getAdsReport(c, {})],
    ["getEmailSummary", (c) => q.getEmailSummary(c, {})],
    ["getWebinarSummary", (c) => q.getWebinarSummary(c, {})],
  ];

  it.each(calls)("%s refuses staff without reports.read", async (_name, call) => {
    await expect(call(readCtx(["tasks.all", "settings.write", "crm.b2b"]))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it.each(calls)("%s answers with reports.read", async (_name, call) => {
    await expect(call(readCtx(["reports.read"]))).resolves.toBeTruthy();
  });
});

describe("pullAdsNow (settings.write)", () => {
  it("is unauthorized without a session and forbidden without settings.write; nothing is queued", async () => {
    expect(await pullAdsNow({ days: 3 })).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    await asStaff(["reports.read"]);
    expect(await pullAdsNow({ days: 3 })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await h.db.select().from(jobs).where(eq(jobs.kind, "ads.backfill"))).toEqual([]);
  });

  it("refuses days outside 1..90", async () => {
    await asStaff(["settings.write"]);
    expect(await pullAdsNow({ days: 0 })).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(await pullAdsNow({ days: 91 })).toMatchObject({ ok: false, error: { code: "validation" } });
  });

  it("with settings.write queues one backfill per account and audits ads.pull_requested", async () => {
    const user = await asStaff(["settings.write"]);
    const res = await pullAdsNow({ days: 3 });
    expect(res).toMatchObject({ ok: true });
    if (!res.ok) return;
    expect(res.data.jobIds).toHaveLength(1);
    const audits = await h.db.select().from(auditLog).where(eq(auditLog.action, "ads.pull_requested"));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actor).toMatchObject({ kind: "staff", id: user.id });
  });
});

describe("b2b_proposals card (rule 26, crm.b2b)", () => {
  const ctx = (permissions: string[]) => ({ tx: h.db, actor: staffActor({ permissions }), now: new Date(), locale: "en" as const });

  it("is hidden without crm.b2b", async () => {
    const cards = await getActionDashboard(ctx(["reports.read", "tasks.all"]));
    expect(cards.map((c) => c.key)).not.toContain("b2b_proposals");
  });

  it("lists proposals and negotiations whose next action is past or missing", async () => {
    const cards = await getActionDashboard(ctx(["reports.read", "crm.b2b", "tasks.all"]));
    const card = cards.find((c) => c.key === "b2b_proposals");
    expect(card).toBeDefined();
    expect(card!.count).toBe(1);
    expect(card!.rows[0]).toMatchObject({ refType: "opportunity", params: { company: "Example BV", stage: "proposal" } });
    expect(card!.rows[0]!.name).toContain("Bea");
    expect(card!.canCreateTask).toBe(true);
    const week = await getActionDashboard(ctx(["reports.read", "crm.b2b"]), { view: "week" });
    expect(week.find((c) => c.key === "b2b_proposals")!.count).toBe(1);
  });
});

describe("marketing report CSVs (reports.read, data.exported)", () => {
  const csv = (report: string) => GET(new Request(`https://beam.example.com/admin/reports/${report}/csv`), { params: Promise.resolve({ report }) });

  it.each(["management", "marketing", "attribution", "ads"])("%s: 403 without reports.read, 200 and audited with it", async (report) => {
    await asStaff(["settings.write"]);
    expect((await csv(report)).status).toBe(403);
    await asStaff(["reports.read"]);
    const res = await csv(report);
    expect(res.status).toBe(200);
    expect((await res.text()).split("\n")[0]).toContain(",");
    const [row] = await h.db.execute(sql`select count(*)::int as n from audit_log where action = 'data.exported' and new_value->>'report' = ${report}`).then((r) => (r as unknown as { rows: { n: number }[] }).rows ?? (r as unknown as { n: number }[]));
    expect(Number(row?.n)).toBeGreaterThan(0);
  });
});
