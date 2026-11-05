/**
 * Rule 75: one case per marketing KPI on a September 2026 fixture. webinar's `getWebinarKpis` is
 * mocked to its contract: its `liveAttendanceRate` counts a live viewer at `attended_min_sec`
 * and not one at `attended_min_sec - 1`.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type DbHandle } from "@beam/db/testing";
import { makeUser } from "@beam/db/testing/factories";
import { makePaidOrder } from "@beam/db/testing/commerce-factories";
import { campaigns, emailMessages, emailTemplates, emailTemplateVersions, formSubmissions, formVersions, forms, importedHistory, webinarRegistrations, webinars } from "@beam/db/schema";
import { sql } from "@/lib/ctx";
import type { WebinarKpis } from "@/modules/webinar/api";
import { makeBooking, makeCustomer, makeHistory } from "../stats/ops-p2.fixtures";

vi.mock("@/modules/webinar/api", async (orig) => ({ ...(await orig<typeof import("@/modules/webinar/api")>()), getWebinarKpis: vi.fn() }));
const { getWebinarKpis } = await import("@/modules/webinar/api");
const { computeMarketingKpis, kpiRowsOf, previousRange } = await import("./kpis-marketing");

const day = (iso: string) => new Date(`${iso}T10:00:00.000Z`);
const RANGE = { from: "2026-09-01", to: "2026-09-30" };
const ATTENDED_MIN_SEC = 300;
/** Live watch seconds of the two live registrations: one exactly at the threshold, one a second short. */
const LIVE_WATCH = [ATTENDED_MIN_SEC, ATTENDED_MIN_SEC - 1];

/** The contract of `getWebinarKpis().liveAttendanceRate`: registrations with a live watch of at least `attended_min_sec` / live registrations. */
function webinarKpisFor(watch: number[]): WebinarKpis {
  const attended = watch.filter((s) => s >= ATTENDED_MIN_SEC).length;
  return {
    webinars: 1,
    registrations: watch.length,
    liveAttendanceRate: watch.length ? attended / watch.length : 0,
    replayViewRate: 0,
    conversionRate: 0,
    revenueCents: 0,
    bySegment: { lead: { registrations: 2, attended, converted: 1 }, customer: { registrations: 0, attended: 0, converted: 0 }, member: { registrations: 0, attended: 0, converted: 0 } },
    byUtmCampaign: [],
  };
}

let h: DbHandle;
let k: Awaited<ReturnType<typeof computeMarketingKpis>>;

