/**
 * credits-P9 (R3): referral codes, attribution, rewards and partner commissions (credits spec
 * rules 60 to 63, section 2 "R3 state machines", edge case 28). Every attribution and commission
 * transition; the reward after 14 days only when not refunded, once (double run); a full refund
 * before qualification returns to `pending`; the yearly cap of 10; commission accrual, the
 * negative row on refund, no accrual after 12 months; the partner sees only own aggregates;
 * erasure deletes codes and attributions and nulls the commission links.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle, Tx } from "@beam/db";
import { activityEvents, auditLog, companies, creditGrants, partnerCommissions, payments, persons, referralAttributions, referralCodes, refunds } from "@beam/db/schema";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import { makePaidOrder } from "@beam/db/testing/commerce-factories";
import type * as EmailApi from "@/modules/email/api";
import { and, eq, sql } from "@/lib/ctx";
import { makeCtx, resetRuntime, runJobTwice, staffActor } from "@/lib/testing";
import { partnerScope } from "@/modules/platform/api";
import { getMyPartnerPerformance } from "../queries";
import { onPersonsMerged } from "../api";
import { privacy } from "../privacy";
import {
  attributeReferral,
  createReferralCode,
  getMyReferrals,
  getOrCreatePersonalCode,
  getPartnerPerformance,
  onOrderPaidForReferrals,
  onOrderRefundedForReferrals,
  qualifyAttribution,
  referralsSettings,
  rejectAttribution,
  resolveReferralCode,
  setCommissionStatus,
  updateReferralCode,
} from "./referrals";

const fx = vi.hoisted(() => ({ sendTransactional: vi.fn() }));
vi.mock("@/modules/email/api", async (orig) => ({ ...(await orig<typeof EmailApi>()), sendTransactional: fx.sendTransactional }));

let h: DbHandle;
let staffUserId: string;
beforeAll(async () => {
  h = await createTestDb();
  staffUserId = (await makeUser(h.db, { roleKey: "finance" })).id;
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(() => {
  fx.sendTransactional.mockReset();
  fx.sendTransactional.mockResolvedValue({ emailMessageId: randomUUID(), jobId: randomUUID() });
});

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);
const tx = () => h.db as unknown as Tx;
const sys = (now?: Date) => makeCtx(h.db, now ? { now } : undefined);
const staff = () => makeCtx(h.db, staffActor({ userId: staffUserId, roleKey: "finance", permissions: ["referrals.manage"] }));
const attribution = async (id: string) => (await h.db.select().from(referralAttributions).where(eq(referralAttributions.id, id)))[0]!;

async function partner(pct = "10.00", name = `Partner ${randomUUID().slice(0, 6)}`) {
  const [c] = await h.db.insert(companies).values({ name, isPartner: true, partnerCommissionPct: pct }).returning();
  return c!;
}

/** A referrer with a personal code and a referred friend attributed `attributedDaysAgo` days ago. */
async function referred(attributedDaysAgo = 30) {
  const referrer = await makePerson(h.db, { firstName: "Anna", lastName: "Dewit" });
  const friend = await makePerson(h.db, { firstName: "Bram", lastName: "Peeters" });
  const { codeId } = await getOrCreatePersonalCode(tx(), sys(), referrer.id);
  const r = await attributeReferral(tx(), sys(), { referredPersonId: friend.id, codeId, source: "code", attributedAt: ago(attributedDaysAgo) });
  return { referrer, friend, codeId, attributionId: r.attributionId!, result: r };
}

async function paidAt(personId: string, at: Date, cents = 12_100) {
  const { order } = await makePaidOrder(h.db, {
    personId,
    lines: [{ unitAmountCents: cents, lineTotalCents: cents }],
    order: { paidAt: at, totalCents: cents, subtotalCents: cents, vatCents: Math.round((cents * 21) / 121) },
  });
  await onOrderPaidForReferrals(tx(), sys(), { orderId: order.id });
  return order;
}

