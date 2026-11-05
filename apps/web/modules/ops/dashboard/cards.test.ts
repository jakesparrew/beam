/**
 * ops rules 22b-32 (ops-P3): every V1 action dashboard card fires on its fixture and stays quiet
 * on the one just outside its window; a card is hidden without its permission; the This week
 * view widens the date horizons by 7 days. One database for the file: each case looks only for
 * its own rows (the card lists are read in full with `expand`), never at global counts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@beam/db";
import { mandates, personStats } from "@beam/db/schema";
import { periodRange, RETENTION_DEFAULTS, type ActionCardKey } from "@beam/core/ops";
import { createTestDb, makeUser } from "@beam/db/testing";
import { makeOrder, makePaidOrder } from "@beam/db/testing/commerce-factories";
import { makeCreditGrant, makeEntry, makeMembership } from "@beam/db/testing/credits-factories";
import { resetRuntime, staffActor } from "@/lib/testing";
import type { OpsReadCtx } from "../reports/registry";
import { getActionDashboard } from "./queries";
import { ago, ahead, DAY, makeBookingAt, makeCustomer, makeImportedRegistration, makeOpenTask, makePayment } from "./ops-p3.fixtures";

let h: DbHandle;
const HOUR = 3_600_000;
const ALL = ["reports.read", "tasks.all", "credits.read", "commerce.sell", "privacy.run"];

function ctxFor(permissions: string[] = ALL, userId?: string): OpsReadCtx {
  return { tx: h.db, actor: staffActor({ permissions, ...(userId ? { userId } : {}) }), now: new Date(), locale: "en" };
}

async function card(key: ActionCardKey, opts: { view?: "today" | "week"; ctx?: OpsReadCtx } = {}) {
  const cards = await getActionDashboard(opts.ctx ?? ctxFor(), { view: opts.view, expand: key });
  return cards.find((c) => c.key === key);
}
async function refs(key: ActionCardKey, view: "today" | "week" = "today", ctx?: OpsReadCtx): Promise<string[]> {
  return ((await card(key, { view, ctx }))?.rows ?? []).map((r) => r.refId);
}
async function persons(key: ActionCardKey, view: "today" | "week" = "today"): Promise<(string | null)[]> {
  return ((await card(key, { view }))?.rows ?? []).map((r) => r.personId);
}

beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

describe("rule 23: packages_nearing_completion", () => {
  it("fires for a grant used 80 %, not for one used 70 %", async () => {
    const p = await makeCustomer(h.db, { firstName: "Ann", lastName: "Peeters" });
    const at80 = await makeCreditGrant(h.db, { personId: p.id, units: 10 });
    await makeEntry(h.db, { grantId: at80.id, kind: "consume", quantity: -8 });
    const at70 = await makeCreditGrant(h.db, { personId: p.id, units: 10 });
    await makeEntry(h.db, { grantId: at70.id, kind: "consume", quantity: -7 });
    const c = (await card("packages_nearing_completion"))!;
    const row = c.rows.find((r) => r.refId === at80.id);
    expect(row).toMatchObject({ personId: p.id, name: "Ann Peeters", refType: "grant", params: { remaining: 2, total: 10 } });
    expect(c.rows.map((r) => r.refId)).not.toContain(at70.id);
    expect(c.count).toBeGreaterThanOrEqual(1);
  });
});

describe("rule 24: vip_inactive", () => {
  it("fires for a high-value customer 61 days inactive, not at 59 days", async () => {
    const fires = await makeCustomer(h.db);
    const recent = await makeCustomer(h.db);
    await h.db.insert(personStats).values({ personId: fires.id, revenueCents: 150_000, purchases: 3, lastActivityAt: ago(61) });
    await h.db.insert(personStats).values({ personId: recent.id, revenueCents: 150_000, purchases: 3, lastActivityAt: ago(59) });
    const ids = await persons("vip_inactive");
    expect(ids).toContain(fires.id);
    expect(ids).not.toContain(recent.id);
    expect((await card("vip_inactive"))!.rows.find((r) => r.personId === fires.id)!.params.days).toBe(61);
  });
});

describe("rule 25: new_leads_follow_up", () => {
  it("fires for a lead created 3 days ago without booking or task; not within 48 hours, not imported, not with a task or booking", async () => {
    const owner = await makeUser(h.db, { roleKey: "sales" });
    const fires = await makeCustomer(h.db, { createdAt: ago(3) });
    const fresh = await makeCustomer(h.db, { createdAt: new Date(Date.now() - 47 * HOUR) });
    const imported = await makeCustomer(h.db, { createdAt: ago(3), acquisition: { source: "import" } });
    const withTask = await makeCustomer(h.db, { createdAt: ago(3) });
    await makeOpenTask(h.db, { ownerUserId: owner.id, personId: withTask.id, dueAt: ahead(2) });
    const booked = await makeCustomer(h.db, { createdAt: ago(3) });
    await makeBookingAt(h.db, { personId: booked.id });
    const ids = await persons("new_leads_follow_up");
    expect(ids).toContain(fires.id);
    for (const p of [fresh, imported, withTask, booked]) expect(ids).not.toContain(p.id);
  });

  it("a customer who bought a package is no lead", async () => {
    const p = await makeCustomer(h.db, { createdAt: ago(3) });
    await makePaidOrder(h.db, { personId: p.id, lines: [{ productKind: "package" }] });
    expect(await persons("new_leads_follow_up")).not.toContain(p.id);
  });

  it("the week view reaches 7 days further back than new_lead_window_days", async () => {
    const p = await makeCustomer(h.db, { createdAt: ago(RETENTION_DEFAULTS.new_lead_window_days + 4) });
    expect(await persons("new_leads_follow_up")).not.toContain(p.id);
    expect(await persons("new_leads_follow_up", "week")).toContain(p.id);
  });
});

describe("rule 27: memberships_expiring", () => {
  it("fires for a cancellation within 14 days, past_due, and a period end within 14 days without a valid mandate", async () => {
    const cancelling = await makeMembership(h.db, { personId: (await makeCustomer(h.db)).id, startedAt: ago(5), currentPeriodStartAt: ago(5), currentPeriodEndAt: ahead(60), cancelAt: ahead(5) });
    const pastDue = await makeMembership(h.db, { personId: (await makeCustomer(h.db)).id, status: "past_due", startedAt: ago(40), currentPeriodStartAt: ago(40), currentPeriodEndAt: ahead(60) });
    const manualRenewal = await makeMembership(h.db, { personId: (await makeCustomer(h.db)).id, startedAt: ago(20), currentPeriodStartAt: ago(20), currentPeriodEndAt: ahead(10) });
    const ids = await refs("memberships_expiring");
    expect(ids).toEqual(expect.arrayContaining([cancelling.id, pastDue.id, manualRenewal.id]));
  });

  it("stays quiet with a valid mandate, a period end beyond the window, or a cancellation beyond it", async () => {
    const p = await makeCustomer(h.db);
    const [mandate] = await h.db.insert(mandates).values({ personId: p.id, provider: "mollie", providerMandateId: `mdt_${p.id}`, providerCustomerId: `cst_${p.id}`, method: "directdebit", status: "valid" }).returning();
    const withMandate = await makeMembership(h.db, { personId: p.id, startedAt: ago(20), currentPeriodStartAt: ago(20), currentPeriodEndAt: ahead(10), mandateId: mandate!.id });
    const later = await makeMembership(h.db, { personId: (await makeCustomer(h.db)).id, startedAt: ago(5), currentPeriodStartAt: ago(5), currentPeriodEndAt: ahead(40) });
    const cancelLater = await makeMembership(h.db, { personId: (await makeCustomer(h.db)).id, startedAt: ago(5), currentPeriodStartAt: ago(5), currentPeriodEndAt: ahead(60), cancelAt: ahead(30), mandateId: mandate!.id });
    const ids = await refs("memberships_expiring");
    for (const m of [withMandate, later, cancelLater]) expect(ids).not.toContain(m.id);
  });

  it("the week view adds 7 days to membership_expiring_days", async () => {
    const m = await makeMembership(h.db, { personId: (await makeCustomer(h.db)).id, startedAt: ago(20), currentPeriodStartAt: ago(20), currentPeriodEndAt: ahead(RETENTION_DEFAULTS.membership_expiring_days + 4) });
    expect(await refs("memberships_expiring")).not.toContain(m.id);
    expect(await refs("memberships_expiring", "week")).toContain(m.id);
  });
});

describe("rule 28: failed_payments", () => {
  it("fires for a failed payment of an unpaid order and an open payment older than 15 minutes", async () => {
    const failedOrder = await makeOrder(h.db, { personId: (await makeCustomer(h.db)).id });
    const failed = await makePayment(h.db, { orderId: failedOrder.id, status: "failed", amountCents: 4_500 });
    const openOrder = await makeOrder(h.db, { personId: (await makeCustomer(h.db)).id });
    const open = await makePayment(h.db, { orderId: openOrder.id, status: "open", createdAt: new Date(Date.now() - 20 * 60_000) });
    const c = (await card("failed_payments"))!;
    expect(c.rows.map((r) => r.refId)).toEqual(expect.arrayContaining([failed.id, open.id]));
    expect(c.rows.find((r) => r.refId === failed.id)!.params).toMatchObject({ amount: 4_500, status: "failed" });
  });

  it("stays quiet when the order was paid later, for a fresh open payment, and for a failure older than 7 days", async () => {
    const { order: paidLater } = await makePaidOrder(h.db, { personId: (await makeCustomer(h.db)).id });
    const retried = await makePayment(h.db, { orderId: paidLater.id, status: "failed" });
    const freshOrder = await makeOrder(h.db, { personId: (await makeCustomer(h.db)).id });
    const fresh = await makePayment(h.db, { orderId: freshOrder.id, status: "open", createdAt: new Date(Date.now() - 5 * 60_000) });
    const oldOrder = await makeOrder(h.db, { personId: (await makeCustomer(h.db)).id });
    const old = await makePayment(h.db, { orderId: oldOrder.id, status: "expired", createdAt: ago(9), updatedAt: ago(8) });
    const ids = await refs("failed_payments");
    for (const p of [retried, fresh, old]) expect(ids).not.toContain(p.id);
  });
});

describe("rule 29: webinar_leads_not_booked (imported registrations)", () => {
  it("fires for a lead of a webinar 3 days ago without a booking since; not with a booking after registering, not for an older webinar", async () => {
    const fires = await makeCustomer(h.db);
    const reg = await makeImportedRegistration(h.db, { personId: fires.id, registeredAt: ago(5), webinarStartsAt: ago(3) });
    const booked = await makeCustomer(h.db);
    await makeImportedRegistration(h.db, { personId: booked.id, registeredAt: ago(5), webinarStartsAt: ago(3) });
    await makeBookingAt(h.db, { personId: booked.id, createdAt: ago(2) });
    const bookedBefore = await makeCustomer(h.db);
    await makeBookingAt(h.db, { personId: bookedBefore.id, createdAt: ago(10) });
    const regBefore = await makeImportedRegistration(h.db, { personId: bookedBefore.id, registeredAt: ago(5), webinarStartsAt: ago(3) });
    const old = await makeCustomer(h.db);
    await makeImportedRegistration(h.db, { personId: old.id, registeredAt: ago(RETENTION_DEFAULTS.webinar_lead_window_days + 6), webinarStartsAt: ago(RETENTION_DEFAULTS.webinar_lead_window_days + 4) });
    const c = (await card("webinar_leads_not_booked"))!;
    expect(c.rows.map((r) => r.refId)).toEqual(expect.arrayContaining([reg.id, regBefore.id]));
    const ids = c.rows.map((r) => r.personId);
    expect(ids).not.toContain(booked.id);
    expect(ids).not.toContain(old.id);
    expect(await persons("webinar_leads_not_booked", "week")).toContain(old.id);
  });

  it("without webinar_starts_at the registration time is the webinar start", async () => {
    const p = await makeCustomer(h.db);
    await makeImportedRegistration(h.db, { personId: p.id, registeredAt: ago(2) });
    expect(await persons("webinar_leads_not_booked")).toContain(p.id);
  });
});

describe("rule 30: unused_packages_expiring", () => {
  it("fires for remaining credits expiring within 30 days, not beyond, not when used up or expired; the week view adds 7 days", async () => {
    const p = await makeCustomer(h.db);
    const soon = await makeCreditGrant(h.db, { personId: p.id, units: 5, expiresAt: ahead(10) });
    const later = await makeCreditGrant(h.db, { personId: p.id, units: 5, expiresAt: ahead(RETENTION_DEFAULTS.expiry_days + 4) });
    const usedUp = await makeCreditGrant(h.db, { personId: p.id, units: 1, expiresAt: ahead(10) });
    await makeEntry(h.db, { grantId: usedUp.id, kind: "consume", quantity: -1 });
    const today = await refs("unused_packages_expiring");
    expect(today).toContain(soon.id);
    expect(today).not.toContain(later.id);
    expect(today).not.toContain(usedUp.id);
    expect(await refs("unused_packages_expiring", "week")).toContain(later.id);
    const row = (await card("unused_packages_expiring"))!.rows.find((r) => r.refId === soon.id)!;
    expect(row.params.remaining).toBe(5);
  });

  it("tester persons never appear", async () => {
    const tester = await makeCustomer(h.db, { isTester: true });
    const g = await makeCreditGrant(h.db, { personId: tester.id, units: 5, expiresAt: ahead(10) });
    expect(await refs("unused_packages_expiring")).not.toContain(g.id);
  });
});

describe("rule 32: overdue_tasks", () => {
  it("shows the user's own overdue open tasks; tasks.all shows everyone's; not yet due stays out", async () => {
    const me = await makeUser(h.db, { roleKey: "reception" });
    const other = await makeUser(h.db, { roleKey: "sales" });
    const mine = await makeOpenTask(h.db, { ownerUserId: me.id, dueAt: ago(1), title: "Call Ann" });
    const theirs = await makeOpenTask(h.db, { ownerUserId: other.id, dueAt: ago(1) });
    const notDue = await makeOpenTask(h.db, { ownerUserId: me.id, dueAt: new Date(Date.now() + HOUR) });
    const own = await refs("overdue_tasks", "today", ctxFor(["reports.read"], me.id));
    expect(own).toContain(mine.id);
    expect(own).not.toContain(theirs.id);
    expect(own).not.toContain(notDue.id);
    const all = await refs("overdue_tasks", "today", ctxFor(["tasks.all"], me.id));
    expect(all).toEqual(expect.arrayContaining([mine.id, theirs.id]));
    expect((await card("overdue_tasks", { ctx: ctxFor(["reports.read"], me.id) }))!.rows.find((r) => r.refId === mine.id)).toMatchObject({ name: "Call Ann", personId: null });
  });

  it("the week view runs to the end of the ISO week", async () => {
    const me = await makeUser(h.db, { roleKey: "reception" });
    const weekEnd = periodRange("week", new Date()).to;
    const dueAt = new Date(weekEnd.getTime() - 60_000);
    if (dueAt.getTime() - Date.now() < 2 * 60_000) return; // the last minutes of a Sunday: nothing left to widen
    const t = await makeOpenTask(h.db, { ownerUserId: me.id, dueAt });
    const later = await makeOpenTask(h.db, { ownerUserId: me.id, dueAt: new Date(weekEnd.getTime() + DAY) });
    const ctx = ctxFor(["reports.read"], me.id);
    expect(await refs("overdue_tasks", "today", ctx)).not.toContain(t.id);
    const week = await refs("overdue_tasks", "week", ctx);
    expect(week).toContain(t.id);
    expect(week).not.toContain(later.id);
  });
});

describe("permissions (ops spec 7)", () => {
  it("the dashboard needs reports.read or tasks.all", async () => {
    await expect(getActionDashboard(ctxFor(["credits.read"]))).rejects.toThrow(/forbidden/);
    await expect(getActionDashboard({ ...ctxFor(), actor: { kind: "customer", userId: "u", personId: "p" } })).rejects.toThrow(/forbidden/);
    expect((await getActionDashboard(ctxFor(["tasks.all"]))).length).toBeGreaterThan(0);
  });

  it("cards are hidden without their own permission", async () => {
    const keys = async (perms: string[]) => (await getActionDashboard(ctxFor(perms))).map((c) => c.key);
    const tasksOnly = await keys(["tasks.all"]);
    for (const k of ["failed_payments", "memberships_expiring", "packages_nearing_completion", "unused_packages_expiring", "overdue_privacy_requests"] as const) expect(tasksOnly).not.toContain(k);
    expect(tasksOnly).toEqual(expect.arrayContaining(["vip_inactive", "new_leads_follow_up", "webinar_leads_not_booked", "overdue_tasks"]));
    const withSell = await keys(["tasks.all", "commerce.sell", "credits.read"]);
    expect(withSell).toEqual(expect.arrayContaining(["failed_payments", "memberships_expiring", "packages_nearing_completion", "unused_packages_expiring"]));
    expect(await keys(["reports.read"])).not.toContain("overdue_privacy_requests");
    expect(await keys(["reports.read", "privacy.run"])).toContain("overdue_privacy_requests");
  });

  it("Create task is offered only with tasks.all and never on the task and privacy cards", async () => {
    const reader = await getActionDashboard(ctxFor(["reports.read"]));
    expect(reader.every((c) => !c.canCreateTask)).toBe(true);
    const all = await getActionDashboard(ctxFor());
    const offered = Object.fromEntries(all.map((c) => [c.key, c.canCreateTask]));
    expect(offered).toMatchObject({ vip_inactive: true, failed_payments: true, overdue_tasks: false, overdue_privacy_requests: false });
  });

  it("shows the first 10 rows unless the card is expanded", async () => {
    for (let i = 0; i < 11; i++) {
      const p = await makeCustomer(h.db);
      await makeImportedRegistration(h.db, { personId: p.id, registeredAt: ago(1) });
    }
    const [c] = (await getActionDashboard(ctxFor())).filter((x) => x.key === "webinar_leads_not_booked");
    expect(c!.rows).toHaveLength(10);
    // From R2 the imported registrations are the card's second figure (webinar's native count is `count`).
    expect(c!.count + (c!.secondary?.count ?? 0)).toBeGreaterThan(10);
  });
});
