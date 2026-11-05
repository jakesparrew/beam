/**
 * fix-w21-crm-wiring (email-P10 request): `getSegmentAggregates(tx, segmentId, now)` counts a
 * segment's stored audience per commercial status and language and gives the median days since
 * the last visit, without returning any member. Exclusions and erased persons do not count.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, makePerson } from "@beam/db/testing";
import { makePaidOrder } from "@beam/db/testing/commerce-factories";
import type { DbHandle } from "@beam/db";
import { personStats, segmentMembers } from "@beam/db/schema";

process.env.SENSITIVE_DATA_KEY_V1 ??= randomBytes(32).toString("base64");

const api = await import("@/modules/crm/api");
const fixtures = await import("./test-fixtures");
const { setAppDb } = await import("@/lib/ctx");
const { resetRuntime } = await import("@/lib/testing");

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
  await fixtures.ensurePersonProfileView(h.db);
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

const NOW = new Date("2026-11-10T09:00:00Z");
const DAY = 86_400_000;
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY);

async function members(segmentId: string, personIds: string[]) {
  await h.db.insert(segmentMembers).values(personIds.map((personId) => ({ segmentId, personId, source: "manual" as const })));
}

describe("getSegmentAggregates", () => {
  it("returns null for an unknown segment", async () => {
    expect(await api.getSegmentAggregates(h.db, "00000000-0000-4000-8000-00000000abcd", NOW)).toBeNull();
  });

  it("an empty segment has zero counts and no median", async () => {
    const id = await fixtures.insertSegment(h.db, { name: "Empty", kind: "static" });
    expect(await api.getSegmentAggregates(h.db, id, NOW)).toEqual({
      id,
      name: "Empty",
      total: 0,
      byStatus: { lead: 0, customer: 0, member: 0 },
      byLocale: { "nl-BE": 0, "fr-BE": 0, en: 0 },
      medianDaysSinceLastVisit: null,
    });
  });

  it("counts the audience per status and locale, minus exclusions and erased persons, with the median days since the last visit", async () => {
    const lead = await makePerson(h.db, { locale: "nl-BE" });
    const customer = await makePerson(h.db, { locale: "fr-BE" });
    const visitorA = await makePerson(h.db, { locale: "en" });
    const visitorB = await makePerson(h.db, { locale: "nl-BE" });
    const excluded = await makePerson(h.db, { locale: "en" });
    const erased = await makePerson(h.db, { locale: "en", erasedAt: daysAgo(1) });
    await makePaidOrder(h.db, { personId: customer.id, lines: [{ productKind: "session" }] });
    await h.db.insert(personStats).values([
      { personId: visitorA.id, lastVisitAt: daysAgo(10) },
      { personId: visitorB.id, lastVisitAt: daysAgo(20) },
    ]);

    const exclusion = await fixtures.insertSegment(h.db, { name: "Exclusion", kind: "static" });
    await members(exclusion, [excluded.id]);
    const id = await fixtures.insertSegment(h.db, { name: "Audience", kind: "static", excludeSegmentIds: [exclusion] });
    await members(id, [lead.id, customer.id, visitorA.id, visitorB.id, excluded.id, erased.id]);

    const agg = (await api.getSegmentAggregates(h.db, id, NOW))!;
    expect(agg).toMatchObject({ id, name: "Audience", total: 4, byLocale: { "nl-BE": 2, "fr-BE": 1, en: 1 } });
    expect(agg.byStatus).toEqual({ lead: 3, customer: 1, member: 0 });
    expect(agg.medianDaysSinceLastVisit).toBe(15);
    // Counts only: no person id or field leaves crm.
    expect(JSON.stringify(agg)).not.toContain(lead.id);
  });
});