const paid = (personId: string, daysAgo: number, cents = 12_100) => paidAt(personId, ago(daysAgo), cents);

async function refund(order: { id: string; totalCents: number }, cents = order.totalCents) {
  const [p] = await h.db.insert(payments).values({ orderId: order.id, provider: "mollie", status: "paid", amountCents: order.totalCents, paidAt: ago(1) }).returning();
  const [r] = await h.db
    .insert(refunds)
    .values({ paymentId: p!.id, orderId: order.id, amountCents: cents, reason: "test", lines: [], creditAction: "none", status: "refunded", createdByUserId: staffUserId })
    .returning();
  if (cents >= order.totalCents) await h.db.execute(sql`update orders set status = 'refunded' where id = ${order.id}::uuid`);
  await onOrderRefundedForReferrals(tx(), sys(), { orderId: order.id, refundId: r!.id });
  return r!;
}

describe("referral codes (rule 60)", () => {
  it("gives a person one personal code of 8 characters, created once, resolved in any case", async () => {
    const p = await makePerson(h.db);
    const first = await getOrCreatePersonalCode(tx(), sys(), p.id);
    const again = await getOrCreatePersonalCode(tx(), sys(), p.id);
    expect(first.created).toBe(true);
    expect(again).toEqual({ ...first, created: false });
    expect(first.code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(await resolveReferralCode(h.db, first.code.toLowerCase())).toEqual({ codeId: first.codeId, referrerPersonId: p.id, partnerCompanyId: null });
    expect(await resolveReferralCode(h.db, "NOSUCH99")).toBeNull();
    expect(await resolveReferralCode(h.db, "bad")).toBeNull();
  });

  it("keeps codes unique in any case; partner codes need is_partner; inactive or used-up codes do not resolve", async () => {
    const c = await partner();
    const created = await createReferralCode(tx(), staff(), { partnerCompanyId: c.id, code: "yoga2026", maxUses: 1 });
    expect(created.code).toBe("YOGA2026");
    await expect(createReferralCode(tx(), staff(), { partnerCompanyId: c.id, code: "YOGA2026" })).rejects.toThrow("code_taken");
    await expect(h.db.insert(referralCodes).values({ code: "yoga2026", partnerCompanyId: c.id })).rejects.toThrow();
    const [notPartner] = await h.db.insert(companies).values({ name: "Not a partner" }).returning();
    await expect(createReferralCode(tx(), staff(), { partnerCompanyId: notPartner!.id })).rejects.toThrow("not_a_partner");
    const audits = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "referrals.code_created"), eq(auditLog.entityId, created.codeId)));
    expect(audits).toHaveLength(1);

    expect(await resolveReferralCode(h.db, "YOGA2026")).toEqual({ codeId: created.codeId, referrerPersonId: null, partnerCompanyId: c.id });
    const friend = await makePerson(h.db);
    await attributeReferral(tx(), sys(), { referredPersonId: friend.id, codeId: created.codeId, source: "code" });
    expect(await resolveReferralCode(h.db, "YOGA2026")).toBeNull(); // max_uses 1 reached
    await updateReferralCode(tx(), staff(), { codeId: created.codeId, maxUses: null, isActive: false });
    expect(await resolveReferralCode(h.db, "YOGA2026")).toBeNull();
    expect(await h.db.select().from(auditLog).where(and(eq(auditLog.action, "referrals.code_changed"), eq(auditLog.entityId, created.codeId)))).toHaveLength(1);
  });
});

