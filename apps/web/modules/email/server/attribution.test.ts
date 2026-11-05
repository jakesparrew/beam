/**
 * email-P9: campaign attribution (email spec section 2 `v_email_attribution`, decision 45). Last
 * click within 7 days before payment, campaigns and automations alike; fully refunded orders are
 * excluded, partially refunded ones count with their paid total; first purchase flag. Dates are
 * fixed instants (no wall clock), so the test is the same at 23:30 and across a DST change.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "@beam/db/testing";
import { makePerson } from "@beam/db/testing/factories";
import { makeOrder, makePaidOrder } from "@beam/db/testing/commerce-factories";
import type { DbHandle } from "@beam/db";
import { automationEnrolments, automationGroups, automations, automationVersions, emailMessages, orders, vEmailAttribution } from "@beam/db/schema";
import { eq, sql } from "@/lib/ctx";
import { resetRuntime } from "@/lib/testing";
import { getCampaignAttribution as apiGetCampaignAttribution } from "../api";
import { campaignRow, staff } from "../email-p6.fixtures";
import { templateVersion } from "../email-p7.fixtures";
import { getCampaignReport } from "../queries";
import { campaignAttributionTotals, getCampaignAttribution } from "./attribution";

let h: DbHandle;
let versionId: string;
let templateId: string;
let userId: string;

const DAY = 86_400_000;
const T0 = new Date("2026-10-05T10:00:00Z");
const at = (days: number) => new Date(T0.getTime() + days * DAY);
const WIDE = { from: new Date("2026-01-01T00:00:00Z"), to: new Date("2027-01-01T00:00:00Z") };
let seq = 0;

beforeAll(async () => {
  h = await createTestDb();
  userId = (await staff(h.db)).id;
  const tv = await templateVersion(h.db);
  versionId = tv.versionId;
  templateId = tv.templateId;
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  await h.db.execute(sql`set beam.allow_rewrite = 'on'`);
  await h.db.execute(sql`delete from order_lines`);
  await h.db.execute(sql`delete from orders`);
  await h.db.execute(sql`set beam.allow_rewrite = 'off'`);
});

async function campaign(name: string) {
  return campaignRow(h.db, { templateId, createdByUserId: userId, name, status: "sent" });
}

/** A campaign or automation message to `personId`, clicked at `clickedAt` (null: never clicked). */
async function message(personId: string, o: { campaignId?: string; enrolmentId?: string; clickedAt: Date | null }) {
  const [m] = await h.db
    .insert(emailMessages)
    .values({
      personId,
      kind: o.campaignId ? "campaign" : "automation",
      purpose: "newsletter",
      locale: "nl-BE",
      fromDomain: "news.beam.be",
      status: "delivered",
      templateVersionId: versionId,
      idempotencyKey: `p9:${++seq}:${crypto.randomUUID()}`,
      campaignId: o.campaignId ?? null,
      enrolmentId: o.enrolmentId ?? null,
      sentAt: o.clickedAt ? new Date(o.clickedAt.getTime() - 3_600_000) : at(-1),
      clickedAt: o.clickedAt,
    })
    .returning();
  return m!;
}

const paid = (personId: string, paidAt: Date, totalCents = 10_000, status: "paid" | "partially_refunded" | "refunded" = "paid") =>
  makePaidOrder(h.db, { personId, lines: [{ unitAmountCents: totalCents }], order: { paidAt, status } }).then((r) => r.order);

/** An automation with one enrolment of `personId` (automation tables written directly: only the ids matter here). */
async function enrolment(personId: string, name: string) {
  const key = `p9_${++seq}_${Date.now().toString(36)}`;
  const [g] = await h.db.insert(automationGroups).values({ key, name: key }).returning();
  const [a] = await h.db.insert(automations).values({ slug: key.replace(/_/g, "-"), name, groupId: g!.id, isMarketing: true, purpose: "newsletter" }).returning();
  const [v] = await h.db
    .insert(automationVersions)
    .values({
      automationId: a!.id,
      version: 1,
      definition: { schema_version: 1, trigger: { event: "test.happened" }, anchor: "enrolment", re_entry: "always", exit_on: [], steps: [] },
      definitionHash: crypto.randomUUID(),
    })
    .returning();
  const [e] = await h.db
    .insert(automationEnrolments)
    .values({ automationId: a!.id, automationVersionId: v!.id, personId, groupId: g!.id, source: "staff", nextStepKey: "s1", nextStepAt: at(0) })
    .returning();
  return { automationId: a!.id, enrolmentId: e!.id };
}

