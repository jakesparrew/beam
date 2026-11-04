import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle, DbOrTx, Tx } from "@beam/db";
import {
  activityEvents,
  auditLog,
  creditGrants,
  jobs as jobsTable,
  mandates,
  membershipPeriods,
  membershipPlanInclusions,
  memberships,
  orders,
  priceVersions,
  vCreditGrantBalances,
} from "@beam/db/schema";
import { createTestDb, makePerson, makeProduct, makeUser } from "@beam/db/testing";
import { assertMembershipTransition, brusselsDateKey, brusselsDateOf, nextPeriod, startOfDayIn } from "@beam/core/credits";
import { LOCALES } from "@beam/core/i18n";
import { renderEmail } from "@beam/email/render";
import { TEMPLATE_REGISTRY } from "@beam/email/templates/registry";
import type { TemplateDef } from "@beam/email/templates/define";
import { and, asc, createCtx, eq, flushDurableWrites, sql, type Actor, type Ctx } from "@/lib/ctx";
import type * as Alerts from "@/lib/alerts";
import type { JobCtx } from "@/lib/job-runner";
import type * as CommerceApi from "@/modules/commerce/api";
import type * as CrmApi from "@/modules/crm/api";
import type * as EmailApi from "@/modules/email/api";
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

vi.mock("@/modules/email/api", async (orig) => ({ ...(await orig<typeof EmailApi>()), sendTransactional: fx.sendTransactional }));
vi.mock("@/lib/alerts", async (orig) => ({ ...(await orig<typeof Alerts>()), notifySlack: fx.notifySlack }));
vi.mock("@/modules/crm/api", async (orig) => ({ ...(await orig<typeof CrmApi>()), createTask: fx.createTask }));
vi.mock("@/modules/commerce/api", async (orig) => ({
  ...(await orig<typeof CommerceApi>()),
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

const MEMBERSHIP_TEMPLATES = [
  "membership_started",
  "membership_renewal_reminder",
  "membership_renewed",
  "membership_payment_failed",
  "membership_expired",
  "membership_cancel_confirmed",
] as const;

/** Every send of every test: `sendTransactional(ctx, { template, personId, locale, data, key })` with a section 8 key. */
afterEach(() => {
  for (const [ctx, input] of fx.sendTransactional.mock.calls as [Ctx, { template: string; personId: string; locale: string; data: Record<string, unknown>; key: string }][]) {
    expect(ctx.tx).toBeDefined();
    const name = input.template.replace(/^credits\./, "");
    expect(MEMBERSHIP_TEMPLATES as readonly string[]).toContain(name);
    expect(input.template).toBe(`credits.${name}`);
    expect(input.key.startsWith(`credits:${name}:${String(input.data.membershipId)}:`)).toBe(true);
    expect(LOCALES as readonly string[]).toContain(input.locale);
    expect(input.personId).toMatch(/^[0-9a-f-]{36}$/);
    const tpl = (TEMPLATE_REGISTRY as unknown as Record<string, TemplateDef>)[input.template]!;
    expect(tpl.props.safeParse(input.data).success, input.template).toBe(true);
  }
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

/** A valid Mollie mandate row (memberships.mandate_id references mandates.id). */
async function makeMandate(personId: string): Promise<string> {
  const [m] = await h.db
    .insert(mandates)
    .values({
      personId,
      provider: "mollie",
      providerMandateId: `mdt_${randomUUID()}`,
      providerCustomerId: `cst_${randomUUID()}`,
      method: "directdebit",
      status: "valid",
    })
    .returning({ id: mandates.id });
  return m!.id;
}

type Started = { m: MembershipRow; personId: string; plan: Awaited<ReturnType<typeof makePlan>>; orderId: string };

/** A paid membership started at `startsAt` (default T0), optionally with a mandate. */
async function start(
  over: { personId?: string; startsAt?: Date; now?: Date; mandate?: boolean; plan?: Awaited<ReturnType<typeof makePlan>>; interval?: "month" | "year"; extraNight?: number } = {},
): Promise<Started> {
  const personId = over.personId ?? (await makePerson(h.db)).id;
  const plan = over.plan ?? (await makePlan({ interval: over.interval, extraNight: over.extraNight }));
  const order = await makeOrder(h.db, personId, plan.product.recurringInterval === "year" ? 49_000 : 4_900, over.startsAt ?? T0);
  const mandateId = over.mandate ? await makeMandate(personId) : null;
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
const chargeJobsOf = (membershipId: string) =>
  h.db
    .select()
    .from(jobsTable)
    .where(and(eq(jobsTable.kind, "memberships.charge_renewal"), sql`${jobsTable.payload}->>'membershipId' = ${membershipId}`))
    .orderBy(asc(jobsTable.createdAt), asc(jobsTable.id));
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
  it("the scan at T-3 enqueues one charge with key renewal:<id>:<period_end>:v<version>; before T-3 none", async () => {
    const { m } = await start({ mandate: true });
    expect(await scanOne(m.id, days(-4, m.currentPeriodEndAt))).toEqual([]);
    expect(await scanOne(m.id, days(-3, m.currentPeriodEndAt))).toEqual(["charge"]);
    expect(await scanOne(m.id, days(-3, m.currentPeriodEndAt))).toEqual(["charge"]);
    const queued = await jobsByKey(`renewal:${m.id}:${endOn(m)}:v${m.version}`);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ kind: "memberships.charge_renewal", payload: { membershipId: m.id, periodEndOn: endOn(m), attempt: 1 } });
    expect(await chargeJobsOf(m.id)).toHaveLength(1);
  });

  it("fix-w09-credits-review 1: cancel at period end then resume after the T-3 charge enqueues a new charge that creates a new renewal order", async () => {
    const { m } = await start({ mandate: true });
    const end = m.currentPeriodEndAt;
    expect(await scanOne(m.id, days(-3, end))).toEqual(["charge"]);
    const [job1] = await chargeJobsOf(m.id);
    const p1 = job1!.payload as { membershipId: string; periodEndOn: string; attempt: 1 };
    expect(await runJob("memberships.charge_renewal", days(-3, end), (ctx) => runChargeRenewal(ctx, p1))).toMatchObject({ charged: true });
    const firstOrderId = (await row(m.id)).renewalOrderId!;
    expect(firstOrderId).toBeTruthy();

    await requestCancel(tx(), ctxAt(days(-2, end)), { membershipId: m.id, by: "customer" });
    expect(fx.cancelRenewalOrder).toHaveBeenCalledWith(expect.anything(), expect.anything(), { orderId: firstOrderId, reason: "membership_cancelled" });
    renewalOrders.delete(`${m.id}:${endOn(m)}`); // commerce cancelled the order: the next charge opens a new one
    expect(await row(m.id)).toMatchObject({ renewalOrderId: null });
    await resume(tx(), ctxAt(days(-2, end)), { membershipId: m.id });

    expect(await scanOne(m.id, days(-1, end))).toEqual(["charge"]);
    const queued = await chargeJobsOf(m.id);
    expect(queued).toHaveLength(2);
    const job2 = queued.find((j) => j.id !== job1!.id)!;
    expect(job2).toMatchObject({ status: "pending", payload: { membershipId: m.id, periodEndOn: endOn(m), attempt: 1 } });
    const r = await runJob("memberships.charge_renewal", days(-1, end), (ctx) => runChargeRenewal(ctx, job2.payload as typeof p1));
    expect(r).toMatchObject({ charged: true });
    const after = await row(m.id);
    expect(after.renewalOrderId).toBeTruthy();
    expect(after.renewalOrderId).not.toBe(firstOrderId);
    const [o] = await h.db.select({ status: orders.status }).from(orders).where(eq(orders.id, after.renewalOrderId!));
    expect(o!.status).toBe("pending_payment");
    // A further scan the same day changes nothing (the open order blocks attempt 1).
    expect(await scanOne(m.id, days(-1, end))).toEqual([]);
    expect(await chargeJobsOf(m.id)).toHaveLength(2);
  });

  it("fix-w09-credits-review 1: a no_mandate charge run does not block the charge once the person adds a new mandate", async () => {
    const { m, personId } = await start({ mandate: true });
    const end = m.currentPeriodEndAt;
    expect(await scanOne(m.id, days(-3, end))).toEqual(["charge"]);
    const [job1] = await chargeJobsOf(m.id);
    const p1 = job1!.payload as { membershipId: string; periodEndOn: string; attempt: 1 };
    const mandateId = mandated.get(personId)!;
    mandated.delete(personId);
    expect(await runJob("memberships.charge_renewal", days(-3, end), (ctx) => runChargeRenewal(ctx, p1))).toMatchObject({ charged: false, reason: "no_mandate" });
    mandated.set(personId, mandateId);
    expect(await scanOne(m.id, days(-2, end))).toEqual(["charge"]);
    const job2 = (await chargeJobsOf(m.id)).find((j) => j.id !== job1!.id);
    expect(job2).toBeDefined();
    expect(await runJob("memberships.charge_renewal", days(-2, end), (ctx) => runChargeRenewal(ctx, job2!.payload as typeof p1))).toMatchObject({ charged: true });
    expect((await row(m.id)).renewalOrderId).toBeTruthy();
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
    expect(String((fx.notifySlack.mock.calls[0]![1] as { text: string }).text)).toContain("/admin/memberships?status=past_due");
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

// ---------------------------------------------------------------------------
// Renewal without a mandate (rule 52) and reminders (rule 56)
// ---------------------------------------------------------------------------

describe("renewal by payment link (rule 52)", () => {
  it("order at T-7 with the reminder, second reminder at T-3, past_due at period end, link reminders +3/+7, expired not_renewed at +10", async () => {
    const { m } = await start();
    const end = m.currentPeriodEndAt;
    expect(await scanOne(m.id, days(-8, end))).toEqual([]);
    expect(await scanOne(m.id, days(-7, end))).toEqual(["link_order", "reminder:7"]);
    const orderId = (await row(m.id)).renewalOrderId!;
    expect(fx.createRenewalLinkOrder).toHaveBeenCalledTimes(1);
    expect(fx.createRenewalLinkOrder.mock.calls[0]![2]).toEqual({ membershipId: m.id, personId: m.personId, productId: m.productId, periodEndOn: endOn(m) });
    expect(await scanOne(m.id, days(-7, end))).toEqual([]);
    expect(await scanOne(m.id, days(-3, end))).toEqual(["reminder:3"]);
    const reminders = sends(m.id).filter((s) => s.template === "credits.membership_renewal_reminder");
    expect(reminders).toMatchObject([
      { key: `credits:membership_renewal_reminder:${m.id}:${endOn(m)}:7`, data: { variant: "renews", days: 7, payUrl: `https://beam.example.com/nl-BE/pay/${orderId}`, amountCents: 4_900 } },
      { key: `credits:membership_renewal_reminder:${m.id}:${endOn(m)}:3`, data: { variant: "renews", days: 3 } },
    ]);
    expect(await scanOne(m.id, days(-1, end))).toEqual([]);
    expect(await scanOne(m.id, new Date(end.getTime() + 60_000))).toEqual(["past_due"]);
    expect(await row(m.id)).toMatchObject({ status: "past_due", dunningAttempt: 1, pastDueSinceAt: end });
    expect((await eventsOf(m.id)).find((e) => e.kind === "membership.past_due")?.data).toMatchObject({ via: "link", dunning_attempt: 1 });
    expect(await scanOne(m.id, days(3, end))).toEqual(["link_reminder:2"]);
    expect(await scanOne(m.id, days(3, end))).toEqual([]);
    expect(await scanOne(m.id, days(7, end))).toEqual(["link_reminder:3"]);
    expect(sends(m.id).filter((s) => s.template === "credits.membership_payment_failed").map((s) => s.data.attempt)).toEqual([1, 2, 3]);
    expect(await scanOne(m.id, days(10, end))).toEqual(["expired"]);
    expect(await row(m.id)).toMatchObject({ status: "expired", endReason: "not_renewed" });
    expect(fx.cancelRenewalOrder).toHaveBeenCalledWith(expect.anything(), expect.anything(), { orderId, reason: "membership_expired" });
  });

  it("a payment at the desk on the link order renews like any renewal", async () => {
    const { m } = await start();
    await scanOne(m.id, days(-7, m.currentPeriodEndAt));
    const orderId = (await row(m.id)).renewalOrderId!;
    expect((await applyRenewalPayment(tx(), ctxAt(days(-5, m.currentPeriodEndAt)), { membershipId: m.id, orderId })).applied).toBe(true);
    expect(await row(m.id)).toMatchObject({ status: "active", renewalOrderId: null, currentPeriodStartAt: m.currentPeriodEndAt });
  });
});

describe("renewal reminders (rule 56)", () => {
  it("yearly plans get membership.renewal_due at 30 and 7 days, once each, with the renewal amount", async () => {
    const { m } = await start({ mandate: true, interval: "year" });
    const end = m.currentPeriodEndAt;
    expect(await scanOne(m.id, days(-31, end))).toEqual([]);
    expect(await scanOne(m.id, days(-30, end))).toEqual(["reminder:30"]);
    expect(await scanOne(m.id, days(-29, end))).toEqual([]);
    expect(await scanOne(m.id, days(-7, end))).toEqual(["reminder:7"]);
    const due = (await eventsOf(m.id)).filter((e) => e.kind === "membership.renewal_due");
    expect(due.map((e) => e.data)).toEqual([
      { membership_id: m.id, days: 30, period_end_on: endOn(m), is_ending: false, amount_cents: 49_000 },
      { membership_id: m.id, days: 7, period_end_on: endOn(m), is_ending: false, amount_cents: 49_000 },
    ]);
    expect(due.map((e) => e.dedupeKey)).toEqual([`membership:${m.id}:renewal_due:30:${endOn(m)}`, `membership:${m.id}:renewal_due:7:${endOn(m)}`]);
  });

  it("monthly plans with a mandate get no reminder; with cancel_at set they get the 7-day 'ends' reminder", async () => {
    const { m } = await start({ mandate: true });
    expect(await scanOne(m.id, days(-7, m.currentPeriodEndAt))).toEqual([]);
    await requestCancel(tx(), ctxAt(days(1)), { membershipId: m.id, by: "customer" });
    expect(await scanOne(m.id, days(-7, m.currentPeriodEndAt))).toEqual(["reminder:7"]);
    expect(sends(m.id).find((s) => s.template === "credits.membership_renewal_reminder")).toMatchObject({ data: { variant: "ends", days: 7 } });
    expect((await eventsOf(m.id)).find((e) => e.kind === "membership.renewal_due")?.data).toMatchObject({ is_ending: true });
  });
});

// ---------------------------------------------------------------------------
// Cancel, resume, refund, extension (rules 27a, 53 to 55)
// ---------------------------------------------------------------------------

describe("cancellation (rules 53, 54)", () => {
  it("cancel at period end cancels the open renewal order; active -> cancelled by the scan at cancel_at", async () => {
    const { m, renewalOrderId } = await charged();
    const r = await requestCancel(tx(), ctxAt(days(28)), { membershipId: m.id, by: "customer", version: m.version });
    expect(r.mode).toBe("period_end");
    expect(fx.cancelRenewalOrder).toHaveBeenCalledWith(expect.anything(), expect.anything(), { orderId: renewalOrderId, reason: "membership_cancelled" });
    const after = await row(m.id);
    expect(after).toMatchObject({ status: "active", cancelAt: m.currentPeriodEndAt, cancelRequestedAt: days(28), renewalOrderId: null, nextChargeAt: null, version: m.version + 1 });
    expect(sends(m.id).filter((s) => s.template === "credits.membership_cancel_confirmed")).toMatchObject([{ data: { immediate: false, endsOn: endOn(m) } }]);
    expect((await auditsOf(m.id)).map((a) => a.action)).toContain("memberships.cancel_requested");
    expect(await scanOne(m.id, days(-1, m.currentPeriodEndAt))).toEqual([]);
    expect(await scanOne(m.id, m.currentPeriodEndAt)).toEqual(["cancelled"]);
    expect(await row(m.id)).toMatchObject({ status: "cancelled", endReason: "cancelled_by_customer", endedAt: m.currentPeriodEndAt });
    expect((await auditsOf(m.id)).map((a) => a.action)).toContain("memberships.ended");
  });

  it("a stale version is refused (conflict)", async () => {
    const { m } = await start();
    await expect(requestCancel(tx(), ctxAt(T0), { membershipId: m.id, by: "customer", version: m.version + 5 })).rejects.toMatchObject({ code: "conflict", message: "stale_version" });
  });

  it("staff cancel at period end ends with cancelled_by_staff", async () => {
    const { m } = await start();
    await requestCancel(tx(), ctxAt(days(3), staffActor({ permissions: ["memberships.write"] })), { membershipId: m.id, by: "staff", reason: "moving abroad" });
    expect(await scanOne(m.id, m.currentPeriodEndAt)).toEqual(["cancelled"]);
    expect(await row(m.id)).toMatchObject({ status: "cancelled", endReason: "cancelled_by_staff" });
  });

  it("past_due -> cancelled: a customer cancel while past_due is immediate and cancels the renewal order", async () => {
    const { m, renewalOrderId } = await charged();
    await applyRenewalFailure(tx(), ctxAt(days(28)), { membershipId: m.id, paymentId: "tr_pd", reason: "failed" });
    const r = await requestCancel(tx(), ctxAt(days(29)), { membershipId: m.id, by: "customer" });
    expect(r.mode).toBe("now");
    expect(await row(m.id)).toMatchObject({ status: "cancelled", endReason: "cancelled_by_customer", endedAt: days(29), renewalOrderId: null });
    expect(fx.cancelRenewalOrder).toHaveBeenCalledWith(expect.anything(), expect.anything(), { orderId: renewalOrderId, reason: "membership_cancelled" });
    expect(await getMembershipForPerson(h.db, m.personId)).toMatchObject({ isMember: false });
  });

  it("staff may cancel a past_due membership only with mode now", async () => {
    const { m } = await charged();
    await applyRenewalFailure(tx(), ctxAt(days(28)), { membershipId: m.id, paymentId: "tr_staff", reason: "failed" });
    await expect(requestCancel(tx(), ctxAt(days(29)), { membershipId: m.id, by: "staff", reason: "requested" })).rejects.toMatchObject({ code: "conflict" });
  });

  it("active -> cancelled: staff cancel now keeps the current inclusion grants usable", async () => {
    const { m } = await start();
    const staff = staffActor({ permissions: ["memberships.write"] });
    await expect(cancelNow(tx(), ctxAt(days(5), staff), { membershipId: m.id, by: "staff" })).rejects.toMatchObject({ code: "validation" });
    await cancelNow(tx(), ctxAt(days(5), staff), { membershipId: m.id, by: "staff", reason: "customer request at the desk" });
    expect(await row(m.id)).toMatchObject({ status: "cancelled", endReason: "cancelled_by_staff", endedAt: days(5) });
    expect((await grantsOf(m.id)).map((g) => [g.g.status, g.remaining])).toEqual([["active", 4]]);
    expect((await auditsOf(m.id)).map((a) => a.action)).toContain("memberships.cancelled_now");
    expect((await eventsOf(m.id)).at(-1)).toMatchObject({ kind: "membership.cancelled", data: { end_reason: "cancelled_by_staff" } });
  });

  it("pending -> cancelled: a pending membership is cancelled before its start by the customer or by staff", async () => {
    const a = await start({ startsAt: days(10) });
    expect((await requestCancel(tx(), ctxAt(T0), { membershipId: a.m.id, by: "customer" })).mode).toBe("now");
    expect(await row(a.m.id)).toMatchObject({ status: "cancelled", endReason: "cancelled_by_customer" });
    const b = await start({ startsAt: days(10) });
    await cancelNow(tx(), ctxAt(T0), { membershipId: b.m.id, by: "staff", reason: "bought by mistake" });
    expect(await row(b.m.id)).toMatchObject({ status: "cancelled", endReason: "cancelled_by_staff" });
    expect(await grantsOf(b.m.id)).toEqual([]);
  });

  it("resume before cancel_at clears cancel_at and cancel_requested_at", async () => {
    const { m } = await start({ mandate: true });
    await requestCancel(tx(), ctxAt(days(2)), { membershipId: m.id, by: "customer" });
    const resumed = await resume(tx(), ctxAt(days(3)), { membershipId: m.id });
    expect(resumed).toMatchObject({ cancelAt: null, cancelRequestedAt: null, status: "active" });
    expect(resumed.nextChargeAt).toEqual(shiftDays(m.currentPeriodEndAt, -3));
    expect((await eventsOf(m.id)).map((e) => e.kind)).toEqual(["membership.started", "membership.cancel_requested", "membership.resumed"]);
    expect((await auditsOf(m.id)).map((a) => a.action)).toContain("memberships.resumed");
    await expect(resume(tx(), ctxAt(days(3)), { membershipId: m.id })).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("cancelMembershipForRefund (rule 27a)", () => {
  it("active -> cancelled (refunded): revokes the unused units of the current period's active inclusion grants only", async () => {
    const { m, renewalOrderId } = await charged();
    // Use up the first period's day grant, then renew: the earlier period's grant stays untouched.
    await consumeCredits(tx(), ctxAt(days(1)), { personId: m.personId, beneficiaryPersonId: m.personId, kind: "day", units: 1, ref: { type: "booking", id: randomUUID() }, validAt: days(1) });
    await applyRenewalPayment(tx(), ctxAt(days(28)), { membershipId: m.id, orderId: renewalOrderId });
    const current = (await row(m.id)).currentPeriodStartAt;
    await consumeCredits(tx(), ctxAt(days(32)), { personId: m.personId, beneficiaryPersonId: m.personId, kind: "day", units: 2, ref: { type: "booking", id: randomUUID() }, validAt: days(32) });
    await cancelMembershipForRefund(tx(), ctxAt(days(33)), { membershipId: m.id, reason: "refund pro rata" });
    await cancelMembershipForRefund(tx(), ctxAt(days(33)), { membershipId: m.id, reason: "refund pro rata" });
    expect(await row(m.id)).toMatchObject({ status: "cancelled", endReason: "refunded" });
    const grants = await grantsOf(m.id);
    const earlier = grants.find((g) => g.g.startsAt.getTime() === T0.getTime())!;
    const now = grants.find((g) => g.g.startsAt.getTime() === current.getTime())!;
    expect([earlier.g.status, earlier.remaining]).toEqual(["active", 3]);
    expect([now.g.status, now.remaining]).toEqual(["revoked", 0]);
    expect((await auditsOf(m.id)).filter((a) => a.action === "memberships.cancelled_now")).toHaveLength(1);
  });

  it("an exhausted current-period grant is untouched", async () => {
    const { m } = await start();
    await consumeCredits(tx(), ctxAt(days(1)), { personId: m.personId, beneficiaryPersonId: m.personId, kind: "day", units: 4, ref: { type: "booking", id: randomUUID() }, validAt: days(1) });
    await cancelMembershipForRefund(tx(), ctxAt(days(2)), { membershipId: m.id, reason: "refund" });
    expect((await grantsOf(m.id)).map((g) => [g.g.status, g.remaining])).toEqual([["exhausted", 0]]);
  });

  it("pending -> cancelled (refunded): no grants exist yet", async () => {
    const { m } = await start({ startsAt: days(10) });
    await cancelMembershipForRefund(tx(), ctxAt(T0), { membershipId: m.id, reason: "refund" });
    expect(await row(m.id)).toMatchObject({ status: "cancelled", endReason: "refunded" });
  });

  it("past_due -> cancelled (refunded)", async () => {
    const { m } = await charged();
    await applyRenewalFailure(tx(), ctxAt(days(28)), { membershipId: m.id, paymentId: "tr_ref", reason: "failed" });
    await cancelMembershipForRefund(tx(), ctxAt(days(29)), { membershipId: m.id, reason: "refund" });
    expect(await row(m.id)).toMatchObject({ status: "cancelled", endReason: "refunded" });
  });
});

describe("period extension, the V1 pause (rule 55)", () => {
  it("moves the period end and next_charge_at, writes a staff_extension period and optionally extends the inclusion grants", async () => {
    const { m } = await start({ mandate: true });
    const staff = staffActor({ userId: (await makeUser(h.db)).id, permissions: ["memberships.write", "credits.adjust"] });
    const clientKey = randomUUID();
    const r = await extendPeriod(tx(), ctxAt(days(5), staff), { membershipId: m.id, days: 14, reason: "injury pause", alsoExtendInclusions: true, clientKey, version: m.version });
    expect(r).toMatchObject({ created: true, periodEndAt: shiftDays(m.currentPeriodEndAt, 14) });
    const after = await row(m.id);
    expect(after.currentPeriodEndAt).toEqual(shiftDays(m.currentPeriodEndAt, 14));
    expect(after.nextChargeAt).toEqual(shiftDays(m.nextChargeAt!, 14));
    expect((await periodsOf(m.id)).map((p) => [p.source, p.periodStartAt, p.periodEndAt])).toEqual([
      ["purchase", T0, m.currentPeriodEndAt],
      ["staff_extension", m.currentPeriodEndAt, after.currentPeriodEndAt],
    ]);
    const [g] = await grantsOf(m.id);
    expect(g!.g.expiresAt).toEqual(shiftDays(m.currentPeriodEndAt, 14));
    expect(await grantsOf(m.id)).toHaveLength(1);
    expect((await extendPeriod(tx(), ctxAt(days(5), staff), { membershipId: m.id, days: 14, reason: "injury pause", alsoExtendInclusions: true, clientKey })).created).toBe(false);
    expect((await row(m.id)).currentPeriodEndAt).toEqual(after.currentPeriodEndAt);
    expect((await auditsOf(m.id)).map((a) => a.action)).toContain("memberships.period_extended");
  });

  it("without the tick the inclusion grants keep their expiry; the next renewal starts at the moved end", async () => {
    const { m } = await start({ mandate: true });
    await extendPeriod(tx(), ctxAt(days(5)), { membershipId: m.id, days: 10, reason: "holiday", alsoExtendInclusions: false, clientKey: randomUUID() });
    const [g] = await grantsOf(m.id);
    expect(g!.g.expiresAt).toEqual(m.currentPeriodEndAt);
    const moved = await row(m.id);
    await inTx(days(-3, moved.currentPeriodEndAt), (t, ctx) => chargeRenewal(t, ctx, { membershipId: m.id, periodEndOn: endOn(moved), attempt: 1 }));
    const r = await applyRenewalPayment(tx(), ctxAt(days(-3, moved.currentPeriodEndAt)), { membershipId: m.id, orderId: (await row(m.id)).renewalOrderId! });
    expect(r.periodStartAt).toEqual(moved.currentPeriodEndAt);
    expect(brusselsDateKey(r.periodEndAt)).toBe("2026-05-20");
  });

  it("refuses 0 or 91 days", async () => {
    const { m } = await start();
    await expect(extendPeriod(tx(), ctxAt(T0), { membershipId: m.id, days: 91, reason: "too long", alsoExtendInclusions: false, clientKey: randomUUID() })).rejects.toMatchObject({ code: "validation" });
  });
});

// ---------------------------------------------------------------------------
// Reads, imports, erasure row
// ---------------------------------------------------------------------------

describe("getMembershipForPerson and getMembershipSummary", () => {
  it("active and past_due are members with the discount snapshot; cancelled is not", async () => {
    const active = await start();
    expect(await getMembershipForPerson(h.db, active.personId)).toEqual({
      isMember: true,
      membershipId: active.m.id,
      planProductId: active.plan.product.id,
      discountPct: 10,
      status: "active",
      periodEndAt: active.m.currentPeriodEndAt,
      cancelAt: null,
    });
    const pastDue = await charged();
    await applyRenewalFailure(tx(), ctxAt(days(28)), { membershipId: pastDue.m.id, paymentId: "tr_read", reason: "failed" });
    expect(await getMembershipForPerson(h.db, pastDue.personId)).toMatchObject({ isMember: true, status: "past_due", discountPct: 10 });
    const cancelled = await start();
    await cancelNow(tx(), ctxAt(days(1)), { membershipId: cancelled.m.id, by: "customer" });
    expect(await getMembershipForPerson(h.db, cancelled.personId)).toEqual({
      isMember: false,
      membershipId: null,
      planProductId: null,
      discountPct: 0,
      status: null,
      periodEndAt: null,
      cancelAt: null,
    });
    expect(await getMembershipForPerson(h.db, (await makePerson(h.db)).id)).toMatchObject({ isMember: false });
  });

  it("getMembershipSummary gives the plan, period end and this period's included units", async () => {
    const { m, plan } = await start({ extraNight: 2 });
    await consumeCredits(tx(), ctxAt(days(1)), { personId: m.personId, beneficiaryPersonId: m.personId, kind: "day", units: 1, ref: { type: "booking", id: randomUUID() }, validAt: days(1) });
    expect(await getMembershipSummary(h.db, m.personId)).toEqual({
      status: "active",
      productName: plan.product.name,
      currentPeriodEndAt: m.currentPeriodEndAt,
      includedCredits: [
        { kind: "day", remainingUnits: 3 },
        { kind: "night", remainingUnits: 2 },
      ],
    });
    expect(await getMembershipSummary(h.db, (await makePerson(h.db)).id)).toBeNull();
  });
});

describe("importMembership (ops imports)", () => {
  it("imported -> active: period end minus one interval, inclusions only for the running period; a re-run returns the same row", async () => {
    const plan = await makePlan();
    const personId = (await makePerson(h.db)).id;
    const periodEndAt = days(12);
    const input = { personId, productId: plan.product.id, periodEndAt, idempotencyKey: "import:imp1:row:4", mandateId: await makeMandate(personId) };
    const first = await importMembership(tx(), ctxAt(T0), input);
    const again = await importMembership(tx(), ctxAt(T0), input);
    expect(again).toEqual({ membershipId: first.membershipId, created: false });
    const m = await row(first.membershipId);
    expect(m).toMatchObject({ status: "active", source: "import", currentPeriodEndAt: periodEndAt, discountPct: "10.00" });
    expect(brusselsDateKey(m.currentPeriodStartAt)).toBe("2026-02-22");
    expect(m.nextChargeAt).toEqual(shiftDays(periodEndAt, -3));
    expect((await periodsOf(m.id)).map((p) => p.source)).toEqual(["import"]);
    expect(await grantsOf(m.id)).toHaveLength(1);
  });

  it("imported -> cancelled and imported -> expired end with not_renewed and get no grants", async () => {
    const plan = await makePlan();
    for (const status of ["cancelled", "expired"] as const) {
      const personId = (await makePerson(h.db)).id;
      const r = await importMembership(tx(), ctxAt(T0), { personId, productId: plan.product.id, periodEndAt: days(-40), idempotencyKey: `import:imp2:${status}`, status });
      expect(await row(r.membershipId)).toMatchObject({ status, endReason: "not_renewed", endedAt: days(-40) });
      expect(await grantsOf(r.membershipId)).toEqual([]);
    }
  });
});

describe("erasure rows of the status machine (handled by credits-P5's privacy.erase)", () => {
  it.each(["active", "past_due", "pending"] as const)("%s -> expired is allowed only with end_reason erased", (from) => {
    expect(() => assertMembershipTransition(from, "expired", { endReason: "erased" })).not.toThrow();
    if (from !== "past_due") expect(() => assertMembershipTransition(from, "expired", { endReason: "payment_failed" })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Concurrency, job double runs, templates
// ---------------------------------------------------------------------------

describe("locks and jobs", () => {
  it("a parallel scan and renewal webhook on one membership serialise on the row lock", async () => {
    const { m } = await start();
    await scanOne(m.id, days(-7, m.currentPeriodEndAt));
    const orderId = (await row(m.id)).renewalOrderId!;
    const at = new Date(m.currentPeriodEndAt.getTime() + 60_000);
    const [scanned, paid] = await Promise.all([scanOne(m.id, at), inTx(at, (t, ctx) => applyRenewalPayment(t, ctx, { membershipId: m.id, orderId }))]);
    expect(paid.applied).toBe(true);
    const after = await row(m.id);
    expect(after).toMatchObject({ status: "active", currentPeriodStartAt: m.currentPeriodEndAt, renewalOrderId: null, dunningAttempt: 0 });
    expect((await periodsOf(m.id)).filter((p) => p.source === "renewal")).toHaveLength(1);
    expect(Array.isArray(scanned)).toBe(true);
  });

  it("memberships.scan_renewals twice the same day changes nothing the second time", async () => {
    const { m } = await start();
    const at = days(-7, m.currentPeriodEndAt);
    const first = await runJob("memberships.scan_renewals", at, (ctx) => runScanRenewals(ctx, {}));
    expect(first.actions[m.id]).toEqual(["link_order", "reminder:7"]);
    const snapshot = { row: await row(m.id), events: (await eventsOf(m.id)).length, sends: sends(m.id).length };
    const second = await runJob("memberships.scan_renewals", at, (ctx) => runScanRenewals(ctx, {}));
    expect(second.actions[m.id]).toBeUndefined();
    expect(await row(m.id)).toEqual(snapshot.row);
    expect((await eventsOf(m.id)).length).toBe(snapshot.events);
    expect(sends(m.id).length).toBe(snapshot.sends);
    expect(second.errors.filter((e) => e.membershipId === m.id)).toEqual([]);
  });

  it("memberships.charge_renewal twice creates one charge", async () => {
    const { m } = await start({ mandate: true });
    const at = days(-3, m.currentPeriodEndAt);
    const payload = { membershipId: m.id, periodEndOn: endOn(m), attempt: 1 as const };
    const first = await runJob("memberships.charge_renewal", at, (ctx) => runChargeRenewal(ctx, payload));
    const afterFirst = await row(m.id);
    const second = await runJob("memberships.charge_renewal", at, (ctx) => runChargeRenewal(ctx, payload));
    expect(first).toMatchObject({ charged: true });
    expect(second).toMatchObject({ charged: false });
    expect(await row(m.id)).toEqual(afterFirst);
    expect(fx.createRecurringCharge).toHaveBeenCalledTimes(1);
  });

  it("lockMembership refuses an unknown id (not_found)", async () => {
    await expect(lockMembership(h.db, randomUUID())).rejects.toMatchObject({ code: "not_found" });
  });

  it("the balance of a membership grant follows the ledger", async () => {
    const { m } = await start();
    const [g] = await grantsOf(m.id);
    expect(await balanceOf(h.db, g!.g.id)).toBe(4);
  });
});

describe("membership templates", () => {
  const registry = TEMPLATE_REGISTRY as unknown as Record<string, TemplateDef>;
  it.each(MEMBERSHIP_TEMPLATES.flatMap((name) => LOCALES.map((locale) => [name, locale] as const)))("credits.%s renders its sample in %s", async (name, locale) => {
    const tpl = registry[`credits.${name}`];
    expect(tpl, name).toBeDefined();
    const out = await renderEmail({ source: "code", template: tpl!, locale, props: tpl!.sample });
    expect(out.subject.trim()).not.toBe("");
    expect(out.subject).not.toMatch(/[{}⟦]/);
    expect(out.html).toContain(`lang="${locale}"`);
    expect(out.text.length).toBeGreaterThan(40);
  });
});
