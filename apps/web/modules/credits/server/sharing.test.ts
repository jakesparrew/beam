/**
 * credits-P8 (R2): named sharing, per-grant sharing settings, the review list (credits spec rules
 * 18, 29, 40 to 43). A named sharee books on their own account within `max_units`; the payer's own
 * grants come first; a revoked share stops use and keeps the history; an owner has at most 5
 * active shares per grant; `sharing.allowed_person_ids` equals the active shares; the review view
 * shows a grant with 4 distinct guests and a guest on 3 owners, hides a reviewed item until a new
 * person appears; `sharing_disabled` sets mode `none`.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle, Tx } from "@beam/db";
import { auditLog, creditEntries, creditGrants, creditSharingReviews, packageShares } from "@beam/db/schema";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import { makeCreditGrant, makeEntry } from "@beam/db/testing/credits-factories";
import type * as EmailApi from "@/modules/email/api";
import { and, eq } from "@/lib/ctx";
import { makeCtx, resetRuntime, staffActor } from "@/lib/testing";
import { consumeCredits, InsufficientCreditsError, SharingNotAllowedError } from "./ledger";
import {
  addShare,
  countSharingReviewItems,
  getMySharesGiven,
  listSharingReview,
  MAX_PORTAL_SHARES,
  reviewSharing,
  revokeShare,
  updateGrantSharing,
} from "./sharing";

const fx = vi.hoisted(() => ({ sendTransactional: vi.fn() }));
vi.mock("@/modules/email/api", async (orig) => ({ ...(await orig<typeof EmailApi>()), sendTransactional: fx.sendTransactional }));

let h: DbHandle;
let staffUserId: string;
beforeAll(async () => {
  h = await createTestDb();
  staffUserId = (await makeUser(h.db, { roleKey: "customer_service" })).id;
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(() => {
  fx.sendTransactional.mockReset();
  fx.sendTransactional.mockResolvedValue({ emailMessageId: randomUUID(), jobId: randomUUID() });
});

const tx = () => h.db as unknown as Tx;
const sys = () => makeCtx(h.db);
const staff = () => makeCtx(h.db, staffActor({ userId: staffUserId, permissions: ["credits.read", "credits.adjust"] }));
const STAFF = () => ({ kind: "staff" as const, userId: staffUserId });
const OWNER = (personId: string) => ({ kind: "owner" as const, personId });
const named = { mode: "named" as const, max_guest_uses_per_month: 0, allowed_person_ids: [] as string[] };
const book = (personId: string, units = 1, beneficiaryPersonId = personId) =>
  consumeCredits(tx(), sys(), { personId, beneficiaryPersonId, kind: "day", units, ref: { type: "booking", id: randomUUID() } });
const grantOf = async (id: string) => (await h.db.select().from(creditGrants).where(eq(creditGrants.id, id)))[0]!;
const activeShares = (grantId: string) =>
  h.db.select().from(packageShares).where(and(eq(packageShares.grantId, grantId), eq(packageShares.status, "active")));

async function sharedGrant(units = 5) {
  const owner = await makePerson(h.db, { firstName: "Anna", lastName: "Dewit" });
  const grant = await makeCreditGrant(h.db, { personId: owner.id, units, sharing: { ...named } });
  return { owner, grant };
}

async function invite(grantId: string, by: ReturnType<typeof STAFF> | ReturnType<typeof OWNER>, maxUnits?: number) {
  const email = `sharee-${randomUUID().slice(0, 8)}@example.com`;
  const ctx = by.kind === "staff" ? staff() : makeCtx(h.db, { kind: "customer", userId: randomUUID(), personId: by.personId });
  return addShare(tx(), ctx, { grantId, email, firstName: "Bram", lastName: "Peeters", maxUnits }, by);
}

describe("named sharing (rules 18, 41, 42)", () => {
  it("lets a named sharee book on their own account within max_units, then refuses with share_limit", async () => {
    const { owner, grant } = await sharedGrant(5);
    const { shareId, sharedWithPersonId: sharee } = await invite(grant.id, OWNER(owner.id), 2);
    expect(fx.sendTransactional).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ template: "credits.share_invitation", personId: sharee, key: `credits:share_invitation:${shareId}:invite` }),
    );
    const first = await book(sharee, 2);
    expect(first.entries).toEqual([expect.objectContaining({ grantId: grant.id, quantity: -2 })]);
    const [entry] = await h.db.select().from(creditEntries).where(eq(creditEntries.id, first.entries[0]!.entryId));
    expect(entry).toMatchObject({ personId: owner.id, beneficiaryPersonId: sharee });
    await expect(book(sharee, 1)).rejects.toMatchObject({ name: SharingNotAllowedError.name, reason: "share_limit" });
  });

  it("uses the sharee's own grants before the shared one", async () => {
    const { owner, grant } = await sharedGrant(5);
    const { sharedWithPersonId: sharee } = await invite(grant.id, OWNER(owner.id));
    const own = await makeCreditGrant(h.db, { personId: sharee, units: 1, expiresAt: new Date(Date.now() + 900 * 86_400_000) });
    const r = await book(sharee, 2);
    expect(r.entries.map((e) => [e.grantId, e.quantity])).toEqual([
      [own.id, -1],
      [grant.id, -1],
    ]);
  });

  it("stops use after a revoke and keeps the past entries", async () => {
    const { owner, grant } = await sharedGrant(5);
    const { shareId, sharedWithPersonId: sharee } = await invite(grant.id, OWNER(owner.id));
    await book(sharee, 1);
    expect(await revokeShare(tx(), makeCtx(h.db, { kind: "customer", userId: randomUUID(), personId: owner.id }), { shareId }, OWNER(owner.id))).toEqual({ revoked: true });
    await expect(book(sharee, 1)).rejects.toBeInstanceOf(InsufficientCreditsError);
    const uses = await h.db.select().from(creditEntries).where(and(eq(creditEntries.grantId, grant.id), eq(creditEntries.beneficiaryPersonId, sharee)));
    expect(uses).toHaveLength(1);
    expect((await grantOf(grant.id)).sharing.allowed_person_ids).toEqual([]);
    expect(await revokeShare(tx(), staff(), { shareId }, STAFF())).toEqual({ revoked: false });
    const [given] = await getMySharesGiven(h.db, owner.id, { grantId: grant.id });
    expect(given).toMatchObject({ shareId, status: "revoked", usedUnits: 1, sharedWithName: "Bram P." });
  });

  it("allows an owner at most 5 active shares per grant; staff are not limited", async () => {
    const { owner, grant } = await sharedGrant(10);
    for (let i = 0; i < MAX_PORTAL_SHARES; i++) await invite(grant.id, OWNER(owner.id));
    await expect(invite(grant.id, OWNER(owner.id))).rejects.toMatchObject({ code: "conflict", message: "share_limit" });
    await invite(grant.id, STAFF());
    expect(await activeShares(grant.id)).toHaveLength(MAX_PORTAL_SHARES + 1);
  });

  it("keeps sharing.allowed_person_ids equal to the active shares", async () => {
    const { owner, grant } = await sharedGrant(5);
    const a = await invite(grant.id, OWNER(owner.id));
    const b = await invite(grant.id, OWNER(owner.id));
    await revokeShare(tx(), staff(), { shareId: a.shareId }, STAFF());
    const active = (await activeShares(grant.id)).map((s) => s.sharedWithPersonId).sort();
    expect(active).toEqual([b.sharedWithPersonId]);
    expect((await grantOf(grant.id)).sharing.allowed_person_ids).toEqual(active);
  });

  it("refuses a share for the owner, a second active share, another owner's grant and a grant not in mode named", async () => {
    const { owner, grant } = await sharedGrant(5);
    const ownerCtx = makeCtx(h.db, { kind: "customer", userId: randomUUID(), personId: owner.id });
    await expect(addShare(tx(), ownerCtx, { grantId: grant.id, email: owner.email!, firstName: "Anna" }, OWNER(owner.id))).rejects.toMatchObject({ code: "validation" });
    const { sharedWithPersonId } = await invite(grant.id, OWNER(owner.id));
    const [p] = await h.db.select().from(packageShares).where(eq(packageShares.sharedWithPersonId, sharedWithPersonId));
    expect(p).toMatchObject({ createdByPersonId: owner.id, createdByUserId: null });
    const stranger = await makePerson(h.db);
    await expect(invite(grant.id, OWNER(stranger.id))).rejects.toMatchObject({ code: "not_found" });
    const guests = await makeCreditGrant(h.db, { personId: owner.id, sharing: { mode: "guests", max_guest_uses_per_month: 2, allowed_person_ids: [] } });
    await expect(invite(guests.id, OWNER(owner.id))).rejects.toMatchObject({ code: "conflict", message: "not_shareable" });
    const euro = await makeCreditGrant(h.db, { personId: owner.id, creditKind: "euro", units: 1000 });
    await expect(invite(euro.id, STAFF())).rejects.toMatchObject({ code: "conflict", message: "not_shareable" });
  });

  it("switches a grant to named when staff add a share", async () => {
    const grant = await makeCreditGrant(h.db, { units: 5 });
    await invite(grant.id, STAFF());
    expect((await grantOf(grant.id)).sharing.mode).toBe("named");
  });
});

describe("per-grant sharing settings (rule 40)", () => {
  it("audits credits.sharing_changed, and leaving named revokes the active shares", async () => {
    const { owner, grant } = await sharedGrant(5);
    const { sharedWithPersonId: sharee } = await invite(grant.id, OWNER(owner.id));
    const r = await updateGrantSharing(tx(), staff(), { grantId: grant.id, mode: "guests", maxGuestUsesPerMonth: 4 });
    expect(r.sharing).toEqual({ mode: "guests", max_guest_uses_per_month: 4, allowed_person_ids: [] });
    expect(await activeShares(grant.id)).toHaveLength(0);
    await expect(book(sharee, 1)).rejects.toBeInstanceOf(InsufficientCreditsError);
    const audits = await h.db.select().from(auditLog).where(and(eq(auditLog.entityId, grant.id), eq(auditLog.action, "credits.sharing_changed")));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ oldValue: { mode: "named", max_guest_uses_per_month: 0 }, newValue: { mode: "guests", max_guest_uses_per_month: 4 } });
  });

  it("stores a guest limit of 0 for mode none and refuses sharing store credit", async () => {
    const grant = await makeCreditGrant(h.db, { sharing: { mode: "guests", max_guest_uses_per_month: 2, allowed_person_ids: [] } });
    expect((await updateGrantSharing(tx(), staff(), { grantId: grant.id, mode: "none", maxGuestUsesPerMonth: 5 })).sharing).toMatchObject({ mode: "none", max_guest_uses_per_month: 0 });
    const euro = await makeCreditGrant(h.db, { creditKind: "euro", units: 500 });
    await expect(updateGrantSharing(tx(), staff(), { grantId: euro.id, mode: "guests", maxGuestUsesPerMonth: 1 })).rejects.toMatchObject({ code: "conflict" });
    await expect(updateGrantSharing(tx(), staff(), { grantId: grant.id, mode: "guests", maxGuestUsesPerMonth: 40 })).rejects.toMatchObject({ code: "validation" });
  });
});

describe("review list (rule 43)", () => {
  async function guestUse(grantId: string, ownerId: string, guestId: string) {
    await makeEntry(h.db, { grantId, personId: ownerId, kind: "consume", quantity: -1, beneficiaryPersonId: guestId, refType: "booking", refId: randomUUID() });
  }

  it("shows a grant with 4 distinct guests in 30 days, hides it after review until a new guest appears", async () => {
    const owner = await makePerson(h.db);
    const grant = await makeCreditGrant(h.db, { personId: owner.id, units: 20, sharing: { mode: "guests", max_guest_uses_per_month: 10, allowed_person_ids: [] } });
    const guests = await Promise.all([1, 2, 3].map(() => makePerson(h.db)));
    for (const g of guests) await guestUse(grant.id, owner.id, g.id);
    const mine = async () => (await listSharingReview(h.db, { limit: 500 })).filter((r) => r.grantId === grant.id);
    expect(await mine()).toEqual([]);
    const fourth = await makePerson(h.db);
    await guestUse(grant.id, owner.id, fourth.id);
    await guestUse(grant.id, owner.id, fourth.id);
    expect(await mine()).toEqual([
      expect.objectContaining({ rule: "many_guests", guestPersonId: null, distinctCount: 4, personIds: [...guests.map((g) => g.id), fourth.id].sort() }),
    ]);
    const before = await countSharingReviewItems(h.db);

    await reviewSharing(tx(), staff(), { rule: "many_guests", grantId: grant.id, decision: "warned", note: "Called the owner" });
    expect(await mine()).toEqual([]);
    expect(await countSharingReviewItems(h.db)).toBe(before - 1);
    expect((await grantOf(grant.id)).sharing.mode).toBe("guests");

    await guestUse(grant.id, owner.id, (await makePerson(h.db)).id);
    expect(await mine()).toEqual([expect.objectContaining({ distinctCount: 5 })]);
  });

  it("shows a guest used on 3 owners' grants; sharing_disabled sets mode none on those grants", async () => {
    const guest = await makePerson(h.db);
    const grants = [];
    for (let i = 0; i < 3; i++) {
      const owner = await makePerson(h.db);
      const g = await makeCreditGrant(h.db, { personId: owner.id, sharing: { mode: "guests", max_guest_uses_per_month: 2, allowed_person_ids: [] } });
      await guestUse(g.id, owner.id, guest.id);
      grants.push(g);
    }
    const item = (await listSharingReview(h.db, { limit: 500 })).find((r) => r.guestPersonId === guest.id);
    expect(item).toMatchObject({ rule: "guest_hopping", grantId: null, distinctCount: 3, personIds: grants.map((g) => g.personId).sort() });

    const r = await reviewSharing(tx(), staff(), { rule: "guest_hopping", guestPersonId: guest.id, decision: "sharing_disabled" });
    expect(r.disabledGrantIds).toEqual(grants.map((g) => g.id).sort());
    for (const g of grants) expect((await grantOf(g.id)).sharing).toMatchObject({ mode: "none", max_guest_uses_per_month: 0 });
    expect((await listSharingReview(h.db, { limit: 500 })).some((x) => x.guestPersonId === guest.id)).toBe(false);
    const [review] = await h.db.select().from(creditSharingReviews).where(eq(creditSharingReviews.guestPersonId, guest.id));
    expect(review).toMatchObject({ decision: "sharing_disabled", reviewedByUserId: staffUserId });
    expect(await h.db.select().from(auditLog).where(and(eq(auditLog.action, "credits.sharing_reviewed"), eq(auditLog.entityId, guest.id)))).toHaveLength(1);
  });

  it("sets mode none on the grant for a many_guests sharing_disabled decision and refuses an item that is not listed", async () => {
    const owner = await makePerson(h.db);
    const grant = await makeCreditGrant(h.db, { personId: owner.id, units: 20, sharing: { ...named } });
    await expect(reviewSharing(tx(), staff(), { rule: "many_guests", grantId: grant.id, decision: "ok" })).rejects.toMatchObject({ code: "not_found" });
    for (let i = 0; i < 4; i++) await guestUse(grant.id, owner.id, (await makePerson(h.db)).id);
    await reviewSharing(tx(), staff(), { rule: "many_guests", grantId: grant.id, decision: "sharing_disabled" });
    expect((await grantOf(grant.id)).sharing.mode).toBe("none");
  });
});