describe("v_email_attribution and getCampaignAttribution", () => {
  it("attributes an order paid 3 days after a click, not one paid 8 days after", async () => {
    const c = await campaign("P9 October news");
    const p1 = await makePerson(h.db);
    const p2 = await makePerson(h.db);
    await message(p1.id, { campaignId: c.id, clickedAt: at(0) });
    await message(p2.id, { campaignId: c.id, clickedAt: at(0) });
    const inWindow = await paid(p1.id, at(3), 12_500);
    await paid(p2.id, at(8));

    const rows = await h.db.select({ orderId: vEmailAttribution.orderId, campaignId: vEmailAttribution.campaignId, totalCents: vEmailAttribution.totalCents }).from(vEmailAttribution);
    expect(rows).toEqual([{ orderId: inWindow.id, campaignId: c.id, totalCents: 12_500 }]);
    expect(await getCampaignAttribution(h.db, WIDE)).toEqual([
      { campaignId: c.id, automationId: null, name: "P9 October news", orders: 1, revenueCents: 12_500, firstPurchases: 1 },
    ]);
  });

  it("an order paid before the click, or with a message never clicked, is not attributed", async () => {
    const c = await campaign("P9 before");
    const p = await makePerson(h.db);
    const q = await makePerson(h.db);
    await message(p.id, { campaignId: c.id, clickedAt: at(2) });
    await message(q.id, { campaignId: c.id, clickedAt: null });
    await paid(p.id, at(1));
    await paid(q.id, at(1));
    expect(await campaignAttributionTotals(h.db, c.id)).toEqual({ orders: 0, revenueCents: 0, firstPurchases: 0 });
  });

  it("two campaigns clicked: the latest click before payment wins", async () => {
    const first = await campaign("P9 first");
    const second = await campaign("P9 second");
    const later = await campaign("P9 after payment");
    const p = await makePerson(h.db);
    await message(p.id, { campaignId: first.id, clickedAt: at(0) });
    await message(p.id, { campaignId: second.id, clickedAt: at(2) });
    await message(p.id, { campaignId: later.id, clickedAt: at(5) });
    await paid(p.id, at(4), 8_000);

    expect(await campaignAttributionTotals(h.db, second.id)).toEqual({ orders: 1, revenueCents: 8_000, firstPurchases: 1 });
    expect(await campaignAttributionTotals(h.db, first.id)).toEqual({ orders: 0, revenueCents: 0, firstPurchases: 0 });
    expect(await campaignAttributionTotals(h.db, later.id)).toEqual({ orders: 0, revenueCents: 0, firstPurchases: 0 });
  });

  it("excludes a fully refunded order and keeps a partially refunded one with its paid total", async () => {
    const c = await campaign("P9 refunds");
    const p1 = await makePerson(h.db);
    const p2 = await makePerson(h.db);
    const p3 = await makePerson(h.db);
    for (const p of [p1, p2, p3]) await message(p.id, { campaignId: c.id, clickedAt: at(0) });
    await paid(p1.id, at(1), 5_000, "refunded");
    await paid(p2.id, at(1), 7_000, "partially_refunded");
    await paid(p3.id, at(2), 3_000);
    await makeOrder(h.db, { personId: p3.id, status: "pending_payment" });

    expect(await campaignAttributionTotals(h.db, c.id)).toEqual({ orders: 2, revenueCents: 10_000, firstPurchases: 2 });
  });

  it("attributes an automation click to the automation (campaign id null) with the automation's name", async () => {
    const p = await makePerson(h.db);
    const { automationId, enrolmentId } = await enrolment(p.id, "P9 welcome series");
    await message(p.id, { enrolmentId, clickedAt: at(0) });
    await paid(p.id, at(6), 4_200);

    expect(await getCampaignAttribution(h.db, WIDE)).toEqual([
      { campaignId: null, automationId, name: "P9 welcome series", orders: 1, revenueCents: 4_200, firstPurchases: 1 },
    ]);
  });

  it("flags only the person's first paid order as a first purchase", async () => {
    const c = await campaign("P9 first purchase");
    const newcomer = await makePerson(h.db);
    const regular = await makePerson(h.db);
    await paid(regular.id, at(-30), 2_000);
    await message(newcomer.id, { campaignId: c.id, clickedAt: at(0) });
    await message(regular.id, { campaignId: c.id, clickedAt: at(0) });
    await paid(newcomer.id, at(1), 6_000);
    await paid(newcomer.id, at(2), 1_000);
    await paid(regular.id, at(1), 9_000);

    const rows = await h.db.select().from(orders).where(eq(orders.personId, newcomer.id));
    expect(rows).toHaveLength(2);
    expect(await campaignAttributionTotals(h.db, c.id)).toEqual({ orders: 3, revenueCents: 16_000, firstPurchases: 1 });
  });

  it("getCampaignAttribution counts orders paid in [from, to) and sorts by revenue; the api delegates to it", async () => {
    const small = await campaign("P9 small");
    const big = await campaign("P9 big");
    const p = await makePerson(h.db);
    const q = await makePerson(h.db);
    await message(p.id, { campaignId: small.id, clickedAt: at(0) });
    await message(q.id, { campaignId: big.id, clickedAt: at(0) });
    await paid(p.id, at(1), 1_000);
    await paid(q.id, at(2), 9_000);

    const range = { from: at(0.5), to: at(3) };
    expect((await getCampaignAttribution(h.db, range)).map((r) => r.name)).toEqual(["P9 big", "P9 small"]);
    expect((await getCampaignAttribution(h.db, { from: at(1.5), to: at(3) })).map((r) => r.campaignId)).toEqual([big.id]);
    expect(await getCampaignAttribution(h.db, { from: at(1), to: at(1) })).toEqual([]);
    expect(await apiGetCampaignAttribution(h.db, range)).toEqual(await getCampaignAttribution(h.db, range));
  });

  it("the campaign report carries the attribution block", async () => {
    const c = await campaign("P9 report");
    const p = await makePerson(h.db);
    await message(p.id, { campaignId: c.id, clickedAt: at(0) });
    await paid(p.id, at(2), 7_500);
    const report = await getCampaignReport(h.db, c.id);
    expect(report?.attribution).toEqual({ orders: 1, revenueCents: 7_500, firstPurchases: 1 });
    expect(await getCampaignReport(h.db, crypto.randomUUID())).toBeNull();
  });
});
