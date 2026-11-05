/**
 * webinar-P7: the marketing KPIs (`getWebinarKpis`) and the campaign funnel (`funnelByCampaign`).
 * One live webinar 40 days ago with lead, customer and member registrants made in the range,
 * one registration of another webinar outside it, a cancelled and a tester registration that
 * never count; ops' `ad_spend_daily` rows of the campaign `Spring-Sale` (matched on
 * `campaign_name`, case and spaces ignored) inside and outside the range. Covers: live attendance
 * rate over live-mode registrations only (registration is never attendance); conversion per
 * segment within the period; the campaign join; null spend gives null cost and rate; periods
 * respected (registration range, conversion window, spend days).
 *
 * Every date is a fractional day offset from the test's start, and ad days are Brussels days, so
 * the test passes at any hour and across a DST change.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle, DbOrTx } from "@beam/db";
import { adSpendDaily, bookings } from "@beam/db/schema";
import { createTestDb, makePerson, makeSession, makeUser } from "@beam/db/testing";
import { makePaidOrder } from "@beam/db/testing/commerce-factories";
import { funnelByCampaign, getWebinarKpis } from "./api";
import { heartbeatSpans, makeRegistration, makeSegments, makeWebinar, type WebinarRow } from "./test/factories";
import { buildReportCsv, getWebinarReport, type UtmRow } from "./server/report";
import { UtmTable, type UtmTableLabels } from "./ui/report/utm-table";

let h: DbHandle;
let w: WebinarRow;
const DAY = 86_400_000;
const NOW = Date.now() - 0.3 * DAY;
const at = (daysFromNow: number) => new Date(NOW + daysFromNow * DAY);
/** The live webinar started 40 days ago. */
const START = at(-40);
const after = (days: number) => new Date(START.getTime() + days * DAY);
/** The marketing range: registrations made between 60 and 20 days ago. */
const RANGE = { from: at(-60), to: at(-20) };
const brusselsDay = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Brussels" }).format(d);

/** A real (non-tester) person; the shared factory makes testers by default. */
const real = () => makePerson(h.db, { isTester: false });

async function makeBookingAt(db: DbOrTx, personId: string, createdAt: Date, status: "confirmed" | "attended") {
  const session = await makeSession(db, { kind: "day", startsAt: new Date(createdAt.getTime() + 2 * DAY) });
  await db.insert(bookings).values({ sessionId: session.id, personId, status, paidWith: "free", source: "admin", createdAt, ...(status === "attended" ? { attendedAt: session.startsAt } : {}) });
}

async function adSpend(campaignName: string, day: Date, spendCents: number, clicks: number, campaignExternalId = `ext-${campaignName}-${brusselsDay(day)}`) {
  await h.db.insert(adSpendDaily).values({
    platform: "meta",
    accountId: "act-test",
    campaignExternalId,
    campaignName,
    dayOn: brusselsDay(day),
    spendCents,
    clicks,
    raw: {},
    pulledAt: new Date(),
  });
}

beforeAll(async () => {
  h = await createTestDb();
  const owner = await makeUser(h.db);
  w = await makeWebinar(h.db, { ownerUserId: owner.id, startsAt: START, conversionWindowDays: 30 }, { published: true });
  const other = await makeWebinar(h.db, { ownerUserId: owner.id, startsAt: at(-10), slug: "other-webinar" }, { published: true });
  const created = new Date(START.getTime() - 5 * DAY);

  // Lead 1 (campaign "Spring-Sale"): 10 minutes live (attended), a visit booked 10 days after the start.
  const lead1 = await real();
  const r1 = await makeRegistration(h.db, { webinarId: w.id, personId: lead1.id, personStatus: "lead", utm: { source: "meta", campaign: " Spring-Sale " }, createdAt: created });
  await makeSegments(h.db, r1, "live", heartbeatSpans(0, 600), { recordedAt: START });
  await makeBookingAt(h.db, lead1.id, after(10), "attended");

  // Lead 2 (same campaign, other case): registered only.
  await makeRegistration(h.db, { webinarId: w.id, personId: (await real()).id, personStatus: "lead", utm: { source: "meta", campaign: "spring-sale" }, createdAt: created });

  // Customer (campaign "autumn", no ad rows): 100 s live, under the 300 s threshold.
  const r3 = await makeRegistration(h.db, { webinarId: w.id, personId: (await real()).id, personStatus: "customer", utm: { campaign: "autumn" }, createdAt: created });
  await makeSegments(h.db, r3, "live", heartbeatSpans(0, 105), { recordedAt: START });

  // Member (no campaign): registered for the replay a day after the start, watched 20 minutes,
  // bought 2 days later (EUR 90).
  const member = await real();
  const r4 = await makeRegistration(h.db, { webinarId: w.id, personId: member.id, personStatus: "member", registeredMode: "replay", createdAt: after(1) });
  await makeSegments(h.db, r4, "replay", heartbeatSpans(0, 1200), { recordedAt: after(1) });
  await makePaidOrder(h.db, { personId: member.id, lines: [{ unitAmountCents: 9000 }], order: { paidAt: after(3) } });

  // Never counted: a cancelled registration and a tester's.
  await makeRegistration(h.db, { webinarId: w.id, personId: (await real()).id, status: "cancelled", personStatus: "lead", utm: { campaign: "spring-sale" }, createdAt: created });
  const tester = await makePerson(h.db, { isTester: true });
  await makeRegistration(h.db, { webinarId: w.id, personId: tester.id, personStatus: "lead", utm: { campaign: "spring-sale" }, createdAt: created });

  // Outside the range: a registration for the other webinar 15 days ago.
  await makeRegistration(h.db, { webinarId: other.id, personId: (await real()).id, personStatus: "lead", utm: { campaign: "spring-sale" }, createdAt: at(-15) });

  // Ad spend of "Spring-Sale": two days inside the range, one outside it.
  await adSpend("Spring-Sale", at(-50), 3000, 40);
  await adSpend("SPRING-SALE ", at(-45), 1000, 10);
  await adSpend("Spring-Sale", at(-10), 99_999, 999);
  // An unrelated ad campaign never shows up.
  await adSpend("Brand awareness", at(-45), 5000, 100);
}, 120_000);
afterAll(() => h.close());