describe("attribution (rule 61, edge case 28)", () => {
  it("is first-touch: a second attribution changes nothing", async () => {
    const { friend, attributionId, result } = await referred();
    expect(result).toMatchObject({ status: "pending", created: true });
    const other = await makePerson(h.db);
    const again = await attributeReferral(tx(), staff(), { referredPersonId: friend.id, referrerPersonId: other.id, source: "staff" });
    expect(again).toMatchObject({ attributionId, created: false });
    expect((await attribution(attributionId)).referrerPersonId).not.toBe(other.id);
    const events = await h.db.select().from(activityEvents).where(and(eq(activityEvents.kind, "referral.attributed"), eq(activityEvents.refId, attributionId)));
    expect(events).toHaveLength(1);
  });

  it("rejects self-referral by the same person or phone", async () => {
    const a = await makePerson(h.db, { email: "anna.self@example.com", phone: "+32470111222" });
    const { codeId } = await getOrCreatePersonalCode(tx(), sys(), a.id);
    const same = await attributeReferral(tx(), sys(), { referredPersonId: a.id, codeId, source: "code" });
    expect(same).toMatchObject({ attributionId: null, status: "rejected", reason: "self_referral" });
    // Same lower-case email: two active persons cannot share one (crm), so core's isSelfReferral covers it.
    const twinPhone = await makePerson(h.db, { phone: "0470 11 12 22" });
    const r = await attributeReferral(tx(), sys(), { referredPersonId: twinPhone.id, codeId, source: "code" });
    expect((await attribution(r.attributionId!)).rejectedReason).toBe("self_referral");
  });

  it("rejects a person who already paid an order before the attribution (already_customer, A refers B refers A)", async () => {
    const a = await makePerson(h.db);
    const b = await makePerson(h.db);
    await makePaidOrder(h.db, { personId: b.id, order: { paidAt: ago(50) } });
    const r = await attributeReferral(tx(), staff(), { referredPersonId: b.id, referrerPersonId: a.id, source: "staff" });
    expect(r).toMatchObject({ status: "rejected", reason: "already_customer" });
    expect(await h.db.select().from(auditLog).where(and(eq(auditLog.action, "referrals.attributed"), eq(auditLog.entityId, r.attributionId!)))).toHaveLength(1);
  });

  it("pending -> rejected by staff; rejected and rewarded are terminal", async () => {
    const { attributionId } = await referred();
    await rejectAttribution(tx(), staff(), { attributionId, reason: "duplicate account" });
    expect(await attribution(attributionId)).toMatchObject({ status: "rejected", rejectedReason: "duplicate account" });
    await expect(rejectAttribution(tx(), staff(), { attributionId, reason: "again" })).rejects.toThrow(/attribution_transition/);
    expect(await h.db.select().from(auditLog).where(and(eq(auditLog.action, "referrals.attribution_rejected"), eq(auditLog.entityId, attributionId)))).toHaveLength(1);
  });
});

