/**
 * Person page controls (automation-P6, A-36 to A-38, edge case 20): `exitEnrolment` writes
 * `manual` and one audit row; `enrolPerson` overrides re-entry and exclusivity (the blocking
 * journey exits `moved`); `movePerson` is one transaction with one audit row (a refused target
 * leaves the person where they were); a staff enrolment into a marketing journey of an
 * unsubscribed person sends nothing; each control is refused without `automations.move_person`;
 * the panel hides the controls without that permission. Email is mocked to its contract's shapes
 * (CONVENTIONS 11), booking and commerce because the step job imports them.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle, Tx } from "@beam/db";
import { auditLog, automationEnrolments, automationRuns, jobs, roles } from "@beam/db/schema";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import type { Definition } from "@beam/core/automation";
import type * as EmailApi from "@/modules/email/api";

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
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));

const state = vi.hoisted(() => ({
  templates: new Map<string, { templateVersionId: string; kind: "marketing" | "transactional"; purpose: "newsletter" | "events" | null; locales: string[] }>(),
  unreachable: new Set<string>(),
}));
vi.mock("@/modules/email/api", async (orig) => ({
  ...(await orig<typeof EmailApi>()),
  getPublishedTemplateInfo: vi.fn((_db: unknown, slugs: string[]) =>
    Promise.resolve(new Map(slugs.filter((s) => state.templates.has(s)).map((s) => [s, state.templates.get(s)!]))),
  ),
  getReachability: vi.fn((_tx: unknown, personId: string) =>
    Promise.resolve(state.unreachable.has(personId) ? { isReachable: false, blockedReason: "suppressed" } : { isReachable: true, blockedReason: null }),
  ),
  queueMarketingEmail: vi.fn(() => Promise.reject(new Error("queueMarketingEmail must not be called"))),
  queueAutomationEmail: vi.fn(() => Promise.reject(new Error("queueAutomationEmail must not be called"))),
}));
vi.mock("@/modules/booking/api", () => ({ nextOpeningAt: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@/modules/commerce/api", () => ({
  getCheckoutRecoveryProps: vi.fn(() => Promise.resolve({ resumeUrl: "https://beam.example.com/r/abc", items: [], totalCents: 1000, locale: "nl-BE" })),
  markCheckoutRecoveryMessage: vi.fn(() => Promise.resolve()),
}));

const actions = await import("./actions");
const { runStep } = await import("./engine/step");
const f = await import("./engine/automation-p3.fixtures");
const email = await import("@/modules/email/api");
const { createAuthSession, SESSION_COOKIE } = await import("@/lib/auth");
const { and, eq, setAppDb } = await import("@/lib/ctx");
const { makeCtx, resetRuntime } = await import("@/lib/testing");
const { PersonAutomationsPanel } = await import("./ui/person-automations-panel");

let h: DbHandle;
let mover: { id: string };
let viewer: { id: string };

type Result = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };
function ok<T>(r: Result): T {
  expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
  return (r as { ok: true; data: T }).data;
}
function err(r: Result, code: string, message?: string) {
  expect(r, JSON.stringify(r)).toMatchObject({ ok: false, error: { code, ...(message ? { message } : {}) } });
}

async function signIn(userId: string, roleKey: "marketing" | "customer_service") {
  jar.clear();
  const { token } = await createAuthSession(h.db, { userId, audience: "staff", roleKey, now: new Date(), mfaAt: new Date() });
  jar.set(SESSION_COOKIE, token);
}

beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
  await f.makeTag(h.db, "engaged");
  mover = await makeUser(h.db, { roleKey: "marketing" });
  viewer = await makeUser(h.db, { roleKey: "customer_service" });
  await h.db.update(roles).set({ permissions: ["automations.move_person", "persons.read", "automations.write"] }).where(eq(roles.key, "marketing"));
  await h.db.update(roles).set({ permissions: ["persons.read"] }).where(eq(roles.key, "customer_service"));
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  state.templates.clear();
  state.unreachable.clear();
  vi.clearAllMocks();
  await signIn(mover.id, "marketing");
});

const DAY = 1440;
const later: Definition = f.steps([{ key: "s1", type: "tag", tag: "engaged", at: { from: "enrolment", minutes: DAY } }], { re_entry: "never" });

const audits = (action: string, personId: string) => h.db.select().from(auditLog).where(and(eq(auditLog.action, action), eq(auditLog.personId, personId)));
const enrolmentsOf = (personId: string) => h.db.select().from(automationEnrolments).where(eq(automationEnrolments.personId, personId));

describe("A-36 exitEnrolment", () => {
  it("A-36 ends the enrolment with manual, one exited run and one audit row with the person", async () => {
    const a = await f.makeAutomation(h.db, { definition: later, isMarketing: false });
    const p = await makePerson(h.db);
    const id = await f.enrolInto(h.db, a.id, p.id, { now: new Date() });
    ok(await actions.exitEnrolment({ enrolmentId: id, note: "asked by phone" }));
    expect(await f.enrolmentRow(h.db, id)).toMatchObject({ status: "exited", endReason: "manual", nextStepKey: null });
    const exited = (await f.runsOfEnrolment(h.db, id)).filter((r) => r.outcome === "exited");
    expect(exited).toHaveLength(1);
    expect(exited[0]).toMatchObject({ reason: "manual", actor: { kind: "staff", id: mover.id } });
    const rows = await audits("automation.person_exit", p.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entityType: "automation_enrolment", entityId: id });
    err(await actions.exitEnrolment({ enrolmentId: id }), "conflict", "enrolment_not_active");
    expect(await audits("automation.person_exit", p.id)).toHaveLength(1);
  });
});

describe("A-37 enrolPerson", () => {
  it("A-37 overrides re-entry never and exclusivity priority: the blocking journey exits moved", async () => {
    const group = await f.makeGroup(h.db, { isExclusive: true, lane: null, priority: 10 });
    const holder = await f.makeAutomation(h.db, { definition: later, group, isMarketing: false, priority: 1 });
    const target = await f.makeAutomation(h.db, { definition: later, group, isMarketing: false, priority: 900 });
    const p = await makePerson(h.db);
    // A finished earlier enrolment of the target: re-entry `never` would refuse a trigger entry.
    const earlier = await f.enrolInto(h.db, target.id, p.id, { now: new Date(Date.now() - 10 * 86_400_000) });
    await actions.exitEnrolment({ enrolmentId: earlier });
    const held = await f.enrolInto(h.db, holder.id, p.id, { now: new Date() });

    const res = ok<{ status: string; enrolmentId: string }>(await actions.enrolPerson({ personId: p.id, automationId: target.id }));
    expect(res.status).toBe("enrolled");
    expect(await f.enrolmentRow(h.db, held)).toMatchObject({ status: "exited", endReason: "moved" });
    expect(await f.enrolmentRow(h.db, res.enrolmentId)).toMatchObject({ status: "active", source: "staff", enteredByUserId: mover.id });
    const rows = await audits("automation.person_enrol", p.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entityId: res.enrolmentId });
  });

  it("A-37 the anchor is required when the definition has a data anchor", async () => {
    const a = await f.makeAutomation(h.db, {
      definition: f.steps([{ key: "s1", type: "tag", tag: "engaged", at: { from: "anchor", minutes: -60 } }], { anchor: "data.starts_at" }),
      isMarketing: false,
    });
    const p = await makePerson(h.db);
    err(await actions.enrolPerson({ personId: p.id, automationId: a.id }), "validation", "anchor_required");
    const anchorAt = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const res = ok<{ enrolmentId: string }>(await actions.enrolPerson({ personId: p.id, automationId: a.id, anchorAt }));
    expect((await f.enrolmentRow(h.db, res.enrolmentId)).anchorAt?.toISOString()).toBe(anchorAt);
  });

  it("edge case 20: staff enrol into a marketing journey of an unsubscribed person sends nothing", async () => {
    state.templates.set("m-news", { templateVersionId: "00000000-0000-4000-8000-000000000010", kind: "marketing", purpose: "newsletter", locales: ["nl-BE", "fr-BE", "en"] });
    const a = await f.makeAutomation(h.db, {
      definition: f.steps([{ key: "news", type: "email", template: "m-news", at: { from: "enrolment", minutes: 0 } }]),
      isMarketing: true,
      purpose: "newsletter",
    });
    const p = await makePerson(h.db, { locale: "nl-BE" });
    state.unreachable.add(p.id);
    const res = ok<{ status: string; enrolmentId: string }>(await actions.enrolPerson({ personId: p.id, automationId: a.id }));
    expect(res.status).toBe("enrolled");
    // The first step is due at once: it is enqueued for the after-commit kick.
    const [job] = await h.db.select().from(jobs).where(eq(jobs.idempotencyKey, `automation:${res.enrolmentId}:news`));
    expect(job).toMatchObject({ kind: "automation.step", lane: "fast", priority: 5 });
    const ran = await runStep(h.db as unknown as Tx, { enrolmentId: res.enrolmentId, stepKey: "news", now: new Date() }, { ctx: makeCtx(h.db) });
    expect(ran).toMatchObject({ status: "ran", outcome: "skipped_unreachable" });
    expect(email.queueMarketingEmail).not.toHaveBeenCalled();
    expect(email.queueAutomationEmail).not.toHaveBeenCalled();
    expect(await f.stepOutcomes(h.db, res.enrolmentId)).toEqual([
      ["news", "skipped_unreachable"],
      [null, "completed"],
    ]);
  });
});

describe("A-38 movePerson", () => {
  it("A-38 exits moved and enrols in one transaction with one audit row naming both slugs", async () => {
    const from = await f.makeAutomation(h.db, { slug: `p6-welcome-${Date.now().toString(36)}`, definition: later, isMarketing: false });
    const to = await f.makeAutomation(h.db, { slug: `p6-visit-${Date.now().toString(36)}`, definition: later, isMarketing: false });
    const p = await makePerson(h.db);
    const id = await f.enrolInto(h.db, from.id, p.id, { now: new Date() });
    const res = ok<{ exitedEnrolmentId: string; enrolment: { status: string; enrolmentId: string } }>(await actions.movePerson({ personId: p.id, fromEnrolmentId: id, toAutomationId: to.id }));
    expect(res.exitedEnrolmentId).toBe(id);
    expect(await f.enrolmentRow(h.db, id)).toMatchObject({ status: "exited", endReason: "moved" });
    expect(await f.enrolmentRow(h.db, res.enrolment.enrolmentId)).toMatchObject({ status: "active", source: "staff_move", automationId: to.id });
    const rows = await audits("automation.person_move", p.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.oldValue).toMatchObject({ automation: from.slug, enrolmentId: id });
    expect(rows[0]!.newValue).toMatchObject({ automation: to.slug, enrolmentId: res.enrolment.enrolmentId });
    // Both show on the timeline: `exited` (moved) on the old enrolment, `entered` on the new one.
    const runs = await h.db.select().from(automationRuns).where(eq(automationRuns.personId, p.id));
    expect(runs.some((r) => r.enrolmentId === id && r.outcome === "exited" && r.reason === "moved")).toBe(true);
    expect(runs.some((r) => r.enrolmentId === res.enrolment.enrolmentId && r.outcome === "entered")).toBe(true);
  });

  it("A-38 a refused target rolls the whole move back: the person stays in the old journey", async () => {
    const from = await f.makeAutomation(h.db, { definition: later, isMarketing: false });
    const to = await f.makeAutomation(h.db, { definition: later, isMarketing: false });
    const p = await makePerson(h.db);
    const id = await f.enrolInto(h.db, from.id, p.id, { now: new Date() });
    await f.enrolInto(h.db, to.id, p.id, { now: new Date() });
    err(await actions.movePerson({ personId: p.id, fromEnrolmentId: id, toAutomationId: to.id }), "conflict", "move_refused:re_entry");
    expect(await f.enrolmentRow(h.db, id)).toMatchObject({ status: "active", endReason: null });
    expect((await enrolmentsOf(p.id)).filter((e) => e.status === "active")).toHaveLength(2);
    expect(await audits("automation.person_move", p.id)).toHaveLength(0);
    err(await actions.movePerson({ personId: p.id, fromEnrolmentId: id, toAutomationId: from.id }), "conflict", "move_same_automation");
  });
});

describe("permissions and the panel", () => {
  it("every person control is refused without automations.move_person", async () => {
    const a = await f.makeAutomation(h.db, { definition: later, isMarketing: false });
    const b = await f.makeAutomation(h.db, { definition: later, isMarketing: false });
    const p = await makePerson(h.db);
    const id = await f.enrolInto(h.db, a.id, p.id, { now: new Date() });
    await signIn(viewer.id, "customer_service");
    err(await actions.exitEnrolment({ enrolmentId: id }), "forbidden");
    err(await actions.enrolPerson({ personId: p.id, automationId: b.id }), "forbidden");
    err(await actions.movePerson({ personId: p.id, fromEnrolmentId: id, toAutomationId: b.id }), "forbidden");
    expect(await f.enrolmentRow(h.db, id)).toMatchObject({ status: "active" });
  });

  it("the panel shows the journey, its preview and timeline; Exit, Enrol and Move only with the permission", async () => {
    const a = await f.makeAutomation(h.db, { definition: later, isMarketing: false });
    const p = await makePerson(h.db);
    const id = await f.enrolInto(h.db, a.id, p.id, { now: new Date() });
    const render = async (canMove: boolean) => renderToStaticMarkup(await PersonAutomationsPanel({ personId: p.id, db: h.db, locale: "en", canMove }));
    const withControls = await render(true);
    expect(withControls).toContain(`data-enrolment-id="${id}"`);
    expect(withControls).toContain('data-testid="automation-preview-open"');
    expect(withControls).toContain('data-testid="automation-timeline"');
    expect(withControls).toContain('data-testid="automation-enrol-open"');
    expect(withControls).toContain(`data-exit-for="${id}"`);
    expect(withControls).toContain("Preview next steps");
    const readOnly = await render(false);
    expect(readOnly).not.toContain("automation-enrol-open");
    expect(readOnly).not.toContain("automation-exit-open");
    expect(readOnly).not.toContain("automation-move-open");
  });
});