const kpis = (periodDays: number, range = RANGE) => getWebinarKpis(h.db, { ...range, periodDays });
const funnel = (periodDays: number, range = RANGE) => funnelByCampaign(h.db, { ...range, periodDays });

describe("getWebinarKpis", () => {
  it("counts the registrations made in the range, without cancelled and tester ones", async () => {
    const k = await kpis(30);
    expect(k.webinars).toBe(1);
    expect(k.registrations).toBe(4);
  });

  it("live attendance rate is live attended over live-mode registrations; registration is never attendance", async () => {
    const k = await kpis(30);
    // Live mode: lead 1 (attended), lead 2 (registered only), customer (100 s): 1 of 3.
    expect(k.liveAttendanceRate).toBeCloseTo(1 / 3);
    // The member's replay watch counts for the replay rate (one of four replay-eligible registrations).
    expect(k.replayViewRate).toBeCloseTo(1 / 4);
  });

  it("attendance and conversion per segment within the period", async () => {
    const d30 = await kpis(30);
    expect(d30.bySegment).toEqual({
      lead: { registrations: 2, attended: 1, converted: 1 },
      customer: { registrations: 1, attended: 0, converted: 0 },
      member: { registrations: 1, attended: 1, converted: 1 },
    });
    expect(d30.conversionRate).toBeCloseTo(2 / 4);
    expect(d30.revenueCents).toBe(9000);

    // The lead's booking is 10 days after the start: outside a 7-day window.
    const d7 = await kpis(7);
    expect(d7.bySegment.lead).toEqual({ registrations: 2, attended: 1, converted: 0 });
    expect(d7.bySegment.member.converted).toBe(1);
    expect(d7.conversionRate).toBeCloseTo(1 / 4);
  });

  it("groups by the normalised UTM campaign", async () => {
    const k = await kpis(30);
    expect(k.byUtmCampaign).toEqual([
      { campaign: "spring-sale", registrations: 2, attended: 1, converted: 1 },
      { campaign: "autumn", registrations: 1, attended: 0, converted: 0 },
      { campaign: null, registrations: 1, attended: 1, converted: 1 },
    ]);
  });

  it("respects the registration range", async () => {
    const empty = await kpis(30, { from: at(-30), to: at(-20) });
    expect(empty).toMatchObject({ webinars: 0, registrations: 0, liveAttendanceRate: 0, replayViewRate: 0, conversionRate: 0, revenueCents: 0, byUtmCampaign: [] });
    expect(empty.bySegment.lead).toEqual({ registrations: 0, attended: 0, converted: 0 });

    const wide = await kpis(30, { from: at(-60), to: at(0) });
    expect(wide).toMatchObject({ webinars: 2, registrations: 5 });
    expect(wide.byUtmCampaign.find((c) => c.campaign === "spring-sale")?.registrations).toBe(3);
  });
});

