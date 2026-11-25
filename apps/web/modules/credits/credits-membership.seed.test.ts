import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle, Tx } from "@beam/db";
import { creditGrants, membershipPlanBenefits, sessions } from "@beam/db/schema";
import { createTestDb, makeProduct } from "@beam/db/testing";
import { makeMembership } from "@beam/db/testing/credits-factories";
import { BEAM_SKUS } from "@beam/db/seed/commerce";
import { asc, eq } from "@/lib/ctx";
import { makeCtx, resetRuntime } from "@/lib/testing";
import { DEMO_MEMBER_GATHERINGS, runMembershipPlanSeed } from "./seed";
import { consumeCredits } from "./server/ledger";
import { grantInclusions } from "./server/memberships";

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

const NOW = new Date("2026-11-25T09:00:00.000Z");
const DAY = 86_400_000;

describe("runMembershipPlanSeed (the owner's BEAM membership on the demo)", () => {
  it("seeds the plan, gives live members the 4-day alternative unless they used a free session, and two members-only gatherings; idempotent", async () => {
    const plan = await makeProduct(h.db, { kind: "membership", sku: BEAM_SKUS.membershipYear, recurringInterval: "year", includedCreditKind: "night", includedCreditUnits: 1, memberDiscountPct: "20.00" });
    await makeProduct(h.db, { kind: "item", sku: BEAM_SKUS.detoxSalt, itemCategory: "wellness_product" });
    const period = { currentPeriodStartAt: new Date(NOW.getTime() - 30 * DAY), currentPeriodEndAt: new Date(NOW.getTime() + 335 * DAY) };
    const fresh = await makeMembership(h.db, { productId: plan.id, interval: "year", status: "active", ...period });
    const used = await makeMembership(h.db, { productId: plan.id, interval: "year", status: "active", ...period });
    const ctx = makeCtx(h.db, { now: NOW });
    // `used` already booked the free night before the plan got its alternative.
    await grantInclusions(h.db, ctx, used, used.currentPeriodStartAt, used.currentPeriodEndAt);
    await consumeCredits(h.db, ctx, { personId: used.personId, beneficiaryPersonId: used.personId, kind: "night", units: 1, ref: { type: "booking", id: randomUUID() }, validAt: NOW });

    const s = { db: h.db as unknown as Tx, ctx, now: NOW };
    const first = await runMembershipPlanSeed(s);
    const second = await runMembershipPlanSeed(s);
    expect(first.created).toBeGreaterThan(0);
    expect(second.created).toBe(0);

    const kinds = async (membershipId: string) =>
      (await h.db.select().from(creditGrants).where(eq(creditGrants.membershipId, membershipId)).orderBy(asc(creditGrants.creditKind))).map((g) => [g.creditKind, g.unitsGranted]);
    expect(await kinds(fresh.id)).toEqual([
      ["day", 4],
      ["night", 1],
    ]);
    expect(await kinds(used.id)).toEqual([["night", 1]]);

    const benefits = await h.db.select().from(membershipPlanBenefits).where(eq(membershipPlanBenefits.productId, plan.id));
    expect(benefits.filter((b) => b.discountScope).map((b) => b.discountScope).sort()).toEqual(["events", "packages", "product", "products", "sessions"]);

    const gatherings = await h.db.select().from(sessions).where(eq(sessions.isMemberOnly, true));
    expect(gatherings.map((g) => g.notes).sort()).toEqual(DEMO_MEMBER_GATHERINGS.map((g) => g.note).sort());
    for (const g of gatherings) expect(g).toMatchObject({ kind: "event", eventCategory: "member_event", status: "open" });
  });
});
