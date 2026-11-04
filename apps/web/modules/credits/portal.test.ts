/**
 * credits-P7 customer portal (credits spec sections 4, 5 and 8, rules 36 to 38 and 53): the
 * customer sees only their own and shared grants; a foreign grant is `not_found`; a guest shows as
 * first name and initial with the attendance status; staff reasons never reach the customer; a
 * store-credit balance lists the orders it paid; the membership page data and the three customer
 * membership actions (own membership only, customer actor in the audit); the portal wording never
 * says "credit" in any locale. Commerce and email are mocked to their contracts (CONVENTIONS 11).
 */
import { randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson, makeSession, makeUser } from "@beam/db/testing";
import { makeOrder } from "@beam/db/testing/commerce-factories";
import { makeCreditGrant, makeEntry, makeMembership } from "@beam/db/testing/credits-factories";
import type { DbHandle } from "@beam/db";
import { auditLog, bookings, membershipPlanBenefits, memberships, packageShares } from "@beam/db/schema";
import { LOCALES, messagesFor, t } from "@beam/core/i18n";
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
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.46" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));

const fx = vi.hoisted(() => ({
  startPayment: [] as { orderId: string; returnPath?: string }[],
  cancelledOrders: [] as string[],
  orderStatus: "pending_payment",
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
  getOrderStatus: () => Promise.resolve({ status: fx.orderStatus, paidAt: null, dueCents: 4500 }),
  startPayment: (_tx: unknown, _ctx: unknown, input: { orderId: string; returnPath?: string }) => {
    fx.startPayment.push(input);
    return Promise.resolve({ paymentId: randomUUID(), redirectUrl: `https://pay.example.com/${input.orderId}` });
  },
  cancelRenewalOrder: (_tx: unknown, _ctx: unknown, input: { orderId: string }) => {
    fx.cancelledOrders.push(input.orderId);
    return Promise.resolve({ cancelled: true });
  },
}));

const actions = await import("./actions");
const queries = await import("./queries");
const { UsageHistory } = await import("./ui/usage-history");
const { createAuthSession, SESSION_COOKIE } = await import("@/lib/auth");
const { and, eq, setAppDb } = await import("@/lib/ctx");
const { resetRuntime } = await import("@/lib/testing");

let h: DbHandle;
let me: { personId: string; userId: string };
const DAY = 86_400_000;

type Ok<T> = { ok: true; data: T };
function ok<T>(r: unknown): T {
  expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
  return (r as Ok<T>).data;
}

beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  jar.clear();
  fx.startPayment = [];
  fx.cancelledOrders = [];
  fx.orderStatus = "pending_payment";
  fx.mandate = null;
  const email = `p7-${randomUUID().slice(0, 8)}@example.com`;
  const p = await makePerson(h.db, { email, firstName: "Mira", lastName: "Janssens" });
  const user = await makeUser(h.db, { audience: "customer", email, personId: p.id, roleKey: null });
  const { token } = await createAuthSession(h.db, { userId: user.id, audience: "customer", roleKey: null, now: new Date() });
  jar.set(SESSION_COOKIE, token);
  me = { personId: p.id, userId: user.id };
});

async function booking(personId: string, status: "confirmed" | "attended" | "no_show" | "cancelled", startsAt: Date) {
  const session = await makeSession(h.db, { startsAt });
  const extra =
    status === "attended"
      ? { attendedAt: startsAt }
      : status === "no_show"
        ? { noShowMarkedAt: startsAt }
        : status === "cancelled"
          ? { cancelledAt: new Date(), cancelReasonCode: "customer" as const }
          : {};
  const [b] = await h.db.insert(bookings).values({ sessionId: session.id, personId, status, paidWith: "credit", source: "portal", ...extra }).returning();
  return b!;
}

