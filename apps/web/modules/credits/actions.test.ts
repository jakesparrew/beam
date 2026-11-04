/**
 * credits-P6 staff actions (credits spec sections 4 and 7): each action writes the right ledger
 * entry, event and one audit row with the old and new value; the same `clientKey` twice writes
 * once; a stale `version` is `conflict`; an adjustment without a reason and a benefit text missing
 * a locale are `validation`; a bulk extension creates one row and enqueues one job. The email
 * pipeline is replaced by a fake that queues an `email.send` job, which the tests assert.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson, makeProduct, makeUser } from "@beam/db/testing";
import { makeCreditGrant, makeMembership } from "@beam/db/testing/credits-factories";
import type { DbHandle } from "@beam/db";
import {
  activityEvents,
  auditLog,
  creditBulkExtensions,
  creditEntries,
  creditGrants,
  jobs,
  membershipPeriods,
  membershipPlanBenefits,
  membershipPlanInclusions,
  memberships,
  roles,
} from "@beam/db/schema";
import type * as CommerceApi from "@/modules/commerce/api";
import type * as EmailApi from "@/modules/email/api";
import type { Ctx } from "@/lib/ctx";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.45" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));

const fx = vi.hoisted(() => ({
  mandate: null as { mandateId: string; method: string; summary: string | null } | null,
}));
vi.mock("@/modules/email/api", async (orig) => ({
  ...(await orig<typeof EmailApi>()),
  sendTransactional: async (ctx: Ctx, input: { template: string; key: string }) => {
    const emailMessageId = randomUUID();
    const job = await ctx.enqueue({ kind: "email.send", payload: { emailMessageId, template: input.template }, key: `email:${input.key}` });
    return { emailMessageId, jobId: job.id };
  },
}));
vi.mock("@/modules/commerce/api", async (orig) => ({
  ...(await orig<typeof CommerceApi>()),
  getActiveMandate: () => Promise.resolve(fx.mandate),
}));

const actions = await import("./actions");
const { createAuthSession, SESSION_COOKIE } = await import("@/lib/auth");
const { and, eq, setAppDb } = await import("@/lib/ctx");
const { resetRuntime } = await import("@/lib/testing");

let handle: DbHandle;
let staffUserId: string;
const DAY = 86_400_000;
const label = { "nl-BE": "Cadeau van BEAM", "fr-BE": "Cadeau de BEAM", en: "Gift from BEAM" };
const text = { "nl-BE": "Gratis thee", "fr-BE": "Thé offert", en: "Free tea" };

type Ok<T> = { ok: true; data: T };
function ok<T>(r: unknown): T {
  expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
  return (r as Ok<T>).data;
}

async function audits(action: string, entityId?: string) {
  const rows = await handle.db.select().from(auditLog).where(eq(auditLog.action, action));
  return entityId ? rows.filter((r) => r.entityId === entityId) : rows;
}
async function entriesOf(grantId: string) {
  return handle.db.select().from(creditEntries).where(eq(creditEntries.grantId, grantId));
}
async function eventsOf(kind: string, refId: string) {
  return handle.db.select().from(activityEvents).where(and(eq(activityEvents.kind, kind), eq(activityEvents.refId, refId)));
}

beforeAll(async () => {
  handle = await createTestDb();
  setAppDb(handle.db);
  const user = await makeUser(handle.db, { roleKey: "customer_service" });
  staffUserId = user.id;
  await handle.db.update(roles).set({ permissions: ["credits.read", "credits.adjust", "memberships.write", "persons.read"] }).where(eq(roles.key, "customer_service"));
});
afterAll(async () => {
  resetRuntime();
  await handle.close();
});
beforeEach(async () => {
  jar.clear();
  fx.mandate = null;
  const { token } = await createAuthSession(handle.db, { userId: staffUserId, audience: "staff", roleKey: "customer_service", now: new Date(), mfaAt: new Date() });
  jar.set(SESSION_COOKIE, token);
});

describe("grant actions", () => {
  it("createGrant writes the grant, its grant entry, credits.granted and one audit row; a second submit writes nothing", async () => {
    const person = await makePerson(handle.db);
    const input = { personId: person.id, kind: "day" as const, units: 2, source: "bonus" as const, label, validityDays: 90, reason: "Goodwill gesture", clientKey: randomUUID() };
    const { grantId, created } = ok<{ grantId: string; created: boolean }>(await actions.createGrant(input));
    expect(created).toBe(true);
    const [g] = await handle.db.select().from(creditGrants).where(eq(creditGrants.id, grantId));
    expect(g).toMatchObject({ personId: person.id, source: "bonus", unitsGranted: 2, vatTreatment: "not_applicable", unitValueCents: 0, createdByUserId: staffUserId });
    expect(g!.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 89 * DAY);
    const es = await entriesOf(grantId);
    expect(es).toHaveLength(1);
    expect(es[0]).toMatchObject({ kind: "grant", quantity: 2, idempotencyKey: `grant:staff:${input.clientKey}`, reason: "Goodwill gesture" });
    expect(await eventsOf("credits.granted", grantId)).toHaveLength(1);
    const a = await audits("credits.grant_created", grantId);
    expect(a).toHaveLength(1);
    expect(a[0]!.newValue).toMatchObject({ kind: "day", units: 2, balance: 2 });

    expect(ok<{ grantId: string; created: boolean }>(await actions.createGrant(input))).toEqual({ grantId, created: false });
    expect(await handle.db.select().from(creditGrants).where(eq(creditGrants.personId, person.id))).toHaveLength(1);
    expect(await audits("credits.grant_created", grantId)).toHaveLength(1);
    expect(await audits("credits.create_grant")).toHaveLength(0);
  });

  it("createGrant refuses a label missing a locale, no expiry for sessions and an unknown person", async () => {
    const person = await makePerson(handle.db);
    const base = { personId: person.id, kind: "day" as const, units: 1, source: "manual" as const, label, validityDays: 30, reason: "Goodwill", clientKey: randomUUID() };
    expect(await actions.createGrant({ ...base, label: { en: "Gift" } })).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(await actions.createGrant({ ...base, validityDays: undefined, noExpiry: true })).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(await actions.createGrant({ ...base, personId: randomUUID() })).toMatchObject({ ok: false, error: { code: "not_found" } });
    const euro = ok<{ grantId: string }>(await actions.createGrant({ ...base, kind: "euro", units: 2500, validityDays: undefined, noExpiry: true }));
    const [g] = await handle.db.select().from(creditGrants).where(eq(creditGrants.id, euro.grantId));
    expect(g).toMatchObject({ creditKind: "euro", unitValueCents: 1, expiresAt: null, vatTreatment: "not_applicable" });
  });

  it("adjustGrant writes adjust, credits.adjusted and an audit row with old and new balance; once per clientKey; reason required", async () => {
    const grant = await makeCreditGrant(handle.db, { units: 5 });
    const clientKey = randomUUID();
    const r = ok<{ oldBalance: number; newBalance: number; created: boolean }>(await actions.adjustGrant({ grantId: grant.id, quantity: -2, reason: "Double booking", clientKey }));
    expect(r).toEqual({ oldBalance: 5, newBalance: 3, created: true });
    expect(ok<{ created: boolean }>(await actions.adjustGrant({ grantId: grant.id, quantity: -2, reason: "Double booking", clientKey })).created).toBe(false);
    const adjusts = (await entriesOf(grant.id)).filter((e) => e.kind === "adjust");
    expect(adjusts).toHaveLength(1);
    expect(adjusts[0]).toMatchObject({ quantity: -2, reason: "Double booking", idempotencyKey: `adjust:${clientKey}` });
    expect(await eventsOf("credits.adjusted", grant.id)).toHaveLength(1);
    const a = await audits("credits.adjusted", grant.id);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ oldValue: { balance: 5 }, newValue: { balance: 3, quantity: -2 } });

    expect(await actions.adjustGrant({ grantId: grant.id, quantity: 1, clientKey: randomUUID() })).toMatchObject({ ok: false, error: { code: "validation", fields: { reason: expect.any(String) } } });
    expect(await actions.adjustGrant({ grantId: grant.id, quantity: 1, reason: "  ", clientKey: randomUUID() })).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(await actions.adjustGrant({ grantId: grant.id, quantity: -10, reason: "Too much", clientKey: randomUUID() })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(await actions.adjustGrant({ grantId: randomUUID(), quantity: 1, reason: "Missing", clientKey: randomUUID() })).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("extendGrant writes extend with old and new expiry, credits.extended and credits.grant_extended; a date is the end of that Brussels day", async () => {
    const grant = await makeCreditGrant(handle.db, { units: 3, expiresAt: new Date(Date.now() + 10 * DAY) });
    const target = new Date(Date.now() + 60 * DAY);
    const on = target.toISOString().slice(0, 10);
    const clientKey = randomUUID();
    ok(await actions.extendGrant({ grantId: grant.id, newExpiresAt: on, reason: "Injury pause", clientKey }));
    ok(await actions.extendGrant({ grantId: grant.id, newExpiresAt: on, reason: "Injury pause", clientKey }));
    const ext = (await entriesOf(grant.id)).filter((e) => e.kind === "extend");
    expect(ext).toHaveLength(1);
    const [g] = await handle.db.select().from(creditGrants).where(eq(creditGrants.id, grant.id));
    expect(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Brussels" }).format(g!.expiresAt!)).toBe(on);
    expect(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Brussels", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(g!.expiresAt!)).toBe("23:59");
    expect(ext[0]!.data).toMatchObject({ old_expires_at: grant.expiresAt!.toISOString(), new_expires_at: g!.expiresAt!.toISOString() });
    expect(await eventsOf("credits.extended", grant.id)).toHaveLength(1);
    const a = await audits("credits.grant_extended", grant.id);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ oldValue: { expires_at: grant.expiresAt!.toISOString() }, newValue: { expires_at: g!.expiresAt!.toISOString() } });
    expect(await actions.extendGrant({ grantId: grant.id, newExpiresAt: new Date(Date.now() + 5 * DAY).toISOString(), reason: "Earlier", clientKey: randomUUID() })).toMatchObject({
      ok: false,
      error: { code: "validation" },
    });
  });

  it("revokeGrant writes revoke of the balance, credits.revoked and credits.grant_revoked once", async () => {
    const grant = await makeCreditGrant(handle.db, { units: 4 });
    const clientKey = randomUUID();
    expect(ok<{ revokedUnits: number }>(await actions.revokeGrant({ grantId: grant.id, reason: "Fraud suspected", clientKey })).revokedUnits).toBe(4);
    expect(ok<{ created: boolean }>(await actions.revokeGrant({ grantId: grant.id, reason: "Fraud suspected", clientKey })).created).toBe(false);
    const rev = (await entriesOf(grant.id)).filter((e) => e.kind === "revoke");
    expect(rev).toHaveLength(1);
    expect(rev[0]).toMatchObject({ quantity: -4, reason: "Fraud suspected" });
    const [g] = await handle.db.select().from(creditGrants).where(eq(creditGrants.id, grant.id));
    expect(g!.status).toBe("revoked");
    expect(await eventsOf("credits.revoked", grant.id)).toHaveLength(1);
    const a = await audits("credits.grant_revoked", grant.id);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ oldValue: { balance: 4 }, newValue: { status: "revoked", balance: 0 } });
  });

  it("transferCredits writes transfer_out, a new grant with transfer_in, both events and one audit row", async () => {
    const grant = await makeCreditGrant(handle.db, { units: 6 });
    const to = await makePerson(handle.db);
    const clientKey = randomUUID();
    const { toGrantId } = ok<{ toGrantId: string }>(await actions.transferCredits({ grantId: grant.id, toPersonId: to.id, units: 2, reason: "Gift to partner", clientKey }));
    ok(await actions.transferCredits({ grantId: grant.id, toPersonId: to.id, units: 2, reason: "Gift to partner", clientKey }));
    expect((await entriesOf(grant.id)).filter((e) => e.kind === "transfer_out")).toMatchObject([{ quantity: -2 }]);
    expect(await entriesOf(toGrantId)).toMatchObject([{ kind: "transfer_in", quantity: 2, personId: to.id }]);
    const [t] = await handle.db.select().from(creditGrants).where(eq(creditGrants.id, toGrantId));
    expect(t).toMatchObject({ personId: to.id, source: "transfer", data: { transfer_from_grant_id: grant.id } });
    expect(await eventsOf("credits.transferred_out", grant.id)).toHaveLength(1);
    expect(await eventsOf("credits.transferred_in", toGrantId)).toHaveLength(1);
    const a = await audits("credits.transferred", grant.id);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ oldValue: { balance: 6 }, newValue: { balance: 4, units: 2, to_grant_id: toGrantId } });
    expect(await actions.transferCredits({ grantId: grant.id, toPersonId: grant.personId, units: 1, reason: "Self", clientKey: randomUUID() })).toMatchObject({ ok: false, error: { code: "validation" } });
  });

  it("updateGrantNote stores the note and audits credits.note_changed without the text", async () => {
    const grant = await makeCreditGrant(handle.db, { units: 1 });
    ok(await actions.updateGrantNote({ grantId: grant.id, note: "Called about the refund" }));
    ok(await actions.updateGrantNote({ grantId: grant.id, note: "Called about the refund" }));
    const [g] = await handle.db.select().from(creditGrants).where(eq(creditGrants.id, grant.id));
    expect(g!.note).toBe("Called about the refund");
    const a = await audits("credits.note_changed", grant.id);
    expect(a).toHaveLength(1);
    expect(JSON.stringify(a[0]!.newValue)).not.toContain("refund");
    expect(a[0]).toMatchObject({ oldValue: { has_note: false }, newValue: { has_note: true } });
  });

  it("requestReconcile enqueues ledger.reconcile with a manual key and audits credits.reconcile_requested", async () => {
    const before = (await handle.db.select().from(jobs).where(eq(jobs.kind, "ledger.reconcile"))).length;
    const { jobId } = ok<{ jobId: string }>(await actions.requestReconcile({}));
    const [job] = await handle.db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(job).toMatchObject({ kind: "ledger.reconcile", payload: { manual: true } });
    expect(job!.idempotencyKey).toMatch(/^ledger_reconcile:manual:req_/);
    expect((await handle.db.select().from(jobs).where(eq(jobs.kind, "ledger.reconcile"))).length).toBe(before + 1);
    expect((await audits("credits.reconcile_requested")).length).toBeGreaterThanOrEqual(1);
  });

  it("bulkExtendGrants creates one row and enqueues one job, also when submitted twice", async () => {
    const soon = new Date(Date.now() + 20 * DAY);
    await makeCreditGrant(handle.db, { units: 2, source: "bonus", expiresAt: soon });
    const day = soon.toISOString().slice(0, 10);
    const input = { days: 14, reason: "Closed for works", kinds: ["day" as const], sources: ["bonus" as const], expiresFromOn: day, expiresToOn: day, clientKey: randomUUID() };
    const first = ok<{ bulkExtensionId: string; matched: number; created: boolean }>(await actions.bulkExtendGrants(input));
    expect(first).toMatchObject({ bulkExtensionId: input.clientKey, created: true });
    expect(first.matched).toBeGreaterThanOrEqual(1);
    expect(ok<{ created: boolean }>(await actions.bulkExtendGrants(input)).created).toBe(false);
    expect(await handle.db.select().from(creditBulkExtensions).where(eq(creditBulkExtensions.id, input.clientKey))).toHaveLength(1);
    expect(await handle.db.select().from(jobs).where(eq(jobs.idempotencyKey, `bulk_extend:${input.clientKey}:start`))).toMatchObject([{ kind: "credits.bulk_extend" }]);
    expect(await audits("credits.bulk_extended", input.clientKey)).toHaveLength(1);
    expect(await actions.bulkExtendGrants({ ...input, clientKey: randomUUID(), days: 120 })).toMatchObject({ ok: false, error: { code: "validation" } });
  });
});

describe("plan actions", () => {
  it("setPlanInclusion upserts an extra kind and audits old and new; the primary kind is refused", async () => {
    const plan = await makeProduct(handle.db, { kind: "membership", includedCreditKind: "day", includedCreditUnits: 4 });
    ok(await actions.setPlanInclusion({ productId: plan.id, kind: "night", unitsPerPeriod: 1, isActive: true }));
    ok(await actions.setPlanInclusion({ productId: plan.id, kind: "night", unitsPerPeriod: 2, isActive: true }));
    expect(await handle.db.select().from(membershipPlanInclusions).where(eq(membershipPlanInclusions.productId, plan.id))).toMatchObject([{ creditKind: "night", unitsPerPeriod: 2 }]);
    const a = await audits("memberships.inclusion_changed", plan.id);
    expect(a).toHaveLength(2);
    expect(a.find((r) => r.oldValue !== null)).toMatchObject({ oldValue: { units_per_period: 1 }, newValue: { units_per_period: 2 } });
    expect(await actions.setPlanInclusion({ productId: plan.id, kind: "day", unitsPerPeriod: 2, isActive: true })).toMatchObject({ ok: false, error: { code: "validation" } });
  });

  it("setPlanBenefit needs the text in all three locales; set and remove are audited", async () => {
    const plan = await makeProduct(handle.db, { kind: "membership", includedCreditKind: "day", includedCreditUnits: 4 });
    expect(await actions.setPlanBenefit({ productId: plan.id, kind: "other", text: { "nl-BE": "Gratis thee", en: "Free tea" }, sortOrder: 1, isActive: true })).toMatchObject({
      ok: false,
      error: { code: "validation" },
    });
    const { benefitId } = ok<{ benefitId: string }>(await actions.setPlanBenefit({ productId: plan.id, kind: "other", text, sortOrder: 1, isActive: true }));
    ok(await actions.setPlanBenefit({ productId: plan.id, benefitId, kind: "event_access", text, sortOrder: 2, isActive: true }));
    expect(await handle.db.select().from(membershipPlanBenefits).where(eq(membershipPlanBenefits.productId, plan.id))).toMatchObject([{ kind: "event_access", sortOrder: 2 }]);
    ok(await actions.removePlanBenefit({ benefitId }));
    expect(await handle.db.select().from(membershipPlanBenefits).where(eq(membershipPlanBenefits.productId, plan.id))).toHaveLength(0);
    const a = await audits("memberships.benefit_changed", benefitId);
    expect(a).toHaveLength(3);
    expect(a.filter((r) => r.newValue === null)).toHaveLength(1);
  });
});

describe("membership actions", () => {
  it("cancelMembership at period end sets cancel_at, records the event, audits and queues the confirmation email", async () => {
    const m = await makeMembership(handle.db);
    const r = ok<{ mode: string; version: number }>(await actions.cancelMembership({ membershipId: m.id, mode: "period_end", reason: "Moving abroad", version: m.version }));
    expect(r.mode).toBe("period_end");
    const [row] = await handle.db.select().from(memberships).where(eq(memberships.id, m.id));
    expect(row!.cancelAt!.getTime()).toBe(m.currentPeriodEndAt.getTime());
    expect(row!.version).toBe(m.version + 1);
    expect(await eventsOf("membership.cancel_requested", m.id)).toHaveLength(1);
    expect(await audits("memberships.cancel_requested", m.id)).toMatchObject([{ oldValue: { cancel_at: null }, newValue: { cancel_at: m.currentPeriodEndAt.toISOString() } }]);
    const mails = (await handle.db.select().from(jobs).where(eq(jobs.kind, "email.send"))).filter((j) => j.idempotencyKey.includes(m.id));
    expect(mails.map((j) => (j.payload as { template: string }).template)).toEqual(["credits.membership_cancel_confirmed"]);

    expect(await actions.cancelMembership({ membershipId: m.id, mode: "now", reason: "Stale form", version: m.version })).toMatchObject({ ok: false, error: { code: "conflict" } });
    const resumed = ok<{ version: number }>(await actions.resumeMembership({ membershipId: m.id, version: row!.version }));
    expect(resumed.version).toBe(row!.version + 1);
    expect(await eventsOf("membership.resumed", m.id)).toHaveLength(1);
    expect(await audits("memberships.resumed", m.id)).toHaveLength(1);
  });

  it("cancelMembership now ends a past-due membership with cancelled_by_staff; period_end is refused for it", async () => {
    const m = await makeMembership(handle.db, { status: "past_due", dunningAttempt: 1, pastDueSinceAt: new Date() });
    expect(await actions.cancelMembership({ membershipId: m.id, mode: "period_end", reason: "Unpaid", version: m.version })).toMatchObject({ ok: false, error: { code: "conflict" } });
    ok(await actions.cancelMembership({ membershipId: m.id, mode: "now", reason: "Unpaid", version: m.version }));
    const [row] = await handle.db.select().from(memberships).where(eq(memberships.id, m.id));
    expect(row).toMatchObject({ status: "cancelled", endReason: "cancelled_by_staff" });
    expect(await eventsOf("membership.cancelled", m.id)).toHaveLength(1);
    expect(await audits("memberships.cancelled_now", m.id)).toMatchObject([{ oldValue: { status: "past_due" }, newValue: { status: "cancelled" } }]);
    expect(await actions.cancelMembership({ membershipId: m.id, mode: "now", reason: "Missing reason", version: 1 })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(await actions.cancelMembership({ membershipId: m.id, mode: "now", reason: "x", version: row!.version })).toMatchObject({ ok: false, error: { code: "validation" } });
  });

  it("extendMembershipPeriod writes a staff_extension period, the event and the audit once per clientKey", async () => {
    const m = await makeMembership(handle.db);
    const clientKey = randomUUID();
    const r = ok<{ created: boolean; periodEndAt: string }>(await actions.extendMembershipPeriod({ membershipId: m.id, days: 14, reason: "Injury", alsoExtendInclusions: false, clientKey, version: m.version }));
    expect(r.created).toBe(true);
    expect(ok<{ created: boolean }>(await actions.extendMembershipPeriod({ membershipId: m.id, days: 14, reason: "Injury", alsoExtendInclusions: false, clientKey, version: m.version })).created).toBe(false);
    expect(await handle.db.select().from(membershipPeriods).where(and(eq(membershipPeriods.membershipId, m.id), eq(membershipPeriods.source, "staff_extension")))).toHaveLength(1);
    expect(await eventsOf("membership.period_extended", m.id)).toHaveLength(1);
    expect(await audits("memberships.period_extended", m.id)).toMatchObject([{ oldValue: { current_period_end_at: m.currentPeriodEndAt.toISOString() } }]);
    expect(await actions.extendMembershipPeriod({ membershipId: m.id, days: 3, reason: "Holiday", alsoExtendInclusions: false, clientKey: randomUUID(), version: m.version })).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
  });

  it("retryRenewalCharge enqueues memberships.charge_renewal for a past-due member with a mandate and audits it", async () => {
    const m = await makeMembership(handle.db, { status: "past_due", dunningAttempt: 1, pastDueSinceAt: new Date() });
    expect(await actions.retryRenewalCharge({ membershipId: m.id })).toMatchObject({ ok: false, error: { code: "conflict", message: "no_mandate" } });
    fx.mandate = { mandateId: randomUUID(), method: "directdebit", summary: null };
    const { jobId, attempt } = ok<{ jobId: string; attempt: number }>(await actions.retryRenewalCharge({ membershipId: m.id }));
    expect(attempt).toBe(2);
    const [job] = await handle.db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(job).toMatchObject({ kind: "memberships.charge_renewal", payload: { membershipId: m.id, attempt: 2 } });
    expect(job!.idempotencyKey).toMatch(new RegExp(`^renewal:${m.id}:\\d{4}-\\d{2}-\\d{2}:manual:req_`));
    expect(await audits("memberships.charge_retried", m.id)).toMatchObject([{ oldValue: { dunning_attempt: 1 }, newValue: { attempt: 2 } }]);
    const active = await makeMembership(handle.db);
    expect(await actions.retryRenewalCharge({ membershipId: active.id })).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("updateMembershipNotes bumps the version, audits without the text and refuses a stale version", async () => {
    const m = await makeMembership(handle.db);
    const r = ok<{ version: number }>(await actions.updateMembershipNotes({ membershipId: m.id, notes: "Prefers the sauna at 7", version: m.version }));
    expect(r.version).toBe(m.version + 1);
    expect(await actions.updateMembershipNotes({ membershipId: m.id, notes: "Other", version: m.version })).toMatchObject({ ok: false, error: { code: "conflict", message: "stale_version" } });
    const a = await audits("memberships.notes_changed", m.id);
    expect(a).toHaveLength(1);
    expect(JSON.stringify(a[0])).not.toContain("sauna");
  });
});
