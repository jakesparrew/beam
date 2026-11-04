import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "@beam/db";
import { activityEvents, creditBulkExtensions, creditEntries, creditGrants, jobs as jobsTable } from "@beam/db/schema";
import { createTestDb, makeUser } from "@beam/db/testing";
import { makeCreditGrant } from "@beam/db/testing/credits-factories";
import { brusselsDateKey, computeExpiresAt } from "@beam/core/credits";
import { asc, eq, inArray, sql } from "@/lib/ctx";
import { loadJobs, loadSchedules } from "@/lib/job-runner";
import { resetRuntime, runJobTwice } from "@/lib/testing";
import { jobs } from "./jobs";

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  await h.db.execute(sql`delete from jobs`);
});

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);
const grant = (over: Parameters<typeof makeCreditGrant>[1]) =>
  makeCreditGrant(h.db, { startsAt: ago(60), source: "import", vatTreatment: "single_purpose", ...over });

/** Runs the job twice and asserts the state `snapshot` reads is the same after each run. */
async function twice(kind: Parameters<typeof runJobTwice>[1], payload: unknown, snapshot: () => Promise<unknown>) {
  let afterFirst: unknown;
  const result = await runJobTwice(h.db, kind, payload, { between: async () => void (afterFirst = await snapshot()) });
  expect(await snapshot()).toEqual(afterFirst);
  return { ...result, afterFirst };
}