beforeAll(async () => {
  h = await createTestDb();
  const db = h.db;
  const staff = await makeUser(db, { roleKey: "marketing" });
  const [w] = await db
    .insert(webinars)
    .values({ slug: "kpi-live", title: { en: "Live", "nl-BE": "Live", "fr-BE": "Live" }, mode: "live", startsAt: day("2026-09-20"), attendedMinSec: ATTENDED_MIN_SEC, ownerUserId: staff.id, createdByUserId: staff.id })
    .returning();
  const register = (personId: string, at: Date, mode: "live" | "on_demand", personStatus: "lead" | "customer" | "member") =>
    db.insert(webinarRegistrations).values({ webinarId: w!.id, personId, registeredMode: mode, accessTokenHash: randomUUID(), source: "site", locale: "nl-BE", personStatus, createdAt: at });

  // Leads (rule 75: not imported, no paid order when created, testers excluded).
  const l1 = await makeCustomer(db, { createdAt: day("2026-09-05"), acquisition: { source: "paid_meta", campaign: "x" } });
  const l2 = await makeCustomer(db, { createdAt: day("2026-09-10"), acquisition: { source: "website" } });
  await makeCustomer(db, { createdAt: day("2026-09-12"), acquisition: { source: "import" } });
  const l4 = await makeCustomer(db, { createdAt: day("2026-09-15"), acquisition: { source: "website" } });
  await makePaidOrder(db, { personId: l4.id, order: { paidAt: day("2026-09-14") } });
  await makeCustomer(db, { createdAt: day("2026-09-05"), isTester: true, acquisition: { source: "website" } });

  // L1: registers live, books (13 days later), first visit 20 Sep, first purchase 25 Sep.
  await register(l1.id, day("2026-09-06"), "live", "lead");
  await makeBooking(db, { personId: l1.id, startsAt: day("2026-09-20"), status: "attended", createdAt: day("2026-09-19") });
  await makePaidOrder(db, { personId: l1.id, order: { paidAt: day("2026-09-25") } });
  await register(l2.id, day("2026-09-11"), "live", "lead");
  // A customer registers on demand and buys two days later; another has a first visit and no purchase.
  const r3 = await makeCustomer(db, { createdAt: day("2026-07-01"), acquisition: { source: "website" } });
  await register(r3.id, day("2026-09-04"), "on_demand", "customer");
  await makePaidOrder(db, { personId: r3.id, order: { paidAt: day("2026-09-06") } });
  const c1 = await makeCustomer(db, { createdAt: day("2026-07-01"), acquisition: { source: "website" } });
  await makeBooking(db, { personId: c1.id, startsAt: day("2026-09-02"), status: "attended" });

  // Registration rate: 6 delivered invitations of an events campaign, one bounce, two newsletters.
  const tpl = async (purpose: "events" | "newsletter") => (await db.insert(emailTemplates).values({ slug: `kpi-${purpose}`, name: purpose, kind: "marketing", purpose, status: "published" }).returning())[0]!;
  for (const purpose of ["events", "newsletter"] as const) {
    const template = await tpl(purpose);
    const [tv] = await db.insert(emailTemplateVersions).values({ templateId: template.id, version: 1, document: { schemaVersion: 1, locales: {} } as never, publishedAt: day("2026-08-01") }).returning();
    const [c] = await db.insert(campaigns).values({ name: `kpi ${purpose}`, templateId: template.id, templateVersionId: tv!.id, purpose, status: "sent", createdByUserId: staff.id }).returning();
    const delivered = purpose === "events" ? 6 : 2;
    for (let i = 0; i < delivered + (purpose === "events" ? 1 : 0); i++) {
      const bounced = i >= delivered;
      await db.insert(emailMessages).values({
        personId: c1.id, kind: "campaign", campaignId: c!.id, templateVersionId: tv!.id, purpose, locale: "nl-BE", idempotencyKey: `kpi:${purpose}:${i}`,
        status: bounced ? "bounced" : "delivered", sentAt: day("2026-09-03"), ...(bounced ? { bouncedAt: day("2026-09-03") } : { deliveredAt: day("2026-09-03") }),
      });
    }
  }

  // Imported webinar history: two registrations, one live attendance, one replay attendance.
  const i1 = await makeCustomer(db, { createdAt: day("2026-06-01") });
  const i2 = await makeCustomer(db, { createdAt: day("2026-06-01") });
  const seed = await makeHistory(db, { personId: i1.id, kind: "webinar_registration", occurredAt: day("2026-09-03") });
  await makeHistory(db, { personId: i2.id, kind: "webinar_registration", occurredAt: day("2026-09-03") });
  for (const [personId, mode] of [[i1.id, "live"], [i2.id, "replay"]] as const) {
    await db.insert(importedHistory).values({ personId, importId: seed.importId, source: "webinar_tool", kind: "webinar_attendance", occurredAt: day("2026-09-03"), externalId: randomUUID(), data: { mode } });
  }
  // Events: attended / confirmed (confirmed, attended or no-show).
  await makeBooking(db, { personId: i1.id, startsAt: day("2026-09-08"), status: "attended", kind: "event" });
  await makeBooking(db, { personId: i2.id, startsAt: day("2026-09-09"), status: "confirmed", kind: "event" });
  await makeBooking(db, { personId: c1.id, startsAt: day("2026-09-09"), status: "no_show", kind: "event" });

  // Assessments: three started in September, two completed; L1's completion converts within 60 days.
  const [form] = await db.insert(forms).values({ slug: "kpi-assessment", kind: "assessment", name: { "nl-BE": "A", "fr-BE": "A", en: "A" } }).returning();
  const [v] = await db.insert(formVersions).values({ formId: form!.id, version: 1, definition: {} as never, definitionHash: "kpi", publishedAt: day("2026-08-01") }).returning();
  const submission = (personId: string, completed: boolean) => ({
    formId: form!.id, formVersionId: v!.id, personId, locale: "nl-BE" as const, funnel: "form:kpi-assessment", startedAt: day("2026-09-07"),
    status: completed ? ("completed" as const) : ("started" as const), ...(completed ? { completedAt: day("2026-09-07") } : {}),
  });
  await db.insert(formSubmissions).values([submission(l1.id, true), submission(l2.id, true), submission(c1.id, false)]);

  // Reactivation: a purchase in April and one in September (gap over 90 days).
  const rv = await makeCustomer(db, { createdAt: day("2026-01-01") });
  await makePaidOrder(db, { personId: rv.id, order: { paidAt: day("2026-04-01") } });
  await makePaidOrder(db, { personId: rv.id, lines: [{ unitAmountCents: 5_000 }], order: { paidAt: day("2026-09-15") } });

  // Rule 40: one abandoned checkout in the range.
  await db.execute(sql`insert into checkouts (person_id, channel, items, total_cents, created_at, last_activity_at, abandoned_at, abandoned_reason)
    values (${c1.id}::uuid, 'site', '[]'::jsonb, 4500, ${day("2026-09-04").toISOString()}::timestamptz, ${day("2026-09-04").toISOString()}::timestamptz, ${day("2026-09-04").toISOString()}::timestamptz, 'left')`);
});
afterAll(() => h.close());
beforeEach(async () => {
  vi.mocked(getWebinarKpis).mockReset().mockResolvedValue(webinarKpisFor(LIVE_WATCH));
  k = await computeMarketingKpis(h.db, RANGE);
});

