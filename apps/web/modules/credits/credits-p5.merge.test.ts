/**
 * credits-P5: `onPersonsMerged` (rule 35, edge case 12, cross-module D20 and D14). crm's merge
 * transaction calls it; here it is called directly with crm's `createTask` mocked.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle, Tx } from "@beam/db";
import { auditLog, creditEntries, creditGrants, memberships, packageShares, vPersonCredits } from "@beam/db/schema";
import { createTestDb, makePerson, makeProduct, makeUser } from "@beam/db/testing";
import { makeCreditGrant, makeEntry, makeMembership } from "@beam/db/testing/credits-factories";
import { and, ConflictError, eq } from "@/lib/ctx";
import type * as CrmApi from "@/modules/crm/api";
import { makeCtx, resetRuntime, staffActor } from "@/lib/testing";
import { onPersonsMerged } from "./api";

const fx = vi.hoisted(() => ({ createTask: vi.fn() }));
vi.mock("@/modules/crm/api", async (orig) => ({ ...(await orig<typeof CrmApi>()), createTask: fx.createTask }));

let h: DbHandle;
let userId: string;
beforeAll(async () => {
  h = await createTestDb();
  userId = (await makeUser(h.db)).id;
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(() => {
  vi.clearAllMocks();
  fx.createTask.mockImplementation(() => Promise.resolve({ taskId: randomUUID(), created: true }));
});

const DAY = 86_400_000;
const days = (n: number) => new Date(Date.now() + n * DAY);
const tx = () => h.db as unknown as Tx;
const merge = (winnerPersonId: string, loserPersonId: string) =>
  onPersonsMerged(tx(), makeCtx(h.db, staffActor({ userId, permissions: ["persons.merge"] })), { winnerPersonId, loserPersonId });

describe("onPersonsMerged", () => {
  it("moves grants, memberships and shares to the winner; ledger rows keep the historical person", async () => {
    const winner = await makePerson(h.db);
    const loser = await makePerson(h.db);
    const third = await makePerson(h.db);
    const grant = await makeCreditGrant(h.db, { personId: loser.id, source: "import", vatTreatment: "single_purpose", units: 6, startsAt: days(-5) });
    await makeEntry(h.db, { grantId: grant.id, kind: "consume", quantity: -1 });
    const m = await makeMembership(h.db, { personId: loser.id });
    // The third person shares a grant with the loser; the loser shared their own grant with the winner and with the third person.
    const thirdsGrant = await makeCreditGrant(h.db, {
      personId: third.id,
      source: "import",
      vatTreatment: "single_purpose",
      sharing: { mode: "named", max_guest_uses_per_month: 0, allowed_person_ids: [loser.id] },
    });
    const received = (await h.db.insert(packageShares).values({ grantId: thirdsGrant.id, sharedWithPersonId: loser.id, createdByPersonId: third.id }).returning())[0]!;
    await h.db.update(creditGrants).set({ sharing: { mode: "named", max_guest_uses_per_month: 0, allowed_person_ids: [winner.id, third.id] } }).where(eq(creditGrants.id, grant.id));
    const toWinner = (await h.db.insert(packageShares).values({ grantId: grant.id, sharedWithPersonId: winner.id, createdByPersonId: loser.id }).returning())[0]!;
    const toThird = (await h.db.insert(packageShares).values({ grantId: grant.id, sharedWithPersonId: third.id, createdByPersonId: loser.id }).returning())[0]!;

    await merge(winner.id, loser.id);

    const [g] = await h.db.select().from(creditGrants).where(eq(creditGrants.id, grant.id));
    expect(g!.personId).toBe(winner.id);
    const entries = await h.db.select().from(creditEntries).where(eq(creditEntries.grantId, grant.id));
    expect(new Set(entries.map((e) => e.personId))).toEqual(new Set([loser.id]));
    const [credits] = await h.db.select().from(vPersonCredits).where(and(eq(vPersonCredits.personId, winner.id), eq(vPersonCredits.creditKind, "day")));
    expect(credits!.remainingUnits).toBe(5);

    const [mAfter] = await h.db.select().from(memberships).where(eq(memberships.id, m.id));
    expect(mAfter).toMatchObject({ personId: winner.id, status: "active", version: m.version + 1 });

    const shares = await h.db.select().from(packageShares).where(eq(packageShares.grantId, grant.id));
    expect(shares.find((s) => s.id === toWinner.id)).toMatchObject({ status: "revoked", revokedReason: "merged", createdByPersonId: winner.id });
    expect(shares.find((s) => s.id === toThird.id)).toMatchObject({ status: "active", sharedWithPersonId: third.id, createdByPersonId: winner.id });
    expect(g!.sharing.allowed_person_ids).toEqual([third.id]);
    const [receivedAfter] = await h.db.select().from(packageShares).where(eq(packageShares.id, received.id));
    expect(receivedAfter).toMatchObject({ status: "active", sharedWithPersonId: winner.id });
    const [thirdsAfter] = await h.db.select().from(creditGrants).where(eq(creditGrants.id, thirdsGrant.id));
    expect(thirdsAfter!.sharing.allowed_person_ids).toEqual([winner.id]);

    expect(await h.db.select().from(creditGrants).where(eq(creditGrants.personId, loser.id))).toEqual([]);
    expect(await h.db.select().from(memberships).where(eq(memberships.personId, loser.id))).toEqual([]);
    expect(fx.createTask).not.toHaveBeenCalled();
  });

  it.each([
    ["active", "active"],
    ["active", "past_due"],
    ["past_due", "active"],
  ] as const)("refuses two live memberships (%s and %s) with ConflictError('both_members') and changes nothing", async (a, b) => {
    const winner = await makePerson(h.db);
    const loser = await makePerson(h.db);
    await makeMembership(h.db, { personId: winner.id, status: a });
    const lm = await makeMembership(h.db, { personId: loser.id, status: b });
    const grant = await makeCreditGrant(h.db, { personId: loser.id, source: "import", vatTreatment: "single_purpose" });
    const error = await merge(winner.id, loser.id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as Error).message).toBe("both_members");
    expect((await h.db.select().from(memberships).where(eq(memberships.id, lm.id)))[0]!.personId).toBe(loser.id);
    expect((await h.db.select().from(creditGrants).where(eq(creditGrants.id, grant.id)))[0]!.personId).toBe(loser.id);
  });

  it("two pending memberships: cancels the later-starting one (merged), audits and opens a refund review task", async () => {
    const winner = await makePerson(h.db);
    const loser = await makePerson(h.db);
    const plan = await makeProduct(h.db, { kind: "membership" });
    const later = await makeMembership(h.db, { personId: winner.id, productId: plan.id, status: "pending", startedAt: days(20) });
    const earlier = await makeMembership(h.db, { personId: loser.id, productId: plan.id, status: "pending", startedAt: days(10) });

    await merge(winner.id, loser.id);

    const [cancelled] = await h.db.select().from(memberships).where(eq(memberships.id, later.id));
    expect(cancelled).toMatchObject({ status: "cancelled", endReason: "merged", personId: winner.id });
    expect(cancelled!.endedAt).not.toBeNull();
    const [kept] = await h.db.select().from(memberships).where(eq(memberships.id, earlier.id));
    expect(kept).toMatchObject({ status: "pending", personId: winner.id });

    const audits = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "memberships.merged"), eq(auditLog.entityId, later.id)));
    expect(audits).toHaveLength(1);

    expect(fx.createTask).toHaveBeenCalledTimes(1);
    const [, , input] = fx.createTask.mock.calls[0]! as [unknown, unknown, Record<string, unknown>];
    expect(input).toMatchObject({
      kind: "review",
      ownerRole: "customer_service",
      personId: winner.id,
      source: "system",
      ref: { type: "membership", id: later.id },
    });
    expect(typeof input.title).toBe("string");
    expect((input.dueAt as Date).getTime()).toBeGreaterThan(Date.now());
    expect(input).not.toHaveProperty("refType");
  });

  it("a pending membership and a live one merge without cancelling anything (plan change kept)", async () => {
    const winner = await makePerson(h.db);
    const loser = await makePerson(h.db);
    const live = await makeMembership(h.db, { personId: winner.id, cancelAt: days(20) });
    const pending = await makeMembership(h.db, { personId: loser.id, status: "pending", startedAt: days(20) });
    await merge(winner.id, loser.id);
    const rows = await h.db.select().from(memberships).where(eq(memberships.personId, winner.id));
    expect(rows.map((r) => [r.id, r.status]).sort()).toEqual([[live.id, "active"], [pending.id, "pending"]].sort());
    expect(fx.createTask).not.toHaveBeenCalled();
  });

  it("refuses to merge a person into themself", async () => {
    const p = await makePerson(h.db);
    await expect(merge(p.id, p.id)).rejects.toMatchObject({ code: "validation" });
  });
});