describe("credits jobs run twice yield the same state", () => {
  it("covers every registered credits job and the expiry schedule", async () => {
    const registry = await loadJobs();
    for (const j of jobs) expect(registry[j.kind]).toBe(j);
    expect(jobs.map((j) => j.kind).sort()).toEqual(["credits.bulk_extend", "credits.expire_grant", "credits.expire_grants"]);
    expect((await loadSchedules()).filter((s) => s.kind.startsWith("credits."))).toEqual([{ kind: "credits.expire_grants", cron: "5 0 * * *", payload: {}, catchUp: true }]);
  });

  it("credits.expire_grant expires once: expire entry, status, credits.grant_expired", async () => {
    const g = await grant({ units: 3, expiresAt: ago(1) });
    const snapshot = async () => ({
      status: (await h.db.select({ s: creditGrants.status }).from(creditGrants).where(eq(creditGrants.id, g.id)))[0]!.s,
      entries: (await h.db.select({ kind: creditEntries.kind, q: creditEntries.quantity, key: creditEntries.idempotencyKey }).from(creditEntries).where(eq(creditEntries.grantId, g.id)).orderBy(asc(creditEntries.kind))),
      events: (await h.db.select({ kind: activityEvents.kind, data: activityEvents.data }).from(activityEvents).where(eq(activityEvents.refId, g.id))),
    });
    const { first, second, afterFirst } = await twice("credits.expire_grant", { grantId: g.id }, snapshot);
    expect(first).toEqual({ expired: true, units: 3 });
    expect(second).toEqual({ expired: false, units: 0 });
    expect(afterFirst).toEqual({
      status: "expired",
      entries: [
        { kind: "grant", q: 3, key: expect.any(String) },
        { kind: "expire", q: -3, key: `expire:${g.id}:${brusselsDateKey(g.expiresAt!)}` },
      ],
      events: [{ kind: "credits.grant_expired", data: { grant_id: g.id, credit_kind: "day", units: 3, source: "import" } }],
    });
  });

  it("credits.expire_grants enqueues one expire_grant per due grant and records expiry warnings once per window", async () => {
    const due = await grant({ units: 2, expiresAt: ago(0.5) });
    const exhaustedDue = await grant({ units: 1, expiresAt: ago(0.2), status: "exhausted" });
    const in7 = await grant({ units: 4, expiresAt: computeExpiresAt(new Date(), 7) });
    const in30 = await grant({ units: 1, creditKind: "euro", source: "manual", vatTreatment: "not_applicable", expiresAt: computeExpiresAt(new Date(), 30) });
    const in15 = await grant({ units: 1, expiresAt: computeExpiresAt(new Date(), 15) });
    const empty = await grant({ units: 1, expiresAt: computeExpiresAt(new Date(), 7), withEntry: false });
    const ids = [due, exhaustedDue, in7, in30, in15, empty].map((g) => g.id);
    const snapshot = async () => ({
      jobs: (await h.db.select({ kind: jobsTable.kind, key: jobsTable.idempotencyKey, payload: jobsTable.payload }).from(jobsTable).orderBy(asc(jobsTable.idempotencyKey))),
      warnings: (
        await h.db
          .select({ refId: activityEvents.refId, data: activityEvents.data, dedupeKey: activityEvents.dedupeKey })
          .from(activityEvents)
          .where(eq(activityEvents.kind, "credits.expiry_approaching"))
          .orderBy(asc(activityEvents.dedupeKey))
      ).filter((e) => ids.includes(e.refId!)),
    });
    const { first, second, afterFirst } = await twice("credits.expire_grants", {}, snapshot);
    expect(first).toMatchObject({ enqueued: 1, warnings: 2, continued: false });
    expect(second).toMatchObject({ enqueued: 1, warnings: 0 });
    const s = afterFirst as Awaited<ReturnType<typeof snapshot>>;
    expect(s.jobs).toEqual([{ kind: "credits.expire_grant", key: `expire:${due.id}:${brusselsDateKey(due.expiresAt!)}`, payload: { grantId: due.id } }]);
    const expected = [
      { refId: in30.id, data: { grant_id: in30.id, credit_kind: "euro", days: 30, remaining_units: 1 }, dedupeKey: `grant:${in30.id}:expiry:30:${brusselsDateKey(in30.expiresAt!)}` },
      { refId: in7.id, data: { grant_id: in7.id, credit_kind: "day", days: 7, remaining_units: 4 }, dedupeKey: `grant:${in7.id}:expiry:7:${brusselsDateKey(in7.expiresAt!)}` },
    ].sort((a, b) => a.dedupeKey.localeCompare(b.dedupeKey));
    expect(s.warnings).toEqual(expected);
    for (const w of s.warnings) expect(Object.keys(w.data as object).sort()).toEqual(["credit_kind", "days", "grant_id", "remaining_units"]);
  });

  it("credits.bulk_extend runs twice to the same state", async () => {
    const user = await makeUser(h.db);
    const g = await grant({ units: 2, expiresAt: new Date("2028-06-10T21:59:59.999Z") });
    const [row] = await h.db
      .insert(creditBulkExtensions)
      .values({ reason: "Summer closure", days: 7, filter: { kinds: ["day"], sources: ["import"], expires_from_on: "2028-06-10", expires_to_on: "2028-06-10" }, createdByUserId: user.id })
      .returning();
    const snapshot = async () => ({
      grant: (await h.db.select({ e: creditGrants.expiresAt }).from(creditGrants).where(eq(creditGrants.id, g.id)))[0]!.e,
      entries: (await h.db.select({ key: creditEntries.idempotencyKey }).from(creditEntries).where(inArray(creditEntries.kind, ["extend"]))).filter((e) => e.key.includes(row!.id)),
      row: (await h.db.select({ status: creditBulkExtensions.status, extended: creditBulkExtensions.extendedCount }).from(creditBulkExtensions).where(eq(creditBulkExtensions.id, row!.id)))[0],
    });
    const { afterFirst } = await twice("credits.bulk_extend", { bulkExtensionId: row!.id }, snapshot);
    expect(afterFirst).toEqual({
      grant: new Date("2028-06-17T21:59:59.999Z"),
      entries: [{ key: `extend:bulk:${row!.id}:${g.id}` }],
      row: { status: "done", extended: 1 },
    });
  });

  it("credits.expire_grants continues itself after 500 grants", async () => {
    const r = await runJobTwice(h.db, "credits.expire_grants", { runOn: "2026-01-01", afterId: randomUUID().replace(/^./, "f") });
    expect(r.first).toMatchObject({ warnings: 0, continued: false });
  });
});
