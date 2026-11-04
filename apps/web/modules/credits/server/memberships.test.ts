import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle, DbOrTx, Tx } from "@beam/db";
import {
  activityEvents,
  auditLog,
  creditGrants,
  jobs as jobsTable,
  membershipPeriods,
  membershipPlanInclusions,
  memberships,
  orders,
  priceVersions,
  vCreditGrantBalances,
} from "@beam/db/schema";
import { createTestDb, makePerson, makeProduct } from "@beam/db/testing";
import { assertMembershipTransition, brusselsDateKey, brusselsDateOf, nextPeriod, startOfDayIn } from "@beam/core/credits";
import { LOCALES } from "@beam/core/i18n";
import { renderEmail } from "@beam/email/render";
import { TEMPLATE_REGISTRY } from "@beam/email/templates/registry";
import type { TemplateDef } from "@beam/email/templates/define";
import { and, asc, createCtx, eq, flushDurableWrites, type Actor, type Ctx } from "@/lib/ctx";
import type { JobCtx } from "@/lib/job-runner";
import { makeCtx, makeJobCtx, resetRuntime, staffActor } from "@/lib/testing";
import { runChargeRenewal, runScanRenewals } from "../jobs";
import { balanceOf, consumeCredits } from "./ledger";
import {
  activateMembership,
  alertFailedRenewals,
  applyRenewalFailure,
  applyRenewalPayment,
  canStartMembership,
  cancelMembershipForRefund,
  cancelNow,
  chargeRenewal,
  extendPeriod,
  getMembershipForPerson,
  getMembershipSummary,
  importMembership,
  lockMembership,
  requestCancel,
  resume,
  scanMembership,
  shiftDays,
  type MembershipRow,
} from "./memberships";
import { creditsSettings } from "./ledger";

const fx = vi.hoisted(() => ({
  sendTransactional: vi.fn(),
  notifySlack: vi.fn(),
  createTask: vi.fn(),
  getActiveMandate: vi.fn(),
  createRecurringCharge: vi.fn(),
  createRenewalLinkOrder: vi.fn(),
  getPayLinkForOrder: vi.fn(),
  cancelRenewalOrder: vi.fn(),
}));

vi.mock("@/modules/email/api", async (orig) => ({ ...(await orig<typeof import("@/modules/email/api")>()), sendTransactional: fx.sendTransactional }));
vi.mock("@/lib/alerts", async (orig) => ({ ...(await orig<typeof import("@/lib/alerts")>()), notifySlack: fx.notifySlack }));
vi.mock("@/modules/crm/api", async (orig) => ({ ...(await orig<typeof import("@/modules/crm/api")>()), createTask: fx.createTask }));
vi.mock("@/modules/commerce/api", async (orig) => ({
  ...(await orig<typeof import("@/modules/commerce/api")>()),
  getActiveMandate: fx.getActiveMandate,
  createRecurringCharge: fx.createRecurringCharge,
  createRenewalLinkOrder: fx.createRenewalLinkOrder,
  getPayLinkForOrder: fx.getPayLinkForOrder,
  cancelRenewalOrder: fx.cancelRenewalOrder,
}));

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

/** Persons with a valid Mollie mandate (the `getActiveMandate` fake). */
const mandated = new Map<string, string>();
/** One renewal order per membership and period, like commerce. */
const renewalOrders = new Map<string, string>();

async function makeOrder(db: DbOrTx, personId: string, totalCents = 4_900, paidAt: Date | null = null) {
  const [o] = await db
    .insert(orders)
    .values({ personId, channel: "admin", subtotalCents: totalCents, vatCents: 0, totalCents, locale: "nl-BE", clientKey: randomUUID(), paidAt })
    .returning();
  return o!;
}