describe("qualification and rewards (rule 62)", () => {
  it("pending -> qualified on the first paid order above 0; a free order does not qualify", async () => {
    const { friend, attributionId } = await referred();
    await paid(friend.id, 25, 0).catch(() => undefined);
    expect((await attribution(attributionId)).status).toBe("pending");
    const order = await paid(friend.id, 20);
    const a = await attribution(attributionId);
    expect(a).toMatchObject({ status: "qualified", firstPaidOrderId: order.id });
    expect(a.qualifiesAt!.getTime() - a.firstPaidAt!.getTime()).toBe(14 * DAY);
  });

  it("qualified -> pending on a full refund before qualifies_at; a partial refund keeps it qualified", async () => {
    const { friend, attributionId } = await referred();
    const order = await paid(friend.id, 5);
    await refund(order, 1000);
    expect((await attribution(attributionId)).status).toBe("qualified");
    await refund(order, order.totalCents);
    expect(await attribution(attributionId)).toMatchObject({ status: "pending", firstPaidOrderId: null, firstPaidAt: null, qualifiesAt: null });
    const later = await paid(friend.id, 2);
    expect(await attribution(attributionId)).toMatchObject({ status: "qualified", firstPaidOrderId: later.id });
  });

  it("qualified -> rewarded only after 14 days, once (double run), with the referrer grant and email", async () => {
    const early = await referred();
    await paid(early.friend.id, 5);
    const due = await referred();
    await paid(due.friend.id, 20);
    const { first, second } = await runJobTwice(h.db, "credits.qualify_referral_rewards", {});
    expect((first as { outcomes: Record<string, number> }).outcomes.rewarded).toBeGreaterThanOrEqual(1);
    expect(second).toMatchObject({ due: 0 });
    expect((await attribution(early.attributionId)).status).toBe("qualified");
    const a = await attribution(due.attributionId);
    expect(a.status).toBe("rewarded");
    const grants = await h.db.select().from(creditGrants).where(eq(creditGrants.referralAttributionId, due.attributionId));
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ id: a.referrerRewardGrantId, personId: due.referrer.id, source: "referral", creditKind: "day", unitsGranted: 1, vatTreatment: "not_applicable" });
    expect(grants[0]!.label).toEqual(expect.objectContaining({ en: expect.any(String), "nl-BE": expect.any(String), "fr-BE": expect.any(String) }));
    const sends = fx.sendTransactional.mock.calls.filter((c) => (c[1] as { key: string }).key === `credits:referral_reward:${due.attributionId}:referrer`);
    expect(sends).toHaveLength(1);
    expect(sends[0]![1]).toMatchObject({ template: "credits.referral_reward", personId: due.referrer.id });
    const mine = await getMyReferrals(h.db, due.referrer.id);
    expect(mine).toMatchObject({ referredCount: 1, rewards: [expect.objectContaining({ grantId: grants[0]!.id, units: 1 })] });
  });

  it("gives no reward when the qualifying order was refunded in full by the due date", async () => {
    const { friend, attributionId } = await referred();
    const order = await paid(friend.id, 20);
    await h.db.execute(sql`update orders set status = 'refunded' where id = ${order.id}::uuid`);
    await runJobTwice(h.db, "credits.qualify_referral_rewards", {});
    expect((await attribution(attributionId)).status).toBe("pending");
    expect(await h.db.select().from(creditGrants).where(eq(creditGrants.referralAttributionId, attributionId))).toEqual([]);
  });

  it("rejects the 11th rewarded referral of a referrer in a calendar year (cap_reached)", async () => {
    const referrer = await makePerson(h.db);
    const { codeId } = await getOrCreatePersonalCode(tx(), sys(), referrer.id);
    const ids: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const friend = await makePerson(h.db);
      // Eleven qualify in March 2025; the twelfth in January 2026 (a new calendar year).
      const at = i < 11 ? new Date(`2025-03-0${1 + (i % 9)}T10:00:00Z`) : new Date("2026-01-05T10:00:00Z");
      const r = await attributeReferral(tx(), sys(), { referredPersonId: friend.id, codeId, source: "code", attributedAt: new Date(at.getTime() - DAY) });
      ids.push(r.attributionId!);
      await paidAt(friend.id, at);
    }
    const settings = await referralsSettings(h.db);
    for (const id of ids.slice(0, 11)) await qualifyAttribution(tx(), sys(new Date("2025-04-01T00:00:00Z")), id, settings);
    await qualifyAttribution(tx(), sys(new Date("2026-02-01T00:00:00Z")), ids[11]!, settings);
    const rows = await Promise.all(ids.map((id) => attribution(id)));
    expect(rows.slice(0, 10).map((r) => r.status)).toEqual(Array(10).fill("rewarded"));
    expect(rows[10]).toMatchObject({ status: "rejected", rejectedReason: "cap_reached", referrerRewardGrantId: null });
    expect(rows[11]!.status).toBe("rewarded");
    const rejected = await h.db.select().from(activityEvents).where(and(eq(activityEvents.kind, "referral.rejected"), eq(activityEvents.refId, ids[10]!)));
    expect(rejected[0]!.data).toMatchObject({ reason: "cap_reached" });
  });
});

