/**
 * fix-w23-leftovers (fix-w09-credits-review request): commerce relaxed `orders_renewal_chk` to
 * `renewal_membership_id is null or renewal_period_end_on is not null`, so deleting a membership
 * that a renewal order links to no longer fails: the FK's `ON DELETE SET NULL` clears the link and
 * the order keeps its period. This is what lets the renewal-order guard of the
 * `credits.memberships` sweep go.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@beam/db";
import { membershipPeriods, memberships, orders } from "@beam/db/schema";
import { createTestDb } from "@beam/db/testing";
import { makeOrder } from "@beam/db/testing/commerce-factories";
import { makeMembership } from "@beam/db/testing/credits-factories";
import { eq, sql } from "@/lib/ctx";

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
}, 120_000);
afterAll(async () => {
  await h.close();
});

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

describe("orders_renewal_chk after commerce relaxed it", () => {
  it("deleting a renewed membership nulls the order's link and keeps its period", async () => {
    const m = await makeMembership(h.db, { status: "expired", startedAt: ago(3_700), currentPeriodEndAt: ago(3_670), endedAt: ago(3_670) });
    await h.db.insert(membershipPeriods).values({ membershipId: m.id, personId: m.personId, periodStartAt: m.currentPeriodStartAt, periodEndAt: m.currentPeriodEndAt, source: "purchase" });
    const order = await makeOrder(h.db, { personId: m.personId, channel: "recurring", status: "cancelled", renewalMembershipId: m.id, renewalPeriodEndOn: "2016-01-01" });
    await h.db.transaction(async (tx) => {
      await tx.execute(sql`set local beam.allow_rewrite = 'on'`);
      await tx.delete(membershipPeriods).where(eq(membershipPeriods.membershipId, m.id));
      await tx.delete(memberships).where(eq(memberships.id, m.id));
    });
    expect(await h.db.select().from(memberships).where(eq(memberships.id, m.id))).toEqual([]);
    const [o] = await h.db.select({ m: orders.renewalMembershipId, on: orders.renewalPeriodEndOn }).from(orders).where(eq(orders.id, order.id));
    expect(o).toEqual({ m: null, on: "2016-01-01" });
  });
});