beforeEach(() => {
  vi.clearAllMocks();
  fx.sendTransactional.mockImplementation(() => Promise.resolve({ emailMessageId: randomUUID(), jobId: randomUUID() }));
  fx.notifySlack.mockImplementation(() => Promise.resolve({ jobId: randomUUID(), inserted: true }));
  fx.createTask.mockImplementation(() => Promise.resolve({ taskId: randomUUID(), created: true }));
  fx.getActiveMandate.mockImplementation((_db: unknown, personId: string) =>
    Promise.resolve(mandated.has(personId) ? { mandateId: mandated.get(personId)!, method: "directdebit", summary: null } : null),
  );
  const reuse = async (tx: DbOrTx, input: { membershipId: string; personId: string; periodEndOn: string }) => {
    const key = `${input.membershipId}:${input.periodEndOn}`;
    if (!renewalOrders.has(key)) renewalOrders.set(key, (await makeOrder(tx, input.personId)).id);
    return renewalOrders.get(key)!;
  };
  fx.createRecurringCharge.mockImplementation(async (tx: DbOrTx, _ctx: unknown, input: { membershipId: string; personId: string; periodEndOn: string }) => ({
    orderId: await reuse(tx, input),
    paymentId: randomUUID(),
  }));
  fx.createRenewalLinkOrder.mockImplementation(async (tx: DbOrTx, _ctx: unknown, input: { membershipId: string; personId: string; periodEndOn: string }) => {
    const orderId = await reuse(tx, input);
    return { orderId, payUrl: `https://beam.example.com/nl-BE/pay/${orderId}` };
  });
  fx.getPayLinkForOrder.mockImplementation((_tx: unknown, _ctx: unknown, input: { orderId: string }) =>
    Promise.resolve({ payUrl: `https://beam.example.com/nl-BE/pay/${input.orderId}`, expiresAt: new Date("2099-01-01T00:00:00Z") }),
  );
  fx.cancelRenewalOrder.mockImplementation(() => Promise.resolve());
});

// Tuesday 10 March 2026, 10:00 Brussels (CET).
const T0 = new Date("2026-03-10T09:00:00.000Z");
const days = (n: number, from = T0) => shiftDays(from, n);
const ctxAt = (now: Date, actor?: Actor) => makeCtx(h.db, actor ? { now, actor } : { now });
const tx = () => h.db as unknown as Tx;

/** Runs `fn` in a real transaction with its own system context (the way commerce and the jobs call the service). */
function inTx<T>(now: Date, fn: (tx: Tx, ctx: Ctx) => Promise<T>): Promise<T> {
  return h.db.transaction((t) => fn(t, createCtx({ tx: t, actor: { kind: "system", jobId: "" }, now, durableMode: "immediate" })));
}

async function makePlan(over: { interval?: "month" | "year"; extraNight?: number; discount?: string } = {}) {
  const product = await makeProduct(h.db, {
    kind: "membership",
    recurringInterval: over.interval ?? "month",
    includedCreditKind: "day",
    includedCreditUnits: 4,
    memberDiscountPct: over.discount ?? "10.00",
    priceCents: over.interval === "year" ? 49_000 : 4_900,
  });
  if (over.extraNight) await h.db.insert(membershipPlanInclusions).values({ productId: product.id, creditKind: "night", unitsPerPeriod: over.extraNight });
  const [pv] = await h.db.select().from(priceVersions).where(eq(priceVersions.productId, product.id));
  return { product, priceVersionId: pv!.id };
}

type Started = { m: MembershipRow; personId: string; plan: Awaited<ReturnType<typeof makePlan>>; orderId: string };

/** A paid membership started at `startsAt` (default T0), optionally with a mandate. */
async function start(
  over: { personId?: string; startsAt?: Date; now?: Date; mandate?: boolean; plan?: Awaited<ReturnType<typeof makePlan>>; interval?: "month" | "year"; extraNight?: number } = {},
): Promise<Started> {
  const personId = over.personId ?? (await makePerson(h.db)).id;
  const plan = over.plan ?? (await makePlan({ interval: over.interval, extraNight: over.extraNight }));
  const order = await makeOrder(h.db, personId, plan.product.recurringInterval === "year" ? 49_000 : 4_900, over.startsAt ?? T0);
  const mandateId = over.mandate ? randomUUID() : null;
  if (mandateId) mandated.set(personId, mandateId);
  const r = await activateMembership(tx(), ctxAt(over.now ?? T0), {
    personId,
    productId: plan.product.id,
    orderId: order.id,
    priceVersionId: plan.priceVersionId,
    mandateId,
    startsAt: over.startsAt ?? T0,
  });
  return { m: await row(r.membershipId), personId, plan, orderId: order.id };
}