describe("getMyPackages", () => {
  it("lists only the reader's own grants (active, upcoming, history, one store-credit total) and grants shared with them", async () => {
    const active = await makeCreditGrant(h.db, { personId: me.personId, units: 10, creditKind: "day" });
    const later = await makeCreditGrant(h.db, { personId: me.personId, units: 2, creditKind: "night", startsAt: new Date(Date.now() + 5 * DAY), expiresAt: new Date(Date.now() + 60 * DAY) });
    const gone = await makeCreditGrant(h.db, { personId: me.personId, units: 1, status: "expired", startsAt: new Date(Date.now() - 100 * DAY), expiresAt: new Date(Date.now() - DAY) });
    await makeCreditGrant(h.db, { personId: me.personId, creditKind: "euro", units: 3500, expiresAt: new Date(Date.now() + 30 * DAY) });
    await makeCreditGrant(h.db, { personId: me.personId, creditKind: "euro", units: 1500, expiresAt: null });
    const owner = await makePerson(h.db, { firstName: "Anna", lastName: "de Smet" });
    const shared = await makeCreditGrant(h.db, { personId: owner.id, units: 5, sharing: { mode: "named", max_guest_uses_per_month: 0, allowed_person_ids: [me.personId] } });
    await h.db.insert(packageShares).values({ grantId: shared.id, sharedWithPersonId: me.personId, maxUnits: 3, createdByPersonId: owner.id });
    const foreign = await makeCreditGrant(h.db, { units: 4 });

    const d = await queries.getMyPackages(h.db, me.personId);
    expect(d.active.map((g) => g.grantId)).toEqual([active.id]);
    expect(d.active[0]).toMatchObject({ remainingUnits: 10, baseUnits: 10, kind: "day" });
    expect(d.upcoming.map((g) => g.grantId)).toEqual([later.id]);
    expect(d.history.map((g) => g.grantId)).toEqual([gone.id]);
    expect(d.storeCredit.remainingCents).toBe(5000);
    expect(d.storeCredit.grants).toHaveLength(2);
    expect(d.storeCredit.earliestExpiresAt!.getTime()).toBeLessThan(Date.now() + 31 * DAY);
    expect(d.sharedWithMe).toMatchObject([{ grantId: shared.id, ownerName: "Anna D.", maxUnits: 3, usedByMe: 0, unitsForMe: 3 }]);
    const all = [...d.active, ...d.upcoming, ...d.history, ...d.storeCredit.grants, ...d.sharedWithMe].map((g) => g.grantId);
    expect(all).not.toContain(foreign.id);
    expect(JSON.stringify(d)).not.toMatch(/unitValueCents|vatTreatment|note/);

    expect(await queries.listGrantsSharedWith(h.db, me.personId)).toHaveLength(1);
    await h.db.update(packageShares).set({ status: "revoked", revokedAt: new Date() }).where(eq(packageShares.grantId, shared.id));
    expect(await queries.listGrantsSharedWith(h.db, me.personId)).toHaveLength(0);
  });
});