describe("marketing KPIs (rule 75)", () => {
  it("R75: leads generated exclude imports, people who had paid before creation and testers, split by source and campaign", () => {
    expect(k.current.leads).toBe(2);
    expect(k.current.leadsBySource).toEqual([
      { source: "meta", campaign: "x", leads: 1 },
      { source: "website", campaign: null, leads: 1 },
    ]);
    expect(k.previous.leads).toBe(0);
    expect(k.previousRange).toEqual(previousRange(RANGE));
    expect(k.previousRange).toEqual({ from: "2026-08-02", to: "2026-08-31" });
  });

  it("R75: registration rate = webinar registrations / delivered invitations of events campaigns", () => {
    expect(k.current.registrationRate).toEqual({ numerator: 3, denominator: 6, rate: 0.5 });
  });

  it("R75: attendance counts a live viewer at attended_min_sec and not one at attended_min_sec - 1; imported live attendance counts", () => {
    expect(getWebinarKpis).toHaveBeenCalled();
    const a = k.current.attendance;
    expect(a.nativeRate).toBe(0.5);
    expect(a.nativeLiveRegistrations).toBe(2);
    expect(a.imported).toEqual({ numerator: 1, denominator: 2, rate: 0.5 });
    expect(a.combined).toEqual({ numerator: 2, denominator: 4, rate: 0.5 });
    expect(a.events).toEqual({ numerator: 1, denominator: 3, rate: 1 / 3 });
  });

  it("R75: lead-to-visit and visit-to-purchase", () => {
    expect(k.current.leadToVisit).toEqual({ numerator: 1, denominator: 2, rate: 0.5 });
    expect(k.current.visitToPurchase).toEqual({ numerator: 1, denominator: 2, rate: 0.5 });
  });

  it("R75: assessment completion and conversion", () => {
    expect(k.current.assessmentCompletion).toEqual({ numerator: 2, denominator: 3, rate: 2 / 3 });
    expect(k.current.assessmentConversion).toEqual({ numerator: 1, denominator: 2, rate: 0.5 });
  });

  it("R75: webinar conversion within 7, 30 and 90 days by lead, customer and member", () => {
    const c = k.current.webinarConversion;
    expect([c.lead.d7.numerator, c.lead.d30.numerator, c.lead.d90.numerator, c.lead.d30.denominator]).toEqual([0, 1, 1, 2]);
    expect(c.customer.d7).toEqual({ numerator: 1, denominator: 1, rate: 1 });
    expect(c.member.d30).toEqual({ numerator: 0, denominator: 0, rate: null });
  });

  it("R75: reactivation revenue counts orders after a gap of more than 90 days", () => {
    expect(k.current.reactivationRevenueCents).toBe(5_000);
    expect(k.current.reactivationOrders).toBe(1);
  });

  it("R75 and R40: abandoned-cart recovery comes from the abandoned checkouts report", () => {
    expect(k.current.abandoned).toMatchObject({ abandoned: 1, recovered: 0, recoveryRate: 0 });
    expect(kpiRowsOf(k).map((r) => r.key)).toContain("abandoned_recovery_rate");
  });
});