const row = async (id: string) => (await h.db.select().from(memberships).where(eq(memberships.id, id)))[0]!;
const periodsOf = (id: string) => h.db.select().from(membershipPeriods).where(eq(membershipPeriods.membershipId, id)).orderBy(asc(membershipPeriods.periodStartAt));
const grantsOf = (id: string) =>
  h.db
    .select({ g: creditGrants, remaining: vCreditGrantBalances.remainingUnits })
    .from(creditGrants)
    .innerJoin(vCreditGrantBalances, eq(vCreditGrantBalances.grantId, creditGrants.id))
    .where(eq(creditGrants.membershipId, id))
    .orderBy(asc(creditGrants.startsAt), asc(creditGrants.creditKind));
const eventsOf = (id: string) =>
  h.db
    .select({ kind: activityEvents.kind, data: activityEvents.data, dedupeKey: activityEvents.dedupeKey })
    .from(activityEvents)
    .where(and(eq(activityEvents.refType, "membership"), eq(activityEvents.refId, id)))
    .orderBy(asc(activityEvents.id));
const jobsByKey = (key: string) => h.db.select().from(jobsTable).where(eq(jobsTable.idempotencyKey, key));
const auditsOf = (id: string) => h.db.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.entityId, id)).orderBy(asc(auditLog.id));
const sends = (membershipId: string) =>
  fx.sendTransactional.mock.calls.map((c) => c[1] as { template: string; key: string; data: Record<string, unknown> }).filter((s) => s.data.membershipId === membershipId);
const endOn = (m: MembershipRow) => brusselsDateKey(m.currentPeriodEndAt);

/** `memberships.scan_renewals` for one membership, in its own transaction. */
const scanOne = async (id: string, now: Date) => inTx(now, async (t, ctx) => scanMembership(t, ctx, id, await creditsSettings(t)));

/** A whole job run in one transaction with a job context at `now`, like the runner. */
async function runJob<T>(kind: "memberships.scan_renewals" | "memberships.charge_renewal", now: Date, run: (ctx: JobCtx) => Promise<T>): Promise<T> {
  let ctx: JobCtx | undefined;
  const out = await h.db.transaction(async (t) => {
    ctx = makeJobCtx(h.db, kind, { tx: t, now });
    return run(ctx);
  });
  if (ctx) await flushDurableWrites(h.db, ctx);
  return out;
}

/** Puts an active membership's period end at `end` (start one month before), for scan tests. */
async function setPeriod(m: MembershipRow, end: Date, patch: Partial<typeof memberships.$inferInsert> = {}): Promise<MembershipRow> {
  const startAt = shiftDays(end, -30);
  const [r] = await h.db
    .update(memberships)
    .set({ currentPeriodStartAt: startAt, currentPeriodEndAt: end, ...patch })
    .where(eq(memberships.id, m.id))
    .returning();
  return r!;
}

// ---------------------------------------------------------------------------
// Start, inclusions, rule 47
// ---------------------------------------------------------------------------