describe("funnelByCampaign", () => {
  it("joins ad spend on utm.campaign = campaign_name of the range's days: cost per registration and click-to-registration rate", async () => {
    const rows = await funnel(30);
    const spring = rows.find((r) => r.campaign === "spring-sale");
    // 3000 + 1000 cents and 40 + 10 clicks inside the range; the day 10 days ago is outside it.
    expect(spring).toEqual({
      campaign: "spring-sale",
      registrations: 2,
      attended: 1,
      firstVisit: 1,
      firstPurchase: 0,
      spendCents: 4000,
      costPerRegistrationCents: 2000,
      clickToRegistrationRate: 2 / 50,
    });
  });

  it("a campaign without ad rows, and no campaign, give null spend, cost and rate (never 0)", async () => {
    const rows = await funnel(30);
    expect(rows.find((r) => r.campaign === "autumn")).toMatchObject({ registrations: 1, attended: 0, spendCents: null, costPerRegistrationCents: null, clickToRegistrationRate: null });
    expect(rows.find((r) => r.campaign === null)).toMatchObject({ registrations: 1, attended: 1, firstPurchase: 1, spendCents: null, costPerRegistrationCents: null, clickToRegistrationRate: null });
    expect(rows.map((r) => r.campaign)).not.toContain("brand awareness");
  });

  it("first visit and first purchase count within the period only", async () => {
    const d7 = await funnel(7);
    // The visit is 12 days after the start (outside 7 days); the purchase 2 days after the member's anchor.
    expect(d7.find((r) => r.campaign === "spring-sale")).toMatchObject({ firstVisit: 0 });
    expect(d7.find((r) => r.campaign === null)).toMatchObject({ firstPurchase: 1 });
  });

  it("a wider range adds the later registration and the later spend day", async () => {
    const rows = await funnel(30, { from: at(-60), to: at(0) });
    const spring = rows.find((r) => r.campaign === "spring-sale");
    expect(spring).toMatchObject({ registrations: 3, spendCents: 4000 + 99_999 });
    expect(spring?.clickToRegistrationRate).toBeCloseTo(3 / (50 + 999));
    expect(spring?.costPerRegistrationCents).toBe(Math.round((4000 + 99_999) / 3));
  });
});

describe("the report's UTM table (webinar-P7)", () => {
  it("adds the campaign's spend of the webinar's registration days, cost per registration and click-to-registration rate", async () => {
    const r = await getWebinarReport(h.db, w.id, { periodDays: 30 });
    // Registrations ran from 45 to 39 days ago: only the ad day 45 days ago (1000 cents, 10 clicks)
    // falls inside. The report counts every registration of the campaign (three, the tester's
    // included, like every report count) across its sources and spellings.
    const spring = r.utm.filter((u) => u.campaign?.trim().toLowerCase() === "spring-sale");
    expect(spring.reduce((a, u) => a + u.registrations, 0)).toBe(3);
    for (const u of spring) expect(u).toMatchObject({ spendCents: 1000, costPerRegistrationCents: 333, clickToRegistrationRate: 3 / 10 });
    expect(r.utm.find((u) => u.campaign === "autumn")).toMatchObject({ registrations: 1, spendCents: null, costPerRegistrationCents: null, clickToRegistrationRate: null });
    expect(r.utm.find((u) => u.campaign === null)).toMatchObject({ spendCents: null, costPerRegistrationCents: null, clickToRegistrationRate: null });
  });

  it("the aggregate CSV carries the spend columns", async () => {
    const csv = buildReportCsv(await getWebinarReport(h.db, w.id, { periodDays: 30 }));
    expect(csv).toContain("utm_source,utm_campaign,registrations,attended,converted,spend_cents,cost_per_registration_cents,click_to_registration_rate_pct");
    expect(csv).toMatch(/,1000,333,30\.0\r\n/);
  });
});

describe("UtmTable (webinar-P7)", () => {
  const labels: UtmTableLabels = { title: "UTM", empty: "none yet", source: "Source", campaign: "Campaign", none: "(none)", registrations: "Reg", attended: "Att", converted: "Conv" };
  const row = (over: Partial<UtmRow>): UtmRow => ({
    source: "meta",
    campaign: "spring-sale",
    registrations: 2,
    attended: 1,
    converted: 1,
    spendCents: null,
    costPerRegistrationCents: null,
    clickToRegistrationRate: null,
    ...over,
  });
  const html = (rows: UtmRow[]) => renderToStaticMarkup(createElement(UtmTable, { rows, labels, locale: "en" }));

  it("shows the spend columns from the catalogue when a campaign has ad rows, and 'No ad spend' for one without", () => {
    const out = html([row({ spendCents: 4000, costPerRegistrationCents: 2000, clickToRegistrationRate: 0.04 }), row({ campaign: "autumn" })]);
    expect(out).toContain("Ad spend");
    expect(out).toContain("Cost per registration");
    expect(out).toContain("Click-to-registration rate");
    expect(out).toContain("€");
    expect(out).toContain("4%");
    expect(out).toContain("No ad spend");
  });

  it("leaves the spend columns out when no campaign has ad rows", () => {
    const out = html([row({})]);
    expect(out).not.toContain("Ad spend");
    expect(out).not.toContain("No ad spend");
  });
});