describe("partner commissions (rule 63)", () => {
  async function partnerReferral(attributedDaysAgo = 30, pct = "10.00") {
    const c = await partner(pct);
    const { codeId } = await createReferralCode(tx(), staff(), { partnerCompanyId: c.id });
    const friend = await makePerson(h.db);
    const r = await attributeReferral(tx(), sys(), { referredPersonId: friend.id, codeId, source: "code", attributedAt: ago(attributedDaysAgo) });
    return { company: c, friend, attributionId: r.attributionId! };
  }
  const commissions = (companyId: string) => h.db.select().from(partnerCommissions).where(eq(partnerCommissions.partnerCompanyId, companyId));

  it("accrues on every paid order (net of VAT, rate snapshot), once per order, and a negative row on refund", async () => {
    const { company, friend } = await partnerReferral(30, "12.50");
    const order = await paid(friend.id, 10); // 121.00 incl. 21.00 VAT
    await onOrderPaidForReferrals(tx(), sys(), { orderId: order.id });
    await h.db.update(companies).set({ partnerCommissionPct: "50.00" }).where(eq(companies.id, company.id));
    let rows = await commissions(company.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ orderId: order.id, baseCents: 10_000, commissionPct: "12.50", amountCents: 1250, status: "accrued", idempotencyKey: `commission:${order.id}` });
    const r = await refund(order);
    await onOrderRefundedForReferrals(tx(), sys(), { orderId: order.id, refundId: r.id });
    rows = await commissions(company.id);
    expect(rows).toHaveLength(2);
    expect(rows.find((x) => x.refundId === r.id)).toMatchObject({ baseCents: -10_000, commissionPct: "12.50", amountCents: -1250, idempotencyKey: `commission:refund:${r.id}` });
  });

  it("stops accruing 12 months after the attribution", async () => {
    const { company, friend } = await partnerReferral(400);
    await paid(friend.id, 380);
    await paid(friend.id, 10);
    const rows = await commissions(company.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.periodMonth).toMatch(/^\d{4}-\d{2}-01$/);
  });

  it("moves accrued -> approved -> paid and accrued or approved -> void; paid and void are terminal", async () => {
    const { company, friend } = await partnerReferral();
    await paid(friend.id, 9);
    await paid(friend.id, 8);
    const [a, b] = await commissions(company.id);
    await setCommissionStatus(tx(), staff(), { commissionIds: [a!.id, b!.id], status: "approved" });
    await setCommissionStatus(tx(), staff(), { commissionIds: [a!.id], status: "paid" });
    await setCommissionStatus(tx(), staff(), { commissionIds: [b!.id], status: "void", note: "duplicate order" });
    const after = await commissions(company.id);
    expect(after.find((x) => x.id === a!.id)).toMatchObject({ status: "paid", approvedByUserId: staffUserId, paidAt: expect.any(Date) });
    expect(after.find((x) => x.id === b!.id)).toMatchObject({ status: "void", note: "duplicate order" });
    await expect(setCommissionStatus(tx(), staff(), { commissionIds: [a!.id], status: "void" })).rejects.toThrow(/commission_transition/);
    await expect(setCommissionStatus(tx(), staff(), { commissionIds: [b!.id], status: "approved" })).rejects.toThrow(/commission_transition/);
    const audits = await h.db.select().from(auditLog).where(eq(auditLog.action, "referrals.commission_status_changed"));
    expect(audits.filter((x) => x.entityId === a!.id)).toHaveLength(2);
  });

  it("shows a partner only their own aggregates in v_partner_performance, without names", async () => {
    const mine = await partnerReferral(20);
    const theirs = await partnerReferral(20);
    await paid(mine.friend.id, 10);
    await paid(theirs.friend.id, 10, 50_000);
    const contact = await makePerson(h.db, { partnerCompanyId: mine.company.id });
    const user = await makeUser(h.db, { roleKey: "external_partner", personId: contact.id });
    const ctx = makeCtx(h.db, staffActor({ userId: user.id, roleKey: "external_partner", permissions: ["partner.own"] }));
    const { companyId } = await partnerScope(ctx);
    expect(companyId).toBe(mine.company.id);
    const own = await getMyPartnerPerformance(h.db, companyId);
    expect(new Set(own.months.map((m) => m.partnerCompanyId))).toEqual(new Set([mine.company.id]));
    const total = own.months.reduce((s, m) => ({ referred: s.referred + m.referredCount, customers: s.customers + m.customersCount, revenue: s.revenue + m.revenueCents, accrued: s.accrued + m.commissionAccruedCents }), { referred: 0, customers: 0, revenue: 0, accrued: 0 });
    expect(total).toEqual({ referred: 1, customers: 1, revenue: 12_100, accrued: 1000 });
    expect(JSON.stringify(own)).not.toMatch(/Bram|Peeters|person|companyName/i);
    expect(own.codes).toHaveLength(1);
    const staffView = await getPartnerPerformance(h.db, null);
    expect(staffView.some((r) => r.partnerCompanyId === theirs.company.id && r.revenueCents === 50_000)).toBe(true);
  });
});