describe("activateMembership (rules 45 to 47)", () => {
  it("(new) -> active: the first payment starts the membership with its period, inclusions (primary + extra), discount snapshot and period row", async () => {
    const { m, orderId, plan } = await start({ extraNight: 1 });
    const period = nextPeriod(T0, "month", 10);
    expect(m).toMatchObject({
      status: "active",
      interval: "month",
      source: "purchase",
      startedAt: T0,
      currentPeriodStartAt: T0,
      currentPeriodEndAt: period.end,
      discountPct: "10.00",
      firstOrderId: orderId,
      priceVersionId: plan.priceVersionId,
      mandateId: null,
      nextChargeAt: null,
      endReason: null,
    });
    expect(brusselsDateKey(m.currentPeriodEndAt)).toBe("2026-04-10");
    expect(await periodsOf(m.id)).toMatchObject([{ source: "purchase", orderId, amountCents: 4_900, periodStartAt: T0, periodEndAt: period.end }]);
    const grants = await grantsOf(m.id);
    expect(grants.map((g) => [g.g.creditKind, g.g.unitsGranted, g.remaining])).toEqual([
      ["day", 4, 4],
      ["night", 1, 1],
    ]);
    for (const { g } of grants) {
      expect(g).toMatchObject({ source: "membership", startsAt: T0, expiresAt: period.end, unitValueCents: 0, vatTreatment: "not_applicable", status: "active" });
      expect(g.sharing).toMatchObject({ mode: "none" });
    }
    expect((await eventsOf(m.id)).map((e) => [e.kind, e.data])).toEqual([["membership.started", { membership_id: m.id, product_id: plan.product.id, status: "active" }]]);
    expect(sends(m.id)).toMatchObject([{ template: "credits.membership_started", key: `credits:membership_started:${m.id}:start`, data: { status: "active" } }]);
  });

  it("a mandate sets the first automatic charge 3 days before the period end", async () => {
    const { m } = await start({ mandate: true });
    expect(m.mandateId).not.toBeNull();
    expect(m.nextChargeAt).toEqual(shiftDays(m.currentPeriodEndAt, -3));
  });

  it("activateMembership twice for one order creates one membership", async () => {
    const { m, personId, plan, orderId } = await start();
    const again = await activateMembership(tx(), ctxAt(T0), { personId, productId: plan.product.id, orderId, priceVersionId: plan.priceVersionId, mandateId: null, startsAt: T0 });
    expect(again).toEqual({ membershipId: m.id, status: "active", created: false });
    expect(await h.db.select().from(memberships).where(eq(memberships.personId, personId))).toHaveLength(1);
    expect(await grantsOf(m.id)).toHaveLength(1);
    expect(await periodsOf(m.id)).toHaveLength(1);
  });

  it("a second active plan is refused; a plan change (cancel_at + pending on that date) is allowed and swaps on the scan", async () => {
    const first = await start();
    const other = await makePlan();
    const order2 = await makeOrder(h.db, first.personId);
    expect(await canStartMembership(h.db, first.personId)).toEqual({ ok: false, reason: "already_member" });
    await expect(
      activateMembership(tx(), ctxAt(T0), { personId: first.personId, productId: other.product.id, orderId: order2.id, priceVersionId: other.priceVersionId, mandateId: null, startsAt: T0 }),
    ).rejects.toMatchObject({ code: "conflict", message: "already_member" });

    await requestCancel(tx(), ctxAt(days(2)), { membershipId: first.m.id, by: "customer" });
    const cancelAt = (await row(first.m.id)).cancelAt!;
    const startsOn = brusselsDateKey(cancelAt);
    expect(await canStartMembership(h.db, first.personId, { startsOn })).toEqual({ ok: true });
    expect(await canStartMembership(h.db, first.personId, { startsOn: "2026-03-20" })).toEqual({ ok: false, reason: "already_member" });
    const newStart = startOfDayIn(brusselsDateOf(cancelAt));
    const next = await activateMembership(tx(), ctxAt(days(2)), {
      personId: first.personId,
      productId: other.product.id,
      orderId: order2.id,
      priceVersionId: other.priceVersionId,
      mandateId: null,
      startsAt: newStart,
    });
    expect(next).toMatchObject({ status: "pending", created: true });
    expect(await canStartMembership(h.db, first.personId, { startsOn })).toEqual({ ok: false, reason: "pending_exists" });

    // The scan on the change day (06:10 Brussels) ends the old plan and starts the new one.
    const scanAt = new Date(newStart.getTime() + (6 * 60 + 10) * 60_000);
    expect(await scanOne(next.membershipId, scanAt)).toEqual(["activated"]);
    expect(await row(first.m.id)).toMatchObject({ status: "cancelled", endReason: "cancelled_by_customer" });
    expect(await row(next.membershipId)).toMatchObject({ status: "active" });
    expect(await grantsOf(next.membershipId)).toHaveLength(1);
  });

  it("(new) -> pending with a future start, then pending -> active by the scan on the start date", async () => {
    const startsAt = startOfDayIn(brusselsDateOf(days(5)));
    const { m } = await start({ startsAt });
    expect(m.status).toBe("pending");
    expect(await grantsOf(m.id)).toEqual([]);
    expect(sends(m.id)).toMatchObject([{ template: "credits.membership_started", data: { status: "pending" } }]);
    expect(await getMembershipForPerson(h.db, m.personId)).toMatchObject({ isMember: false });
    expect(await scanOne(m.id, days(4))).toEqual([]);
    expect((await row(m.id)).status).toBe("pending");
    expect(await scanOne(m.id, new Date(startsAt.getTime() + 6 * 3_600_000))).toEqual(["activated"]);
    expect(await row(m.id)).toMatchObject({ status: "active", currentPeriodStartAt: startsAt });
    const grants = await grantsOf(m.id);
    expect(grants.map((g) => g.g.startsAt)).toEqual([startsAt]);
    expect((await eventsOf(m.id)).map((e) => (e.data as { status: string }).status)).toEqual(["pending", "active"]);
  });

  it("refuses a product that is not a membership plan", async () => {
    const personId = (await makePerson(h.db)).id;
    const pkg = await makeProduct(h.db, { kind: "package" });
    const order = await makeOrder(h.db, personId);
    await expect(
      activateMembership(tx(), ctxAt(T0), { personId, productId: pkg.id, orderId: order.id, priceVersionId: randomUUID(), mandateId: null, startsAt: T0 }),
    ).rejects.toMatchObject({ code: "validation" });
  });
});

