/**
 * commerce-P9 `countOrdersByLanding` (site's insights, cross-module D56): orders paid in the
 * window that came through a checkout, grouped by `checkouts.landing_path` and
 * `checkouts.utm->>'campaign'`; paid orders only (refunded ones still count) and revenue is the
 * order total with refunds not netted.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import { makeOrder, makePaidOrder } from "@beam/db/testing/commerce-factories";
import type { DbHandle } from "@beam/db";
import { checkouts, payments, refunds } from "@beam/db/schema";

vi.mock("next/headers", () => ({ cookies: () => Promise.resolve({ get: () => undefined }), headers: () => Promise.resolve(new Headers()) }));
vi.mock("next/server", () => ({ after: () => undefined }));

const { countOrdersByLanding } = await import("./api");

let h: DbHandle;
let userId: string;
// A window of its own, far from other rows; pinned so the test does not depend on the clock.
const FROM = new Date("2026-03-01T00:00:00Z");
const TO = new Date("2026-03-08T00:00:00Z");
const IN = new Date("2026-03-03T10:00:00Z");

beforeAll(async () => {
  h = await createTestDb();
  userId = (await makeUser(h.db)).id;
});
afterAll(async () => {
  await h.close();
});

async function orderVia(input: { landingPath: string | null; campaign?: string; totalCents: number; status?: "paid" | "refunded" | "partially_refunded"; paidAt?: Date }) {
  const person = await makePerson(h.db);
  const [checkout] = await h.db
    .insert(checkouts)
    .values({ personId: person.id, channel: "site", items: [], status: "completed", landingPath: input.landingPath, utm: input.campaign ? { source: "meta", campaign: input.campaign } : null })
    .returning();
  const { order } = await makePaidOrder(h.db, {
    personId: person.id,
    lines: [{ unitAmountCents: input.totalCents }],
    order: { channel: "site", checkoutId: checkout!.id, paidAt: input.paidAt ?? IN, status: input.status ?? "paid" },
  });
  await h.db.update(checkouts).set({ orderId: order.id }).where(eqId(checkout!.id));
  return order;
}

const { eq } = await import("@/lib/ctx");
const eqId = (id: string) => eq(checkouts.id, id);

describe("countOrdersByLanding", () => {
  it("groups paid orders of checkouts by landing path and campaign", async () => {
    await orderVia({ landingPath: "/nl/offers/day-pass", campaign: "spring", totalCents: 4500 });
    await orderVia({ landingPath: "/nl/offers/day-pass", campaign: "spring", totalCents: 3000 });
    await orderVia({ landingPath: "/nl/offers/day-pass", totalCents: 2000 });
    await orderVia({ landingPath: null, campaign: "newsletter", totalCents: 1000 });

    const rows = await countOrdersByLanding(h.db, { from: FROM, to: TO });
    expect(rows).toEqual([
      { landingPath: "/nl/offers/day-pass", utmCampaign: "spring", orders: 2, revenueCents: 7500 },
      { landingPath: "/nl/offers/day-pass", utmCampaign: null, orders: 1, revenueCents: 2000 },
      { landingPath: null, utmCampaign: "newsletter", orders: 1, revenueCents: 1000 },
    ]);
    for (const r of rows) expect(Object.keys(r).sort()).toEqual(["landingPath", "orders", "revenueCents", "utmCampaign"]);
  });

  it("counts paid orders only, keeps refunded orders and does not net refunds", async () => {
    const path = "/fr/offres/nuit";
    const refunded = await orderVia({ landingPath: path, totalCents: 8000, status: "refunded" });
    await orderVia({ landingPath: path, totalCents: 2000, status: "partially_refunded" });
    const [payment] = await h.db.insert(payments).values({ orderId: refunded.id, provider: "mollie", amountCents: 8000, refundedCents: 8000, status: "refunded" }).returning();
    await h.db.insert(refunds).values({
      paymentId: payment!.id,
      orderId: refunded.id,
      amountCents: 8000,
      reason: "customer_request",
      lines: [],
      creditAction: "none",
      status: "refunded",
      createdByUserId: userId,
    });
    // Not paid: a pending order and a cancelled one through the same landing page.
    const person = await makePerson(h.db);
    for (const status of ["pending_payment", "cancelled"] as const) {
      const [checkout] = await h.db.insert(checkouts).values({ personId: person.id, channel: "site", items: [], landingPath: path }).returning();
      await makeOrder(h.db, { personId: person.id, channel: "site", status, checkoutId: checkout!.id, totalCents: 9900 });
    }

    const rows = await countOrdersByLanding(h.db, { from: FROM, to: TO });
    expect(rows.find((r) => r.landingPath === path)).toEqual({ landingPath: path, utmCampaign: null, orders: 2, revenueCents: 10_000 });
  });

  it("uses the payment time and a half-open window", async () => {
    const path = "/en/offers/window";
    await orderVia({ landingPath: path, totalCents: 100, paidAt: new Date(FROM.getTime()) });
    await orderVia({ landingPath: path, totalCents: 100, paidAt: new Date(TO.getTime()) });
    await orderVia({ landingPath: path, totalCents: 100, paidAt: new Date(FROM.getTime() - 1) });
    const rows = await countOrdersByLanding(h.db, { from: FROM, to: TO });
    expect(rows.find((r) => r.landingPath === path)).toEqual({ landingPath: path, utmCampaign: null, orders: 1, revenueCents: 100 });
    expect(await countOrdersByLanding(h.db, { from: new Date("2025-01-01T00:00:00Z"), to: new Date("2025-01-02T00:00:00Z") })).toEqual([]);
  });
});