describe("attribution job, merge and erasure", () => {
  it("credits.attribute_referrals attributes from persons.acquisition once (double run)", async () => {
    const referrer = await makePerson(h.db);
    const { code } = await getOrCreatePersonalCode(tx(), sys(), referrer.id);
    const friend = await makePerson(h.db, { acquisition: { source: "referral", referral_code: code } });
    await runJobTwice(h.db, "credits.attribute_referrals", {});
    const rows = await h.db.select().from(referralAttributions).where(eq(referralAttributions.referredPersonId, friend.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ referrerPersonId: referrer.id, source: "code", status: "pending" });
  });

  it("moves codes and attributions to the merge winner without leaving a self-referral", async () => {
    const { referrer, friend, attributionId } = await referred();
    const winner = await makePerson(h.db);
    await getOrCreatePersonalCode(tx(), sys(), winner.id);
    await onPersonsMerged(tx(), sys(), { winnerPersonId: winner.id, loserPersonId: referrer.id });
    expect((await attribution(attributionId)).referrerPersonId).toBe(winner.id);
    const codes = await h.db.select().from(referralCodes).where(eq(referralCodes.personId, winner.id));
    expect(codes).toHaveLength(2);
    expect(codes.filter((c) => c.isActive)).toHaveLength(1);
    await onPersonsMerged(tx(), sys(), { winnerPersonId: winner.id, loserPersonId: friend.id });
    expect(await h.db.select().from(referralAttributions).where(eq(referralAttributions.id, attributionId))).toEqual([]);
  });

  it("erasure deletes the person's codes and attributions and nulls the commission links", async () => {
    const c = await partner();
    const { codeId } = await createReferralCode(tx(), staff(), { partnerCompanyId: c.id });
    const friend = await makePerson(h.db);
    const r = await attributeReferral(tx(), sys(), { referredPersonId: friend.id, codeId, source: "code", attributedAt: ago(30) });
    await paid(friend.id, 10);
    const { codeId: ownCode } = await getOrCreatePersonalCode(tx(), sys(), friend.id);
    const out = (await privacy.export(tx(), friend.id)) as { referrals: { codes: unknown[]; referredBy: unknown[] } };
    expect(out.referrals.codes).toHaveLength(1);
    expect(out.referrals.referredBy).toHaveLength(1);
    await h.db.transaction(async (t) => {
      const report = await privacy.erase(t, friend.id);
      expect(report).toEqual(expect.arrayContaining([{ table: "referral_attributions", rows: 1, action: "deleted" }, { table: "referral_codes", rows: 1, action: "deleted" }]));
    });
    expect(await h.db.select().from(referralAttributions).where(eq(referralAttributions.id, r.attributionId!))).toEqual([]);
    expect(await h.db.select().from(referralCodes).where(eq(referralCodes.id, ownCode))).toEqual([]);
    const rows = await h.db.select().from(partnerCommissions).where(eq(partnerCommissions.partnerCompanyId, c.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.attributionId).toBeNull();
    expect((await h.db.select({ id: persons.id }).from(persons).where(eq(persons.id, friend.id)))).toHaveLength(1);
  });
});