// ---------------------------------------------------------------------------
// Renewal by mandate, payment and dunning (rules 48 to 51)
// ---------------------------------------------------------------------------

/** A mandate membership whose charge has been created (`renewal_order_id` set) for the current period. */
async function charged(): Promise<Started & { renewalOrderId: string }> {
  const s = await start({ mandate: true });
  const r = await inTx(days(28), (t, ctx) => chargeRenewal(t, ctx, { membershipId: s.m.id, periodEndOn: endOn(s.m), attempt: 1 }));
  expect(r.charged).toBe(true);
  const m = await row(s.m.id);
  return { ...s, m, renewalOrderId: m.renewalOrderId! };
}

describe("renewal by mandate (rules 48, 49)", () => {
  it("the scan at T-3 enqueues one charge with key renewal:<id>:<period_end>; before T-3 none", async () => {
    const { m } = await start({ mandate: true });
    expect(await scanOne(m.id, days(-4, m.currentPeriodEndAt))).toEqual([]);
    expect(await scanOne(m.id, days(-3, m.currentPeriodEndAt))).toEqual(["charge"]);
    expect(await scanOne(m.id, days(-3, m.currentPeriodEndAt))).toEqual(["charge"]);
    const queued = await jobsByKey(`renewal:${m.id}:${endOn(m)}`);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ kind: "memberships.charge_renewal", payload: { membershipId: m.id, periodEndOn: endOn(m), attempt: 1 } });
  });

  it("memberships.charge_renewal calls createRecurringCharge once and stores renewal_order_id; a second run charges nothing", async () => {
    const { m, renewalOrderId } = await charged();
    expect(fx.createRecurringCharge).toHaveBeenCalledTimes(1);
    expect(fx.createRecurringCharge.mock.calls[0]![2]).toEqual({ membershipId: m.id, personId: m.personId, productId: m.productId, mandateId: m.mandateId, periodEndOn: endOn(m) });
    expect(renewalOrderId).toBeTruthy();
    expect(m.nextChargeAt).toBeNull();
    const again = await runJob("memberships.charge_renewal", days(28), (ctx) => runChargeRenewal(ctx, { membershipId: m.id, periodEndOn: endOn(m), attempt: 1 }));
    expect(again).toMatchObject({ charged: false, reason: "already_charged" });
    expect(fx.createRecurringCharge).toHaveBeenCalledTimes(1);
  });

  it("a mandate revoked before the charge moves the membership to the link path (edge case 10)", async () => {
    const { m, personId } = await start({ mandate: true });
    mandated.delete(personId);
    const r = await inTx(days(28), (t, ctx) => chargeRenewal(t, ctx, { membershipId: m.id, periodEndOn: endOn(m), attempt: 1 }));
    expect(r).toMatchObject({ charged: false, reason: "no_mandate" });
    expect(await row(m.id)).toMatchObject({ mandateId: null, nextChargeAt: null });
    expect(await scanOne(m.id, days(28))).toContain("link_order");
  });

  it("a paid renewal moves the period continuously and grants the inclusions once (applyRenewalPayment twice)", async () => {
    const { m, renewalOrderId } = await charged();
    const oldEnd = m.currentPeriodEndAt;
    const first = await applyRenewalPayment(tx(), ctxAt(days(28)), { membershipId: m.id, orderId: renewalOrderId });
    const second = await applyRenewalPayment(tx(), ctxAt(days(28)), { membershipId: m.id, orderId: renewalOrderId });
    expect(first).toMatchObject({ periodStartAt: oldEnd, applied: true });
    expect(brusselsDateKey(first.periodEndAt)).toBe("2026-05-10");
    expect(second).toMatchObject({ applied: false });
    const after = await row(m.id);
    expect(after).toMatchObject({ status: "active", currentPeriodStartAt: oldEnd, renewalOrderId: null, dunningAttempt: 0, pastDueSinceAt: null });
    expect(after.nextChargeAt).toEqual(shiftDays(after.currentPeriodEndAt, -3));
    expect((await periodsOf(m.id)).map((p) => p.source)).toEqual(["purchase", "renewal"]);
    expect((await grantsOf(m.id)).map((g) => g.g.startsAt)).toEqual([T0, oldEnd]);
    expect((await eventsOf(m.id)).filter((e) => e.kind === "membership.renewed")).toHaveLength(1);
    expect(sends(m.id).filter((s) => s.template === "credits.membership_renewed")).toHaveLength(1);
  });

  it("month-end anchors: started 31 January renews 28 February, then 31 March (edge case 13)", async () => {
    const jan31 = new Date("2026-01-31T09:00:00.000Z");
    const s = await start({ mandate: true, startsAt: jan31, now: jan31 });
    expect(brusselsDateKey(s.m.currentPeriodEndAt)).toBe("2026-02-28");
    for (const expected of ["2026-03-31", "2026-04-30"]) {
      const m = await row(s.m.id);
      const at = days(-3, m.currentPeriodEndAt);
      await inTx(at, (t, ctx) => chargeRenewal(t, ctx, { membershipId: m.id, periodEndOn: endOn(m), attempt: 1 }));
      const order = (await row(m.id)).renewalOrderId!;
      const r = await applyRenewalPayment(tx(), ctxAt(at), { membershipId: m.id, orderId: order });
      expect(brusselsDateKey(r.periodEndAt)).toBe(expected);
    }
  });

  it("an order that is not the open renewal order is not applied", async () => {
    const { m } = await charged();
    const stray = await makeOrder(h.db, m.personId);
    expect(await applyRenewalPayment(tx(), ctxAt(days(28)), { membershipId: m.id, orderId: stray.id })).toMatchObject({ applied: false });
  });
});