describe("getMyPackage", () => {
  it("a foreign grant is not_found; a shared grant shows only the reader's own uses", async () => {
    const foreign = await makeCreditGrant(h.db, { units: 4 });
    await expect(queries.getMyPackage(h.db, me.personId, foreign.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(queries.getMyPackage(h.db, me.personId, randomUUID())).rejects.toMatchObject({ code: "not_found" });
    await expect(queries.getMyPackage(h.db, me.personId, "nope")).rejects.toMatchObject({ code: "not_found" });

    const owner = await makePerson(h.db, { firstName: "Anna", lastName: "de Smet" });
    const shared = await makeCreditGrant(h.db, { personId: owner.id, units: 5 });
    await makeEntry(h.db, { grantId: shared.id, kind: "consume", quantity: -1, beneficiaryPersonId: owner.id });
    await expect(queries.getMyPackage(h.db, me.personId, shared.id)).rejects.toMatchObject({ code: "not_found" });
    await h.db.insert(packageShares).values({ grantId: shared.id, sharedWithPersonId: me.personId, createdByPersonId: owner.id });
    const b = await booking(me.personId, "confirmed", new Date(Date.now() + 2 * DAY));
    await makeEntry(h.db, { grantId: shared.id, kind: "consume", quantity: -1, beneficiaryPersonId: me.personId, refType: "booking", refId: b.id });
    const d = await queries.getMyPackage(h.db, me.personId, shared.id);
    expect(d).toMatchObject({ isOwner: false, ownerName: "Anna D." });
    expect(d.usage).toHaveLength(1);
    expect(d.usage[0]).toMatchObject({ kind: "use", usedBy: { you: true }, attendance: "upcoming" });
  });

  it("the owner sees guests as first name and initial with attendance, generic BEAM lines and no staff reasons", async () => {
    const grant = await makeCreditGrant(h.db, { personId: me.personId, units: 10, sharing: { mode: "guests", max_guest_uses_per_month: 2, allowed_person_ids: [] } });
    const guest = await makePerson(h.db, { firstName: "Gita", lastName: "van Gast" });
    const attended = await booking(guest.id, "attended", new Date(Date.now() - 2 * DAY));
    const noShow = await booking(guest.id, "no_show", new Date(Date.now() - DAY));
    const cancelled = await booking(me.personId, "cancelled", new Date(Date.now() + 3 * DAY));
    await makeEntry(h.db, { grantId: grant.id, kind: "consume", quantity: -1, beneficiaryPersonId: guest.id, refType: "booking", refId: attended.id });
    await makeEntry(h.db, { grantId: grant.id, kind: "consume", quantity: -1, beneficiaryPersonId: guest.id, refType: "booking", refId: noShow.id });
    const mine = await makeEntry(h.db, { grantId: grant.id, kind: "consume", quantity: -1, beneficiaryPersonId: me.personId, refType: "booking", refId: cancelled.id });
    await makeEntry(h.db, { grantId: grant.id, kind: "release", quantity: 1, beneficiaryPersonId: me.personId, reversesEntryId: mine.id, refType: "booking", refId: cancelled.id });
    await makeEntry(h.db, { grantId: grant.id, kind: "adjust", quantity: -1, reason: "Secret staff reason" });
    await makeEntry(h.db, { grantId: grant.id, kind: "extend", data: { old_expires_at: null, new_expires_at: "2027-06-30T21:59:59.999Z" } });

    const d = await queries.getMyPackage(h.db, me.personId, grant.id);
    expect(d.isOwner).toBe(true);
    expect(d.package).toMatchObject({ remainingUnits: 7, baseUnits: 10 });
    const uses = d.usage.filter((u) => u.kind === "use");
    expect(uses.map((u) => [u.usedBy, u.attendance, u.returned])).toEqual(
      expect.arrayContaining([
        [{ you: false, name: "Gita V." }, "attended", false],
        [{ you: false, name: "Gita V." }, "no_show", false],
        [{ you: true }, "cancelled", true],
      ]),
    );
    expect(d.usage.map((u) => u.kind)).toEqual(expect.arrayContaining(["returned", "adjusted", "extended"]));
    expect(d.usage.find((u) => u.kind === "extended")!.newExpiresAt!.toISOString()).toBe("2027-06-30T21:59:59.999Z");
    expect(d.guestUsesLeft).toBe(0);
    expect(JSON.stringify(d)).not.toContain("Secret staff reason");
    expect(JSON.stringify(d)).not.toContain("van Gast");

    const html = renderToStaticMarkup(UsageHistory({ detail: d, locale: "en" }));
    expect(html).toContain("Gita V. (guest)");
    expect(html).toContain("Attended");
    expect(html).toContain("No-show");
    expect(html).toContain("Adjusted by BEAM");
    expect(html).toContain("Returned on cancellation");
    expect(html).not.toContain("Secret staff reason");
  });

  it("a store-credit balance lists the orders it paid, without released payments", async () => {
    const grant = await makeCreditGrant(h.db, { personId: me.personId, creditKind: "euro", units: 5000 });
    const order = await makeOrder(h.db, { personId: me.personId, status: "paid" });
    const back = await makeOrder(h.db, { personId: me.personId, status: "cancelled" });
    await makeEntry(h.db, { grantId: grant.id, kind: "consume", quantity: -2000, refType: "order", refId: order.id });
    const r = await makeEntry(h.db, { grantId: grant.id, kind: "consume", quantity: -500, refType: "order", refId: back.id });
    await makeEntry(h.db, { grantId: grant.id, kind: "release", quantity: 500, reversesEntryId: r.id, refType: "order", refId: back.id });
    const d = await queries.getMyPackage(h.db, me.personId, grant.id);
    expect(d.package.remainingUnits).toBe(3000);
    expect(d.orders).toHaveLength(1);
    expect(d.orders[0]).toMatchObject({ orderId: order.id, reference: order.reference, amountCents: 2000 });
    expect((await queries.getMyPackages(h.db, me.personId)).storeCredit.remainingCents).toBe(3000);
  });
});

describe("getMyMembership", () => {
  it("is null without a membership and shows plan, inclusions, benefits and actions for a live one", async () => {
    expect(await queries.getMyMembership(h.db, me.personId)).toBeNull();
    const m = await makeMembership(h.db, { personId: me.personId, discountPct: "10.00" });
    await makeCreditGrant(h.db, { personId: me.personId, source: "membership", membershipId: m.id, units: 4, startsAt: m.currentPeriodStartAt, expiresAt: m.currentPeriodEndAt });
    await h.db.insert(membershipPlanBenefits).values([
      { productId: m.productId, kind: "discount", text: { en: "10 % off", "nl-BE": "10 % korting", "fr-BE": "10 % de réduction" }, sortOrder: 1 },
      { productId: m.productId, kind: "other", text: { en: "Hidden", "nl-BE": "Verborgen", "fr-BE": "Caché" }, isActive: false },
    ]);
    const v = (await queries.getMyMembership(h.db, me.personId))!;
    expect(v).toMatchObject({ membershipId: m.id, status: "active", discountPct: 10, canCancel: true, canResume: false, canPay: false });
    expect(v.included).toMatchObject([{ kind: "day", remainingUnits: 4, baseUnits: 4 }]);
    expect(v.benefits.map((b) => b.text.en)).toEqual(["10 % off"]);
    expect(v.nextRenewalAt!.getTime()).toBe(m.currentPeriodEndAt.getTime());
  });

  it("offers pay now for a past_due membership with an open renewal order", async () => {
    const order = await makeOrder(h.db, { personId: me.personId, status: "pending_payment", totalCents: 4500 });
    await makeMembership(h.db, { personId: me.personId, status: "past_due", renewalOrderId: order.id, dunningAttempt: 1, pastDueSinceAt: new Date() });
    const v = (await queries.getMyMembership(h.db, me.personId))!;
    expect(v).toMatchObject({ status: "past_due", canPay: true, renewalAmountCents: 4500 });
  });
});

describe("customer membership actions", () => {
  it("cancelMyMembership sets cancel_at at period end with a customer-actor audit; resume clears it", async () => {
    const m = await makeMembership(h.db, { personId: me.personId });
    const r = ok<{ mode: string; version: number; endsAt: string }>(await actions.cancelMyMembership({ membershipId: m.id, version: m.version }));
    expect(r.mode).toBe("period_end");
    expect(r.endsAt).toBe(m.currentPeriodEndAt.toISOString());
    const [row] = await h.db.select().from(memberships).where(eq(memberships.id, m.id));
    expect(row!.cancelAt!.getTime()).toBe(m.currentPeriodEndAt.getTime());
    const audits = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "memberships.cancel_requested"), eq(auditLog.entityId, m.id)));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actor).toMatchObject({ kind: "customer" });

    expect(await actions.cancelMyMembership({ membershipId: m.id, version: m.version })).toMatchObject({ ok: false, error: { code: "conflict", message: "stale_version" } });
    ok(await actions.resumeMyMembership({ membershipId: m.id, version: r.version }));
    const [after] = await h.db.select().from(memberships).where(eq(memberships.id, m.id));
    expect(after!.cancelAt).toBeNull();
  });

  it("a past_due membership ends at once with cancelled_by_customer and its renewal order cancelled", async () => {
    const order = await makeOrder(h.db, { personId: me.personId, status: "pending_payment" });
    const m = await makeMembership(h.db, { personId: me.personId, status: "past_due", renewalOrderId: order.id, dunningAttempt: 1, pastDueSinceAt: new Date() });
    const r = ok<{ mode: string; status: string }>(await actions.cancelMyMembership({ membershipId: m.id, version: m.version }));
    expect(r).toMatchObject({ mode: "now", status: "cancelled" });
    const [row] = await h.db.select().from(memberships).where(eq(memberships.id, m.id));
    expect(row).toMatchObject({ status: "cancelled", endReason: "cancelled_by_customer" });
    expect(fx.cancelledOrders).toEqual([order.id]);
  });

  it("another person's membership is not_found for every customer action", async () => {
    const other = await makeMembership(h.db, {});
    expect(await actions.cancelMyMembership({ membershipId: other.id, version: other.version })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await actions.resumeMyMembership({ membershipId: other.id, version: other.version })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await actions.payMyRenewal({ membershipId: other.id })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await actions.payMyRenewal({ membershipId: randomUUID() })).toMatchObject({ ok: false, error: { code: "not_found" } });
    const [row] = await h.db.select().from(memberships).where(eq(memberships.id, other.id));
    expect(row!.cancelAt).toBeNull();
  });

  it("payMyRenewal starts commerce's payment of the open renewal order; nothing to pay otherwise", async () => {
    const order = await makeOrder(h.db, { personId: me.personId, status: "pending_payment" });
    const m = await makeMembership(h.db, { personId: me.personId, status: "past_due", renewalOrderId: order.id, dunningAttempt: 1, pastDueSinceAt: new Date() });
    expect(ok<{ redirectUrl: string }>(await actions.payMyRenewal({ membershipId: m.id }))).toEqual({ redirectUrl: `https://pay.example.com/${order.id}` });
    expect(fx.startPayment).toEqual([{ orderId: order.id, returnPath: "/account/membership" }]);

    fx.orderStatus = "paid";
    expect(await actions.payMyRenewal({ membershipId: m.id })).toMatchObject({ ok: false, error: { code: "conflict", message: "nothing_to_pay" } });
    await h.db.update(memberships).set({ status: "cancelled", endReason: "cancelled_by_customer", endedAt: new Date(), renewalOrderId: null }).where(eq(memberships.id, m.id));
    const active = await makeMembership(h.db, { personId: me.personId });
    expect(await actions.payMyRenewal({ membershipId: active.id })).toMatchObject({ ok: false, error: { code: "conflict", message: "nothing_to_pay" } });
  });

  it("a staff session cannot call the customer actions", async () => {
    const m = await makeMembership(h.db, { personId: me.personId });
    const staff = await makeUser(h.db, { roleKey: "owner" });
    const { token } = await createAuthSession(h.db, { userId: staff.id, audience: "staff", roleKey: "owner", now: new Date(), mfaAt: new Date() });
    jar.set(SESSION_COOKIE, token);
    const r = await actions.cancelMyMembership({ membershipId: m.id, version: m.version });
    expect(r.ok).toBe(false);
  });
});

describe("portal wording (rule 36)", () => {
  const SAMPLE = { count: 2, remaining: 3, total: 10, amount: "€ 35,00", date: "31/12/2026", name: "Anna D.", from: "1/1/2026", to: "31/1/2026", plan: "Plan", pct: "10", method: "SEPA" };

  function strings(node: unknown, path: string, out: [string, string][]) {
    if (typeof node === "string") out.push([path, node]);
    else if (node && typeof node === "object") for (const [k, v] of Object.entries(node)) strings(v, `${path}.${k}`, out);
  }

  it.each(LOCALES)("credits.units.* and credits.portal.* never say 'credit' in %s (the euro balance keeps its name 'store credit')", (locale) => {
    const tree = (messagesFor(locale, ["credits"]).credits ?? {}) as Record<string, unknown>;
    const keys: [string, string][] = [];
    strings(tree.units, "credits.units", keys);
    strings(tree.portal, "credits.portal", keys);
    expect(keys.length).toBeGreaterThan(50);
    for (const [key] of keys) {
      const rendered = t(locale, key, SAMPLE);
      const plain = rendered.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replaceAll("store credit", "");
      expect(plain, `${key}: ${rendered}`).not.toContain("credit");
    }
  });
});
