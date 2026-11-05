/**
 * forms-P6: `getFormReport` (forms spec section 4 "Queries", section 5 `/report`): completion rate
 * (completed / started), outcome distribution, conversion to booking and purchase within 30 days
 * with revenue (`v_form_conversions`), and the groupings by day, source, funnel, version and link.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@beam/db";
import { bookings, formLinks, formSubmissions, formVersions, formViewsDaily, type NewFormSubmissionRow } from "@beam/db/schema";
import { createTestDb, makePerson, makeSession, makeUser } from "@beam/db/testing";
import { makeOrder } from "@beam/db/testing/commerce-factories";
import { eq } from "@/lib/ctx";
import { resetRuntime } from "@/lib/testing";
import { assessment, createForm, setupEnv } from "./forms-p3.fixtures";
import { getFormReport } from "./queries";

let h: DbHandle;
beforeAll(async () => {
  setupEnv();
  h = await createTestDb();
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

const DAY = 86_400_000;
const D1 = new Date("2026-09-01T08:00:00Z"); // 10:00 in Brussels
const D2 = new Date("2026-09-02T08:00:00Z");

let runs = 0;

async function scenario() {
  const linkKey = `flyer${String(++runs).padStart(3, "0")}`;
  const content = assessment();
  const f = await createForm(h.db, content);
  const [v1] = await h.db.select().from(formVersions).where(eq(formVersions.id, f.versionId));
  const [v2] = await h.db.insert(formVersions).values({ ...v1!, id: undefined, version: 2, definitionHash: "v2-hash", publishedAt: new Date() }).returning();
  const staff = await makeUser(h.db, { roleKey: "marketing" });
  const [link] = await h.db.insert(formLinks).values({ formId: f.formId, key: linkKey, name: "Flyer Ghent", channel: "print", createdByUserId: staff.id }).returning();
  const [o1, o2] = content.scoring.outcomes.map((o) => o.key) as [string, string];
  const p1 = await makePerson(h.db);
  const p2 = await makePerson(h.db);
  const base = { formId: f.formId, locale: "en", funnel: "form:a" } as const;
  const done = (at: Date) => ({ status: "completed" as const, completedAt: new Date(at.getTime() + 60_000), startedAt: at });
  const rows: NewFormSubmissionRow[] = [
    { ...base, formVersionId: v1!.id, ...done(D1), personId: p1.id, outcomeKey: o1, path: ["about"] },
    { ...base, formVersionId: v1!.id, ...done(D1), personId: p2.id, outcomeKey: o1, path: ["about"] },
    { ...base, formVersionId: v1!.id, ...done(D1), funnel: "spring", source: "qr_code", linkId: link!.id, outcomeKey: o2, path: ["about"] },
    { ...base, formVersionId: v2!.id, startedAt: D1, funnel: "spring", source: "qr_code", linkId: link!.id, status: "abandoned", abandonedAt: new Date(D1.getTime() + DAY), path: ["about"] },
    { ...base, formVersionId: v2!.id, startedAt: D2, status: "started" },
    { ...base, formVersionId: v2!.id, startedAt: D2, status: "partial", path: ["about"] },
    // Outside the range: never counted.
    { ...base, formVersionId: v1!.id, ...done(new Date("2026-08-01T08:00:00Z")), personId: p1.id, outcomeKey: o2 },
  ];
  await h.db.insert(formSubmissions).values(rows);
  await h.db.insert(formViewsDaily).values([
    { formId: f.formId, dayOn: "2026-09-01", linkKey: "", locale: "en", views: 10 },
    { formId: f.formId, dayOn: "2026-09-01", linkKey, locale: "nl-BE", views: 5 },
    { formId: f.formId, dayOn: "2026-09-02", linkKey: "", locale: "en", views: 4 },
    { formId: f.formId, dayOn: "2026-08-01", linkKey: "", locale: "en", views: 99 },
  ]);
  // p1 books on day 5 (counts), p2 on day 31 (too late); p2 pays on day 3 (counts), p1 on day 40 (too late).
  const session = await makeSession(h.db);
  const completedAt = D1.getTime() + 60_000;
  await h.db.insert(bookings).values([
    { sessionId: session.id, personId: p1.id, status: "confirmed", paidWith: "free", source: "portal", createdAt: new Date(completedAt + 5 * DAY) },
    { sessionId: session.id, personId: p2.id, status: "confirmed", paidWith: "free", source: "portal", createdAt: new Date(completedAt + 31 * DAY) },
  ]);
  const pay = (personId: string, days: number, cents: number) =>
    makeOrder(h.db, { personId, channel: "portal", status: "paid", subtotalCents: cents, vatCents: 0, totalCents: cents, paidAt: new Date(completedAt + days * DAY) });
  await pay(p2.id, 3, 4500);
  await pay(p1.id, 40, 9900);
  return { f, o1, o2, v1: v1!, v2: v2!, linkKey };
}

describe("getFormReport", () => {
  it("totals: funnel, completion rate, outcome distribution and conversions within 30 days", async () => {
    const { f, o1, o2 } = await scenario();
    const r = await getFormReport(h.db, { formId: f.formId, from: "2026-09-01", to: "2026-09-30", groupBy: "day" });
    expect(r.totals).toMatchObject({ views: 19, started: 6, engaged: 5, completed: 3, abandoned: 1, linked: 2, booked: 1, purchased: 1, revenueCents: 4500 });
    expect(r.totals.completionRate).toBe(0.5);
    expect(r.totals.bookingRate).toBe(0.5);
    expect(r.totals.purchaseRate).toBe(0.5);
    expect(r.outcomes.map((o) => [o.key, o.count])).toEqual([
      [o1, 2],
      [o2, 1],
    ]);
    expect(r.outcomes[0]!.share).toBeCloseTo(2 / 3);
    expect(r.outcomes[0]!.label?.en).toBeTruthy();
    expect(r.groups.map((g) => [g.key, g.views, g.started, g.completed])).toEqual([
      ["2026-09-01", 15, 4, 3],
      ["2026-09-02", 4, 2, 0],
    ]);
  });

  it("groups by source and by funnel", async () => {
    const { f } = await scenario();
    const bySource = await getFormReport(h.db, { formId: f.formId, from: "2026-09-01", to: "2026-09-30", groupBy: "source" });
    const web = bySource.groups.find((g) => g.key === "website")!;
    const qr = bySource.groups.find((g) => g.key === "qr_code")!;
    expect(web).toMatchObject({ views: null, started: 4, completed: 2, linked: 2, booked: 1, purchased: 1, revenueCents: 4500 });
    expect(web.completionRate).toBe(0.5);
    expect(qr).toMatchObject({ started: 2, completed: 1, abandoned: 1, linked: 0, booked: 0 });
    const byFunnel = await getFormReport(h.db, { formId: f.formId, from: "2026-09-01", to: "2026-09-30", groupBy: "funnel" });
    expect(byFunnel.groups.map((g) => [g.key, g.started, g.completed])).toEqual([
      ["form:a", 4, 2],
      ["spring", 2, 1],
    ]);
  });

  it("groups by version (labelled with the version number) and by tracked link with its views", async () => {
    const { f, v1, v2, linkKey } = await scenario();
    const byVersion = await getFormReport(h.db, { formId: f.formId, from: "2026-09-01", to: "2026-09-30", groupBy: "version" });
    expect(byVersion.groups.map((g) => [g.key, g.version, g.started, g.completed, g.completionRate])).toEqual([
      [v1.id, 1, 3, 3, 1],
      [v2.id, 2, 3, 0, 0],
    ]);
    const byLink = await getFormReport(h.db, { formId: f.formId, from: "2026-09-01", to: "2026-09-30", groupBy: "link" });
    expect(byLink.groups.map((g) => [g.key, g.label, g.views, g.started])).toEqual([
      ["", "", 14, 4],
      [linkKey, "Flyer Ghent", 5, 2],
    ]);
  });

  it("an empty range has no starts and no rates", async () => {
    const { f } = await scenario();
    const r = await getFormReport(h.db, { formId: f.formId, from: "2027-01-01", to: "2027-01-31", groupBy: "source" });
    expect(r.totals).toMatchObject({ started: 0, completed: 0, completionRate: null, bookingRate: null, views: 0 });
    expect(r.groups).toEqual([]);
    expect(r.outcomes).toEqual([]);
  });
});
