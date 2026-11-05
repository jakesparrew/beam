/**
 * crm-P8 pipeline and playbook (crm rules 3.46 to 3.48 and 3.56): the stage transitions, the
 * stage task with its dedupe key, the default probability unless set by hand, won and lost,
 * the enrolment call, escalation once per stage, last contact from the timeline, the board, the
 * B2C playbook over `ops.stage_changed` events, the playbook editor and the permissions.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { activityEvents, auditLog, companies, opportunities, playbookStages, roles, tasks, users, type OpportunityStage } from "@beam/db/schema";
import { defaultPlaybookRows } from "@beam/db/seed/crm";

process.env.SENSITIVE_DATA_KEY_V1 ??= randomBytes(32).toString("base64");
process.env.AUTH_SECRET = "crm-p8-pipeline-secret";

const enrol = vi.hoisted(() => vi.fn(async () => ({ status: "enrolled" as const, enrolmentId: "00000000-0000-4000-8000-000000000001" })));
const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.88" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));
vi.mock("@/modules/automation/api", async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), enrolPersonBySlug: enrol }));

const api = await import("./api");
const { getOpportunity, getPipelineBoard } = await import("./queries");
const actions = await import("./actions");
const auth = await import("@/lib/auth");
const { and, eq, setAppDb, sql } = await import("@/lib/ctx");
const { rowsOf } = await import("@/lib/sensitive");
const { makeCtx, resetRuntime, runJobTwice, staffActor } = await import("@/lib/testing");
const { PERMISSIONS } = await import("@/registry/permissions.generated");

let h: DbHandle;
let salesId: string;
let managerId: string;
let sales: ReturnType<typeof staffActor>;
const DAY = 86_400_000;

beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
  await h.db.insert(playbookStages).values(defaultPlaybookRows()).onConflictDoNothing();
  salesId = (await makeUser(h.db, { roleKey: "sales", locale: "en" })).id;
  managerId = (await makeUser(h.db, { roleKey: "management", locale: "nl-BE" })).id;
  await makeUser(h.db, { roleKey: "owner" }); // the fallback owner of a role nobody holds
  sales = staffActor({ userId: salesId, roleKey: "sales", permissions: ["persons.read", "crm.b2b"] });
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(() => {
  enrol.mockClear();
  jar.clear();
});

const ctx = (now?: Date) => makeCtx(h.db, { actor: sales, ...(now ? { now } : {}) });

async function company(): Promise<string> {
  const [row] = await h.db.insert(companies).values({ name: `Acme ${randomUUID().slice(0, 6)}` }).returning();
  return row!.id;
}

async function newOpportunity(over: Partial<Parameters<typeof api.saveStaffOpportunity>[1]> = {}) {
  const companyId = over.companyId ?? (await company());
  const { opportunityId } = await api.saveStaffOpportunity(ctx(), { companyId, title: "Team wellness days", valueCents: 500_000, ownerUserId: salesId, ...over });
  return opp(opportunityId);
}
const opp = async (id: string) => (await h.db.select().from(opportunities).where(eq(opportunities.id, id)))[0]!;
const move = (o: { id: string; version: number }, stage: OpportunityStage, extra: { lostReason?: string; now?: Date } = {}) =>
  api.moveStaffOpportunity(ctx(extra.now), { id: o.id, version: o.version, stage, ...(extra.lostReason ? { lostReason: extra.lostReason } : {}) });
const tasksOf = (opportunityId: string) => h.db.select().from(tasks).where(eq(tasks.opportunityId, opportunityId)).orderBy(tasks.createdAt, tasks.id);
const eventKinds = async (companyId: string) =>
  (await h.db.select({ kind: activityEvents.kind }).from(activityEvents).where(eq(activityEvents.companyId, companyId)).orderBy(activityEvents.id)).map((e) => e.kind);

describe("3.47 stage transitions", () => {
  const ALL = api.OPPORTUNITY_STAGES;
  const expected = (from: OpportunityStage, to: OpportunityStage): boolean => {
    if (from === to) return false;
    const open = (s: string) => (api.OPEN_STAGES as readonly string[]).includes(s);
    if (open(from)) return open(to) || to === "won" || to === "lost";
    return ({ won: ["account_management"], account_management: ["renewal"], renewal: ["won", "lost"], lost: ["target"] } as Record<string, string[]>)[from]!.includes(to);
  };

  it("3.47 allows exactly the listed moves", () => {
    for (const from of ALL) for (const to of ALL) expect(api.canMoveStage(from, to), `${from} -> ${to}`).toBe(expected(from, to));
  });

  it("3.47 every allowed move from an open stage succeeds and bumps the version", async () => {
    let o = await newOpportunity();
    for (const stage of ["prospect_identified", "qualified", "outreach", "negotiation"] as const) {
      const r = await move(o, stage);
      expect(r.stage).toBe(stage);
      expect(r.version).toBe(o.version + 1);
      o = await opp(o.id);
    }
  });

  it("3.47 won → account_management → renewal → won, and renewal → lost", async () => {
    let o = await newOpportunity();
    for (const stage of ["won", "account_management", "renewal", "won", "account_management", "renewal"] as const) {
      await move(o, stage);
      o = await opp(o.id);
    }
    await move(o, "lost", { lostReason: "Budget cut" });
    expect((await opp(o.id)).stage).toBe("lost");
  });

  it("3.47 won → lost and moves back from account management are refused", async () => {
    let o = await newOpportunity();
    await move(o, "won");
    o = await opp(o.id);
    await expect(move(o, "lost", { lostReason: "x" })).rejects.toMatchObject({ code: "conflict", message: "stage_transition_not_allowed" });
    await move(o, "account_management");
    o = await opp(o.id);
    await expect(move(o, "qualified")).rejects.toMatchObject({ code: "conflict" });
    await expect(move(o, "account_management")).rejects.toMatchObject({ code: "conflict", message: "same_stage" });
  });

  it("3.47 lost → target reopens: lost_at and lost_reason cleared, opportunity.reopened recorded", async () => {
    let o = await newOpportunity();
    await move(o, "lost", { lostReason: "Chose a competitor" });
    o = await opp(o.id);
    expect(o).toMatchObject({ stage: "lost", lostReason: "Chose a competitor", probabilityPct: 0 });
    expect(o.lostAt).toBeInstanceOf(Date);
    await expect(move(o, "qualified")).rejects.toMatchObject({ code: "conflict" });
    await move(o, "target");
    o = await opp(o.id);
    expect(o).toMatchObject({ stage: "target", lostReason: null, lostAt: null });
    expect(await eventKinds(o.companyId)).toEqual(expect.arrayContaining(["opportunity.lost", "opportunity.reopened"]));
  });

  it("3.47 a stale version is refused and changes nothing", async () => {
    const o = await newOpportunity();
    await move(o, "outreach");
    await expect(move(o, "response")).rejects.toMatchObject({ code: "conflict", message: "stale_version" });
    expect((await opp(o.id)).stage).toBe("outreach");
  });

  it("3.47 lost needs a reason", async () => {
    const o = await newOpportunity();
    await expect(move(o, "lost")).rejects.toMatchObject({ code: "validation", message: "lost_reason_required" });
  });

  it("3.47 won sets won_at and probability 100; won and lost leave the open board columns", async () => {
    const owner = (await makeUser(h.db, { roleKey: "sales" })).id;
    const a = await newOpportunity({ ownerUserId: owner, valueCents: 100_000 });
    const b = await newOpportunity({ ownerUserId: owner, valueCents: 40_000 });
    await move(a, "won");
    await move(b, "lost", { lostReason: "No budget" });
    expect(await opp(a.id)).toMatchObject({ stage: "won", probabilityPct: 100 });
    expect((await opp(a.id)).wonAt).toBeInstanceOf(Date);
    const board = await getPipelineBoard(h.db, { ownerUserId: owner });
    expect(board.columns.flatMap((c) => c.cards)).toHaveLength(0);
    expect(board.columns.map((c) => c.stage)).not.toContain("won");
    expect(board.won).toEqual({ count: 1, valueCents: 100_000 });
    expect(board.lost.count).toBe(1);
  });
});

describe("3.46 entering a stage", () => {
  it("3.46 creates one task for the owner from the required action, due deadline_days later, with the dedupe key", async () => {
    const o = await newOpportunity();
    const now = new Date("2026-11-02T10:15:30Z");
    await move(o, "response", { now });
    const after = await opp(o.id);
    const list = await tasksOf(o.id);
    const t = list.find((x) => x.dedupeKey === `playbook:${o.id}:response:2026-11-02T10:15`);
    expect(t).toMatchObject({ ownerUserId: salesId, title: "Schedule an introductory call", companyId: o.companyId, source: "system", status: "open" });
    expect(t!.dueAt!.getTime()).toBe(now.getTime() + 2 * DAY);
    // A repeated entry (same stage, same minute) creates nothing new.
    await api.enterStage(h.db as never, ctx(), after);
    expect((await tasksOf(o.id)).filter((x) => x.dedupeKey?.includes(":response:"))).toHaveLength(1);
    expect(await eventKinds(o.companyId)).toEqual(expect.arrayContaining(["opportunity.created", "opportunity.stage_changed", "task.created"]));
  });

  it("3.46 writes the task title in the owner's language", async () => {
    const o = await newOpportunity({ ownerUserId: managerId });
    await move(o, "proposal");
    const titles = (await tasksOf(o.id)).map((t) => t.title);
    expect(titles).toContain("Stuur het voorstel en plan de opvolging");
  });

  it("3.46 applies the stage's default probability unless staff set it by hand on the current stage", async () => {
    let o = await newOpportunity();
    expect(o.probabilityPct).toBe(5); // target default
    await move(o, "qualified");
    o = await opp(o.id);
    expect(o.probabilityPct).toBe(40);
    await api.saveStaffOpportunity(ctx(new Date(Date.now() + 1000)), { id: o.id, version: o.version, companyId: o.companyId, title: o.title, valueCents: o.valueCents, ownerUserId: o.ownerUserId, probabilityPct: 65 });
    o = await opp(o.id);
    await move(o, "discovery", { now: new Date(Date.now() + 2000) });
    o = await opp(o.id);
    expect(o.probabilityPct).toBe(65);
    await move(o, "proposal", { now: new Date(Date.now() + 3000) });
    expect((await opp(o.id)).probabilityPct).toBe(60);
  });

  it("3.46 enrols the primary contact when the stage has an automation slug, and not without a contact", async () => {
    await h.db.update(playbookStages).set({ automatedCommunication: { automation_slug: "b2b-proposal-follow-up" } }).where(and(eq(playbookStages.pipeline, "b2b"), eq(playbookStages.stageKey, "proposal")));
    const contact = await makePerson(h.db);
    const o = await newOpportunity({ primaryContactPersonId: contact.id });
    await move(o, "proposal");
    expect(enrol).toHaveBeenCalledWith(expect.anything(), { slug: "b2b-proposal-follow-up", personId: contact.id });
    enrol.mockClear();
    const without = await newOpportunity();
    await move(without, "proposal");
    expect(enrol).not.toHaveBeenCalled();
  });

  it("3.46 an inactive playbook stage creates no task", async () => {
    await h.db.update(playbookStages).set({ isActive: false }).where(and(eq(playbookStages.pipeline, "b2b"), eq(playbookStages.stageKey, "contact_identified")));
    const o = await newOpportunity();
    await move(o, "contact_identified");
    expect((await tasksOf(o.id)).filter((t) => t.dedupeKey?.includes(":contact_identified:"))).toHaveLength(0);
    await h.db.update(playbookStages).set({ isActive: true }).where(and(eq(playbookStages.pipeline, "b2b"), eq(playbookStages.stageKey, "contact_identified")));
  });

  it("3.46 writes the opportunity.save and opportunity.stage audit rows", async () => {
    const o = await newOpportunity();
    await move(o, "outreach");
    const actionsFor = (await h.db.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.entityId, o.id))).map((r) => r.action);
    expect(actionsFor).toEqual(expect.arrayContaining(["opportunity.save", "opportunity.stage"]));
  });
});

describe("3.48 escalation and the board", () => {
  it("3.48 a stalled opportunity escalates once per stage: one task for the notify role, one Slack line", async () => {
    const o = await newOpportunity();
    await move(o, "response");
    const entered = new Date(Date.now() - 8 * DAY); // response escalates after 7 days
    await h.db.update(opportunities).set({ stageEnteredAt: entered }).where(eq(opportunities.id, o.id));
    await runJobTwice(h.db, "crm.escalate_opportunities", {});
    const key = `escalate:${o.id}:response:${entered.toISOString().slice(0, 16)}`;
    const esc = await h.db.select({ owner: tasks.ownerUserId, priority: tasks.priority, role: users.roleKey }).from(tasks).innerJoin(users, eq(users.id, tasks.ownerUserId)).where(eq(tasks.dedupeKey, key));
    expect(esc).toEqual([{ owner: expect.any(String), priority: "high", role: "management" }]);
    const slack = rowsOf<{ n: number }>(await h.db.execute(sql`select count(*)::int as n from jobs where kind = 'notify.slack' and payload->>'fingerprint' = ${`opportunity:${o.id}:response:escalated`}`));
    expect(Number(slack[0]!.n)).toBe(1);
    const board = await getPipelineBoard(h.db, { ownerUserId: salesId });
    expect(board.columns.find((c) => c.stage === "response")!.cards.find((c) => c.id === o.id)!.isStalled).toBe(true);
  });

  it("3.48 an opportunity inside its escalation window is not escalated", async () => {
    const o = await newOpportunity();
    await move(o, "qualified");
    await runJobTwice(h.db, "crm.escalate_opportunities", {});
    const n = rowsOf<{ n: number }>(await h.db.execute(sql`select count(*)::int as n from tasks where dedupe_key like ${`escalate:${o.id}:%`}`));
    expect(Number(n[0]!.n)).toBe(0);
  });

  it("3.46 last contact comes from the company and contact timeline", async () => {
    const contact = await makePerson(h.db);
    const o = await newOpportunity({ primaryContactPersonId: contact.id });
    const at = new Date("2026-10-20T08:00:00Z");
    await h.db.insert(activityEvents).values({ personId: contact.id, kind: "interaction.logged", occurredAt: at, actor: { kind: "system", id: null }, data: { channel: "phone", purpose: "sales" } });
    await h.db.insert(activityEvents).values({ personId: contact.id, kind: "tag.added", occurredAt: new Date("2026-10-25T08:00:00Z"), actor: { kind: "system", id: null }, data: { tag_key: "vip", source: "manual" } });
    const detail = await getOpportunity(h.db, o.id);
    // The opportunity.created event is not contact; the stage change below is.
    expect(detail!.lastContactAt?.toISOString()).toBe(at.toISOString());
    await move(o, "outreach");
    expect((await getOpportunity(h.db, o.id))!.lastContactAt!.getTime()).toBeGreaterThan(at.getTime());
  });

  it("3.46 the board sums value and weighted value per column", async () => {
    const owner = (await makeUser(h.db, { roleKey: "sales" })).id;
    await newOpportunity({ ownerUserId: owner, valueCents: 100_000, probabilityPct: 50 });
    await newOpportunity({ ownerUserId: owner, valueCents: 30_000 });
    const board = await getPipelineBoard(h.db, { ownerUserId: owner });
    const target = board.columns.find((c) => c.stage === "target")!;
    expect(target.cards).toHaveLength(2);
    expect(target).toMatchObject({ totalCents: 130_000, weightedCents: 50_000 + 1_500 });
    expect((await getPipelineBoard(h.db, { ownerUserId: owner, minValueCents: 50_000 })).columns.find((c) => c.stage === "target")!.cards).toHaveLength(1);
  });
});

describe("3.56 B2C playbook", () => {
  async function stageChanged(personId: string, to: string, occurredAt = new Date()) {
    const [row] = await h.db
      .insert(activityEvents)
      .values({ personId, kind: "ops.stage_changed", occurredAt, actor: { kind: "system", id: null }, data: { from: "lead", to }, dedupeKey: `stage:${personId}:${to}:${randomUUID()}` })
      .returning({ id: activityEvents.id });
    return String(row!.id);
  }
  const b2cTasks = (personId: string) => h.db.select().from(tasks).where(sql`${tasks.dedupeKey} like ${`playbook:b2c:${personId}:%`}`);

  it("3.56 one task per ops.stage_changed event for the stage's owner role; overlapping windows create nothing new", async () => {
    const csUser = (await makeUser(h.db, { roleKey: "customer_service", locale: "fr-BE" })).id;
    const p = await makePerson(h.db);
    const eventId = await stageChanged(p.id, "engaged_lead");
    await runJobTwice(h.db, "crm.apply_btoc_playbook", {});
    await runJobTwice(h.db, "crm.apply_btoc_playbook", {});
    const list = await b2cTasks(p.id);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ dedupeKey: `playbook:b2c:${p.id}:engaged_lead:${eventId}`, personId: p.id, source: "system" });
    const [owner] = await h.db.select({ role: users.roleKey }).from(users).where(eq(users.id, list[0]!.ownerUserId));
    expect(owner!.role).toBe("customer_service");
    expect(csUser).toBeTruthy();
  });

  it("3.56 an event outside the 30-minute window is ignored", async () => {
    const p = await makePerson(h.db);
    await stageChanged(p.id, "lead", new Date(Date.now() - 45 * 60_000));
    await runJobTwice(h.db, "crm.apply_btoc_playbook", {});
    expect(await b2cTasks(p.id)).toHaveLength(0);
  });

  it("3.56 an inactive stage is ignored", async () => {
    await h.db.update(playbookStages).set({ isActive: false }).where(and(eq(playbookStages.pipeline, "b2c"), eq(playbookStages.stageKey, "active")));
    const p = await makePerson(h.db);
    await stageChanged(p.id, "active");
    await runJobTwice(h.db, "crm.apply_btoc_playbook", {});
    expect(await b2cTasks(p.id)).toHaveLength(0);
  });

  it("3.56 enrols the person when the stage has an automation slug", async () => {
    await h.db.update(playbookStages).set({ automatedCommunication: { automation_slug: "b2c-first-visit" } }).where(and(eq(playbookStages.pipeline, "b2c"), eq(playbookStages.stageKey, "first_visit")));
    const p = await makePerson(h.db);
    await stageChanged(p.id, "first_visit");
    await runJobTwice(h.db, "crm.apply_btoc_playbook", {});
    expect(enrol).toHaveBeenCalledTimes(1);
    expect(enrol).toHaveBeenCalledWith(expect.anything(), { slug: "b2c-first-visit", personId: p.id });
  });

  it("3.56 a B2C task open longer than escalation.after_days is escalated once", async () => {
    const p = await makePerson(h.db);
    await stageChanged(p.id, "retention");
    await runJobTwice(h.db, "crm.apply_btoc_playbook", {});
    const [t] = await b2cTasks(p.id);
    await h.db.update(tasks).set({ createdAt: new Date(Date.now() - 11 * DAY) }).where(eq(tasks.id, t!.id));
    await runJobTwice(h.db, "crm.apply_btoc_playbook", {});
    const esc = await h.db.select().from(tasks).where(eq(tasks.dedupeKey, `escalate:b2c:${t!.id}`));
    expect(esc).toHaveLength(1);
    expect(esc[0]).toMatchObject({ personId: p.id, priority: "high" });
  });
});

describe("playbook editor (savePlaybookStage)", () => {
  const base = {
    pipeline: "b2b" as const,
    stageKey: "discovery",
    sortOrder: 70,
    name: { "nl-BE": "Verkenning", "fr-BE": "Découverte", en: "Discovery" },
    requiredAction: { "nl-BE": "Bel", "fr-BE": "Appeler", en: "Call" },
    ownerRole: "sales",
    deadlineDays: 4,
    defaultProbabilityPct: 55,
    automatedCommunication: {},
    escalation: { after_days: 9, notify_role: "management" },
    kpi: {},
    isActive: true,
  };
  const admin = () => makeCtx(h.db, { actor: staffActor({ userId: managerId, roleKey: "management", permissions: ["settings.write", "crm.b2b"] }) });

  it("updates the stage and writes playbook.save", async () => {
    const { stageId } = await api.saveStaffPlaybookStage(admin(), base);
    const [row] = await h.db.select().from(playbookStages).where(eq(playbookStages.id, stageId));
    expect(row).toMatchObject({ deadlineDays: 4, defaultProbabilityPct: 55, escalation: { after_days: 9, notify_role: "management" }, updatedByUserId: managerId });
    const audits = await h.db.select().from(auditLog).where(and(eq(auditLog.entityId, stageId), eq(auditLog.action, "playbook.save")));
    expect(audits.length).toBeGreaterThan(0);
  });

  it("refuses a text missing a language, a B2C probability and an unknown stage key", async () => {
    await expect(api.saveStaffPlaybookStage(admin(), { ...base, requiredAction: { "nl-BE": "Bel", "fr-BE": "", en: "Call" } })).rejects.toMatchObject({ code: "validation", message: "missing_locales" });
    await expect(api.saveStaffPlaybookStage(admin(), { ...base, pipeline: "b2c", stageKey: "lead" })).rejects.toMatchObject({ code: "validation", message: "probability_b2b_only" });
    await expect(api.saveStaffPlaybookStage(admin(), { ...base, stageKey: "engaged_lead" })).rejects.toMatchObject({ code: "validation", message: "stage_key_invalid" });
  });
});

describe("pipeline permissions", () => {
  async function signInWith(permissions: readonly string[]) {
    const user = await makeUser(h.db, { roleKey: "marketing" });
    await h.db.update(roles).set({ permissions: [...permissions] }).where(eq(roles.key, "marketing"));
    const { token } = await auth.createAuthSession(h.db, { userId: user.id, audience: "staff", roleKey: "marketing", now: new Date(), mfaAt: new Date() });
    jar.set(auth.SESSION_COOKIE, token);
  }
  const CASES: Array<[string, (raw: unknown) => Promise<{ ok: boolean; error?: { code: string } }>, string]> = [
    ["saveOpportunity", actions.saveOpportunity as never, "crm.b2b"],
    ["moveOpportunityStage", actions.moveOpportunityStage as never, "crm.b2b"],
    ["savePlaybookStage", actions.savePlaybookStage as never, "settings.write"],
  ];

  it.each(CASES)("%s refuses a staff user without its permission", async (_name, call, permission) => {
    await signInWith((PERMISSIONS as readonly string[]).filter((p) => p !== permission));
    expect(await call({})).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });

  it("moveOpportunityStage moves through the action for a crm.b2b user", async () => {
    await signInWith(["crm.b2b", "persons.read"]);
    const o = await newOpportunity();
    const result = await actions.moveOpportunityStage({ id: o.id, version: o.version, stage: "outreach" });
    expect(result).toMatchObject({ ok: true, data: { stage: "outreach", version: o.version + 1 } });
  });
});
