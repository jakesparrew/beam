/**
 * credits-P6 action permissions (credits spec section 7): every grant action needs
 * `credits.adjust`, every plan and membership action `memberships.write`; staff without it are
 * refused with `forbidden` before anything is written (one audit row per allowed staff action is
 * asserted in `actions.test.ts`). Reception (default grants) reads balances (`credits.read`) but
 * cannot adjust; a customer session and no session are `unauthorized`.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makeUser } from "@beam/db/testing";
import { makeCreditGrant, makeMembership } from "@beam/db/testing/credits-factories";
import { DEFAULT_ROLE_GRANTS } from "@beam/db/seed/platform";
import type { DbHandle } from "@beam/db";
import { auditLog, creditBulkExtensions, creditEntries, creditSharingReviews, packageShares, roles } from "@beam/db/schema";
import type { RoleKey } from "@beam/db/schema";
import { permissions } from "./permissions";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.44" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));

const actions = await import("./actions");
const { createAuthSession, SESSION_COOKIE } = await import("@/lib/auth");
const { actorHasPermission, eq, setAppDb } = await import("@/lib/ctx");
const { resetRuntime, staffActor } = await import("@/lib/testing");

let handle: DbHandle;

async function asStaff(roleKey: RoleKey, perms: readonly string[]) {
  const user = await makeUser(handle.db, { roleKey });
  await handle.db.update(roles).set({ permissions: [...perms] }).where(eq(roles.key, roleKey));
  const { token } = await createAuthSession(handle.db, { userId: user.id, audience: "staff", roleKey, now: new Date(), mfaAt: new Date() });
  jar.set(SESSION_COOKIE, token);
  return user;
}

async function asCustomer() {
  const user = await makeUser(handle.db, { audience: "customer" });
  const { token } = await createAuthSession(handle.db, { userId: user.id, audience: "customer", roleKey: null, now: new Date() });
  jar.set(SESSION_COOKIE, token);
}

beforeAll(async () => {
  handle = await createTestDb();
  setAppDb(handle.db);
});
afterAll(async () => {
  resetRuntime();
  await handle.close();
});
beforeEach(() => jar.clear());

const forbidden = { ok: false, error: { code: "forbidden" } };
const unauthorized = { ok: false, error: { code: "unauthorized" } };
const label = { "nl-BE": "Cadeau", "fr-BE": "Cadeau", en: "Gift" };
const text = { "nl-BE": "Voordeel", "fr-BE": "Avantage", en: "Benefit" };

type Call = [label: string, run: () => Promise<unknown>];

async function grantCalls(): Promise<Call[]> {
  const grant = await makeCreditGrant(handle.db, { units: 5 });
  const other = await makeCreditGrant(handle.db, { units: 1 });
  const key = () => randomUUID();
  return [
    ["createGrant", () => actions.createGrant({ personId: grant.personId, kind: "day", units: 1, source: "bonus", label, validityDays: 30, reason: "Goodwill", clientKey: key() })],
    ["adjustGrant", () => actions.adjustGrant({ grantId: grant.id, quantity: -1, reason: "Correction", clientKey: key() })],
    ["extendGrant", () => actions.extendGrant({ grantId: grant.id, newExpiresAt: new Date(Date.now() + 400 * 86_400_000).toISOString(), reason: "Injury", clientKey: key() })],
    ["revokeGrant", () => actions.revokeGrant({ grantId: grant.id, reason: "Fraud", clientKey: key() })],
    ["transferCredits", () => actions.transferCredits({ grantId: grant.id, toPersonId: other.personId, units: 1, reason: "Family", clientKey: key() })],
    ["updateGrantNote", () => actions.updateGrantNote({ grantId: grant.id, note: "Called the customer" })],
    ["requestReconcile", () => actions.requestReconcile({})],
    ["bulkExtendGrants", () => actions.bulkExtendGrants({ days: 7, reason: "Works", kinds: ["day"], sources: ["purchase"], expiresFromOn: "2026-01-01", expiresToOn: "2027-12-31", clientKey: key() })],
    ["findCreditPersons", () => actions.findCreditPersons({ q: "test" })],
  ];
}

async function membershipCalls(): Promise<Call[]> {
  const m = await makeMembership(handle.db);
  return [
    ["setPlanInclusion", () => actions.setPlanInclusion({ productId: m.productId, kind: "night", unitsPerPeriod: 1, isActive: true })],
    ["setPlanBenefit", () => actions.setPlanBenefit({ productId: m.productId, kind: "other", text, sortOrder: 1, isActive: true })],
    ["removePlanBenefit", () => actions.removePlanBenefit({ benefitId: randomUUID() })],
    ["cancelMembership", () => actions.cancelMembership({ membershipId: m.id, mode: "now", reason: "Moved away", version: m.version })],
    ["resumeMembership", () => actions.resumeMembership({ membershipId: m.id, version: m.version })],
    ["extendMembershipPeriod", () => actions.extendMembershipPeriod({ membershipId: m.id, days: 14, reason: "Injury", alsoExtendInclusions: false, clientKey: randomUUID(), version: m.version })],
    ["retryRenewalCharge", () => actions.retryRenewalCharge({ membershipId: m.id })],
    ["updateMembershipNotes", () => actions.updateMembershipNotes({ membershipId: m.id, notes: "Prefers mornings", version: m.version })],
  ];
}

async function writes() {
  const [entries, audits, bulk] = await Promise.all([
    handle.db.select({ id: creditEntries.id }).from(creditEntries),
    handle.db.select({ id: auditLog.id }).from(auditLog),
    handle.db.select({ id: creditBulkExtensions.id }).from(creditBulkExtensions),
  ]);
  return { entries: entries.length, audits: audits.length, bulk: bulk.length };
}

describe("credits declares its permissions", () => {
  it("lists credits.read, credits.adjust and memberships.write", () => {
    expect([...permissions]).toEqual(expect.arrayContaining(["credits.read", "credits.adjust", "memberships.write"]));
  });
});

describe("credits.adjust actions", () => {
  it("refuses each grant action without credits.adjust, before writing", async () => {
    const list = await grantCalls();
    await asStaff("finance", ["credits.read", "memberships.write", "persons.read"]);
    const before = await writes();
    for (const [name, run] of list) expect(await run(), name).toMatchObject(forbidden);
    expect(await writes()).toEqual(before);
  });

  it("lets reception read balances but refuses every adjustment", async () => {
    const reception = DEFAULT_ROLE_GRANTS.reception;
    expect(actorHasPermission(staffActor({ roleKey: "reception", permissions: reception }), "credits.read")).toBe(true);
    expect(actorHasPermission(staffActor({ roleKey: "reception", permissions: reception }), "credits.adjust")).toBe(false);
    const list = [...(await grantCalls()), ...(await membershipCalls())];
    await asStaff("reception", reception);
    const before = await writes();
    for (const [name, run] of list) expect(await run(), name).toMatchObject(forbidden);
    expect(await writes()).toEqual(before);
  });

  it("answers unauthorized for a customer and for no session", async () => {
    const list = [...(await grantCalls()), ...(await membershipCalls())];
    await asCustomer();
    for (const [name, run] of list) expect(await run(), name).toMatchObject(unauthorized);
    jar.clear();
    for (const [name, run] of list) expect(await run(), name).toMatchObject(unauthorized);
  });

  it("lets staff with credits.adjust through", async () => {
    const grant = await makeCreditGrant(handle.db, { units: 5 });
    await asStaff("customer_service", ["credits.read", "credits.adjust"]);
    expect(await actions.adjustGrant({ grantId: grant.id, quantity: -1, reason: "Correction", clientKey: randomUUID() })).toMatchObject({ ok: true, data: { oldBalance: 5, newBalance: 4 } });
    expect(await actions.setPlanInclusion({ productId: randomUUID(), kind: "night", unitsPerPeriod: 1, isActive: true })).toMatchObject(forbidden);
  });
});

// credits-P8 (R2): the sharing actions. Staff variants need credits.adjust; the customer variants
// act only on the reader's own grants (a foreign grant or share is not_found).
async function sharingCalls(): Promise<Call[]> {
  const grant = await makeCreditGrant(handle.db, { units: 5, sharing: { mode: "named", max_guest_uses_per_month: 0, allowed_person_ids: [] } });
  const sharee = await makeUser(handle.db, { audience: "customer" });
  const [share] = await handle.db.insert(packageShares).values({ grantId: grant.id, sharedWithPersonId: sharee.personId!, createdByPersonId: grant.personId }).returning();
  return [
    ["updateGrantSharing", () => actions.updateGrantSharing({ grantId: grant.id, mode: "guests", maxGuestUsesPerMonth: 2 })],
    ["addPackageShare", () => actions.addPackageShare({ grantId: grant.id, email: `staff-share-${randomUUID().slice(0, 8)}@example.com`, firstName: "Lien" })],
    ["revokePackageShare", () => actions.revokePackageShare({ shareId: share!.id })],
    ["reviewSharing", () => actions.reviewSharing({ rule: "many_guests", grantId: grant.id, decision: "ok" })],
  ];
}

async function writesWithShares() {
  const [base, shares, reviews] = await Promise.all([
    writes(),
    handle.db.select({ id: packageShares.id, status: packageShares.status }).from(packageShares),
    handle.db.select({ id: creditSharingReviews.id }).from(creditSharingReviews),
  ]);
  return { ...base, shares: shares.map((s) => `${s.id}:${s.status}`).sort(), reviews: reviews.length };
}

describe("sharing actions (R2)", () => {
  it("lists credits.adjust as the permission of every staff sharing action and refuses staff without it, before writing", async () => {
    const list = await sharingCalls();
    await asStaff("finance", ["credits.read", "memberships.write", "persons.read"]);
    const before = await writesWithShares();
    for (const [name, run] of list) expect(await run(), name).toMatchObject(forbidden);
    expect(await writesWithShares()).toEqual(before);
  });

  it("refuses reception, a customer session and no session on the staff sharing actions", async () => {
    const list = await sharingCalls();
    await asStaff("reception", DEFAULT_ROLE_GRANTS.reception);
    for (const [name, run] of list) expect(await run(), name).toMatchObject(forbidden);
    await asCustomer();
    for (const [name, run] of list) expect(await run(), name).toMatchObject(unauthorized);
    jar.clear();
    for (const [name, run] of list) expect(await run(), name).toMatchObject(unauthorized);
  });

  it("lets staff with credits.adjust change sharing, with one audit row", async () => {
    const grant = await makeCreditGrant(handle.db, { units: 5 });
    await asStaff("customer_service", ["credits.read", "credits.adjust"]);
    expect(await actions.updateGrantSharing({ grantId: grant.id, mode: "guests", maxGuestUsesPerMonth: 3 })).toMatchObject({ ok: true, data: { sharing: { mode: "guests", max_guest_uses_per_month: 3 } } });
    expect(await handle.db.select().from(auditLog).where(eq(auditLog.entityId, grant.id))).toEqual([expect.objectContaining({ action: "credits.sharing_changed" })]);
  });

  it("lets a customer manage shares of their own grant only; staff sessions are refused on the portal variants", async () => {
    const owner = await makeUser(handle.db, { audience: "customer" });
    const own = await makeCreditGrant(handle.db, { personId: owner.personId!, units: 5, sharing: { mode: "named", max_guest_uses_per_month: 0, allowed_person_ids: [] } });
    const foreign = await makeCreditGrant(handle.db, { units: 5, sharing: { mode: "named", max_guest_uses_per_month: 0, allowed_person_ids: [] } });
    const sharee = await makeUser(handle.db, { audience: "customer" });
    const [foreignShare] = await handle.db.insert(packageShares).values({ grantId: foreign.id, sharedWithPersonId: sharee.personId!, createdByPersonId: foreign.personId }).returning();
    const { token } = await createAuthSession(handle.db, { userId: owner.id, audience: "customer", roleKey: null, now: new Date() });
    jar.set(SESSION_COOKIE, token);
    const email = () => `friend-${randomUUID().slice(0, 8)}@example.com`;
    const added = await actions.addMyPackageShare({ grantId: own.id, email: email(), firstName: "Jan", maxUnits: 2 });
    expect(added).toMatchObject({ ok: true, data: { created: true } });
    expect(await actions.addMyPackageShare({ grantId: foreign.id, email: email(), firstName: "Jan" })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await actions.revokeMyPackageShare({ shareId: foreignShare!.id })).toMatchObject({ ok: false, error: { code: "not_found" } });
    const shareId = (added as { data: { shareId: string } }).data.shareId;
    expect(await actions.revokeMyPackageShare({ shareId })).toMatchObject({ ok: true, data: { revoked: true } });
    const audits = await handle.db.select().from(auditLog).where(eq(auditLog.entityId, own.id));
    expect(audits.map((a) => a.action).sort()).toEqual(["credits.share_added", "credits.share_revoked"]);

    await asStaff("customer_service", ["credits.read", "credits.adjust"]);
    expect(await actions.addMyPackageShare({ grantId: own.id, email: email(), firstName: "Jan" })).toMatchObject(unauthorized);
    jar.clear();
    expect(await actions.revokeMyPackageShare({ shareId })).toMatchObject(unauthorized);
  });
});

describe("memberships.write actions", () => {
  it("refuses each plan and membership action without memberships.write, before writing", async () => {
    const list = await membershipCalls();
    await asStaff("finance", ["credits.read", "credits.adjust", "persons.read"]);
    const before = await writes();
    for (const [name, run] of list) expect(await run(), name).toMatchObject(forbidden);
    expect(await writes()).toEqual(before);
  });

  it("lets staff with memberships.write through", async () => {
    const m = await makeMembership(handle.db);
    await asStaff("customer_service", ["credits.read", "memberships.write"]);
    expect(await actions.updateMembershipNotes({ membershipId: m.id, notes: "Prefers mornings", version: m.version })).toMatchObject({ ok: true, data: { version: m.version + 1 } });
    expect(await actions.revokeGrant({ grantId: randomUUID(), reason: "Fraud", clientKey: randomUUID() })).toMatchObject(forbidden);
  });
});