describe("dunning on the mandate path (rule 50)", () => {
  it("active -> past_due: the first failure sets dunning 1, past_due_since_at and sends the pay link; a repeat for the same payment changes nothing", async () => {
    const { m, renewalOrderId } = await charged();
    const failAt = days(28);
    const r = await applyRenewalFailure(tx(), ctxAt(failAt), { membershipId: m.id, paymentId: "tr_fail_1", reason: "insufficient_funds" });
    expect(r).toEqual({ status: "past_due", dunningAttempt: 1, applied: true });
    const after = await row(m.id);
    expect(after).toMatchObject({ status: "past_due", dunningAttempt: 1, pastDueSinceAt: failAt, renewalOrderId });
    expect(after.nextChargeAt).toEqual(days(3, failAt));
    expect(sends(m.id).filter((s) => s.template === "credits.membership_payment_failed")).toMatchObject([
      { key: `credits:membership_payment_failed:${m.id}:${endOn(m)}:1`, data: { attempt: 1, payUrl: `https://beam.example.com/nl-BE/pay/${renewalOrderId}` } },
    ]);
    expect(await applyRenewalFailure(tx(), ctxAt(failAt), { membershipId: m.id, paymentId: "tr_fail_1", reason: "insufficient_funds" })).toMatchObject({ applied: false, dunningAttempt: 1 });
    expect((await eventsOf(m.id)).filter((e) => e.kind === "membership.past_due")).toHaveLength(1);
    // A past_due member keeps member status and pricing (rule 51).
    expect(await getMembershipForPerson(h.db, m.personId)).toMatchObject({ isMember: true, status: "past_due", discountPct: 10 });
  });

  it("past_due -> active: applyRenewalPayment after a failure clears dunning", async () => {
    const { m, renewalOrderId } = await charged();
    await applyRenewalFailure(tx(), ctxAt(days(28)), { membershipId: m.id, paymentId: "tr_a", reason: "failed" });
    const r = await applyRenewalPayment(tx(), ctxAt(days(31)), { membershipId: m.id, orderId: renewalOrderId });
    expect(r.applied).toBe(true);
    expect(await row(m.id)).toMatchObject({ status: "active", dunningAttempt: 0, pastDueSinceAt: null, renewalOrderId: null });
  });

  it("retries at +3 and +7 days, then past_due -> expired on day 10 with the order cancelled and end_reason payment_failed", async () => {
    const { m, renewalOrderId } = await charged();
    const failAt = days(28);
    await applyRenewalFailure(tx(), ctxAt(failAt), { membershipId: m.id, paymentId: "tr_1", reason: "failed" });
    expect(await scanOne(m.id, days(2, failAt))).toEqual([]);
    expect(await scanOne(m.id, days(3, failAt))).toEqual(["retry:2"]);
    expect(await jobsByKey(`renewal:${m.id}:${endOn(m)}:attempt:2`)).toHaveLength(1);
    const r2 = await inTx(days(3, failAt), (t, ctx) => chargeRenewal(t, ctx, { membershipId: m.id, periodEndOn: endOn(m), attempt: 2 }));
    expect(r2).toMatchObject({ charged: true, orderId: renewalOrderId });
    expect(await inTx(days(3, failAt), (t, ctx) => chargeRenewal(t, ctx, { membershipId: m.id, periodEndOn: endOn(m), attempt: 2 }))).toMatchObject({ charged: false });
    await applyRenewalFailure(tx(), ctxAt(days(3, failAt)), { membershipId: m.id, paymentId: "tr_2", reason: "failed" });
    expect(await row(m.id)).toMatchObject({ dunningAttempt: 2 });
    expect(await scanOne(m.id, days(7, failAt))).toEqual(["retry:3"]);
    await inTx(days(7, failAt), (t, ctx) => chargeRenewal(t, ctx, { membershipId: m.id, periodEndOn: endOn(m), attempt: 3 }));
    await applyRenewalFailure(tx(), ctxAt(days(7, failAt)), { membershipId: m.id, paymentId: "tr_3", reason: "failed" });
    expect(await row(m.id)).toMatchObject({ dunningAttempt: 3, nextChargeAt: null });
    expect((await eventsOf(m.id)).filter((e) => e.kind === "membership.payment_retry_failed").map((e) => (e.data as { attempt: number }).attempt)).toEqual([2, 3]);
    expect(await scanOne(m.id, days(9, failAt))).toEqual([]);
    expect(await scanOne(m.id, days(10, failAt))).toEqual(["expired"]);
    const ended = await row(m.id);
    expect(ended).toMatchObject({ status: "expired", endReason: "payment_failed", endedAt: days(10, failAt) });
    expect(fx.cancelRenewalOrder).toHaveBeenCalledWith(expect.anything(), expect.anything(), { orderId: renewalOrderId, reason: "membership_expired" });
    expect(sends(m.id).map((s) => s.template)).toContain("credits.membership_expired");
    expect((await auditsOf(m.id)).map((a) => a.action)).toContain("memberships.ended");
    expect(await getMembershipForPerson(h.db, m.personId)).toMatchObject({ isMember: false, status: null });
  });

  it("the third failed renewal of the Brussels day calls notifySlack once with renewals_failed:<date>; the fourth does not", async () => {
    const day = new Date("2031-06-02T08:00:00.000Z");
    const all = [await charged(), await charged(), await charged(), await charged()];
    for (const [i, s] of all.entries()) {
      await applyRenewalFailure(tx(), ctxAt(new Date(day.getTime() + i * 60_000)), { membershipId: s.m.id, paymentId: `tr_slack_${i}`, reason: "failed" });
      expect(fx.notifySlack).toHaveBeenCalledTimes(i >= 2 ? 1 : 0);
    }
    expect(fx.notifySlack.mock.calls[0]![1]).toMatchObject({ fingerprint: "renewals_failed:2031-06-02", severity: "high" });
    expect(String(fx.notifySlack.mock.calls[0]![1].text)).toContain("/admin/memberships?status=past_due");
    expect(await alertFailedRenewals(tx(), ctxAt(day))).toMatchObject({ count: 4, alerted: false });
  });

  it("late payment of the cancelled renewal order reactivates an expired membership (edge case 9)", async () => {
    const { m, renewalOrderId } = await charged();
    const failAt = days(28);
    await applyRenewalFailure(tx(), ctxAt(failAt), { membershipId: m.id, paymentId: "tr_late", reason: "failed" });
    await scanOne(m.id, days(10, failAt));
    expect((await row(m.id)).status).toBe("expired");
    const paidAt = days(12, failAt);
    await h.db.update(orders).set({ paidAt }).where(eq(orders.id, renewalOrderId));
    const r = await applyRenewalPayment(tx(), ctxAt(paidAt), { membershipId: m.id, orderId: renewalOrderId });
    expect(r).toMatchObject({ periodStartAt: paidAt, applied: true });
    expect(await row(m.id)).toMatchObject({ status: "active", endReason: null, endedAt: null, currentPeriodStartAt: paidAt, dunningAttempt: 0 });
    expect((await periodsOf(m.id)).map((p) => p.source)).toEqual(["purchase", "late_payment"]);
    expect((await eventsOf(m.id)).filter((e) => e.kind === "membership.renewed").map((e) => e.data)).toEqual([{ membership_id: m.id, late: true }]);
    expect(fx.createTask).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ source: "system", kind: "review", ref: { type: "membership", id: m.id } }));
    expect(await grantsOf(m.id)).toHaveLength(2);
  });

  it("a late payment is not applied when the person already re-joined with a new membership", async () => {
    const { m, renewalOrderId, personId } = await charged();
    await applyRenewalFailure(tx(), ctxAt(days(28)), { membershipId: m.id, paymentId: "tr_rejoin", reason: "failed" });
    await scanOne(m.id, days(38));
    expect((await row(m.id)).status).toBe("expired");
    await start({ personId, startsAt: days(40), now: days(40) });
    const r = await applyRenewalPayment(tx(), ctxAt(days(41)), { membershipId: m.id, orderId: renewalOrderId });
    expect(r.applied).toBe(false);
    expect((await row(m.id)).status).toBe("expired");
    expect(fx.createTask).not.toHaveBeenCalled();
  });

  it("a failure reported after the renewal was paid is ignored (edge case 8)", async () => {
    const { m, renewalOrderId } = await charged();
    await applyRenewalPayment(tx(), ctxAt(days(28)), { membershipId: m.id, orderId: renewalOrderId });
    expect(await applyRenewalFailure(tx(), ctxAt(days(28)), { membershipId: m.id, paymentId: "tr_after", reason: "failed" })).toMatchObject({ applied: false });
    expect((await row(m.id)).status).toBe("active");
  });
});
