import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@beam/db";
import { auditLog, creditBulkExtensions, creditEntries, creditGrants, jobs } from "@beam/db/schema";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import { makeCreditGrant, makeEntry } from "@beam/db/testing/credits-factories";
import { asc, eq, inArray, type Actor } from "@/lib/ctx";
import { makeCtx, resetRuntime, runJobTwice, staffActor } from "@/lib/testing";
import { previewBulkExtension, startBulkExtension } from "./bulk-extend";

let h: DbHandle;
let staff: Actor;
beforeAll(async () => {
  h = await createTestDb();
  staff = staffActor({ userId: (await makeUser(h.db)).id, permissions: ["credits.adjust"] });
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

// 20 March 2028, 23:59:59.999 Brussels (CET); +14 days crosses the DST change of 26 March.
const EXPIRES = new Date("2028-03-20T22:59:59.999Z");
const EXTENDED = new Date("2028-04-03T21:59:59.999Z");
const filter = { kinds: ["day", "night"] as ("day" | "night" | "euro")[], sources: ["purchase", "import", "voucher", "bonus", "manual"] as const, expiresFromOn: "2028-03-01", expiresToOn: "2028-03-31" };

describe("bulk extension (rule 32a)", () => {
  it("extends matching active and exhausted grants, skips membership, expired and non-matching ones, and re-runs harmlessly", async () => {
    const personId = (await makePerson(h.db)).id;
    const base = { personId, startsAt: new Date("2026-01-01T00:00:00Z"), expiresAt: EXPIRES, source: "import" as const, vatTreatment: "single_purpose" as const };
    const active = await makeCreditGrant(h.db, { ...base, units: 5 });
    const exhausted = await makeCreditGrant(h.db, { ...base, units: 1, source: "manual", vatTreatment: "not_applicable", status: "exhausted" });
    await makeEntry(h.db, { grantId: exhausted.id, kind: "consume", quantity: -1 });
    const membership = await makeCreditGrant(h.db, { ...base, source: "membership", vatTreatment: "not_applicable" });
    const expired = await makeCreditGrant(h.db, { ...base, status: "expired" });
    const outside = await makeCreditGrant(h.db, { ...base, creditKind: "night", expiresAt: new Date("2028-05-01T21:59:59.999Z") });
    const euro = await makeCreditGrant(h.db, { ...base, creditKind: "euro", source: "manual", vatTreatment: "not_applicable" });

    expect(await previewBulkExtension(h.db, { ...filter, sources: [...filter.sources] })).toEqual({ matched: 2 });
    const clientKey = randomUUID();
    const input = { days: 14, reason: "Closed for works", ...filter, sources: [...filter.sources], clientKey };
    const started = await startBulkExtension(h.db, makeCtx(h.db, staff), input);
    expect(started).toEqual({ bulkExtensionId: clientKey, matched: 2, created: true });
    expect(await startBulkExtension(h.db, makeCtx(h.db, staff), input)).toEqual({ bulkExtensionId: clientKey, matched: 2, created: false });
    expect(await h.db.select({ key: jobs.idempotencyKey }).from(jobs).where(eq(jobs.kind, "credits.bulk_extend"))).toEqual([{ key: `bulk_extend:${clientKey}:start` }]);
    expect((await h.db.select().from(auditLog).where(eq(auditLog.entityId, clientKey))).map((a) => a.action)).toEqual(["credits.bulk_extended"]);

    const ids = [active, exhausted, membership, expired, outside, euro].map((g) => g.id);
    const snapshot = async () => ({
      grants: (await h.db.select({ id: creditGrants.id, expiresAt: creditGrants.expiresAt, status: creditGrants.status }).from(creditGrants).where(inArray(creditGrants.id, ids)).orderBy(asc(creditGrants.id))),
      extends: (await h.db.select({ key: creditEntries.idempotencyKey, data: creditEntries.data }).from(creditEntries).where(eq(creditEntries.kind, "extend")).orderBy(asc(creditEntries.idempotencyKey))),
    });
    let afterFirst: unknown;
    const r = await runJobTwice(h.db, "credits.bulk_extend", { bulkExtensionId: clientKey }, { between: async () => void (afterFirst = await snapshot()) });
    expect(await snapshot()).toEqual(afterFirst);
    expect(r.first).toMatchObject({ processed: 2, extended: 2, done: true });

    const byId = new Map((await snapshot()).grants.map((g) => [g.id, g]));
    expect(byId.get(active.id)).toMatchObject({ expiresAt: EXTENDED, status: "active" });
    expect(byId.get(exhausted.id)).toMatchObject({ expiresAt: EXTENDED, status: "exhausted" });
    for (const g of [membership, expired, outside, euro]) expect(byId.get(g.id)!.expiresAt).toEqual(g.expiresAt);
    const [ext] = await h.db.select().from(creditEntries).where(eq(creditEntries.idempotencyKey, `extend:bulk:${clientKey}:${active.id}`));
    expect(ext).toMatchObject({ quantity: 0, refType: "bulk_extension", refId: clientKey, data: { old_expires_at: EXPIRES.toISOString(), new_expires_at: EXTENDED.toISOString(), reason: "Closed for works" } });
    const [row] = await h.db.select().from(creditBulkExtensions).where(eq(creditBulkExtensions.id, clientKey));
    expect(row).toMatchObject({ status: "done", matchedCount: 2, extendedCount: 2 });
    expect(row!.finishedAt).not.toBeNull();
    const [g] = await h.db.select({ data: creditGrants.data }).from(creditGrants).where(eq(creditGrants.id, active.id));
    expect(g!.data).toMatchObject({ last_bulk_extension_id: clientKey });
  });

  it("fix-w09-credits-review 5: end-of-day expiries stay 23:59:59.999 Brussels across DST days", async () => {
    const personId = (await makePerson(h.db)).id;
    const base = { personId, startsAt: new Date("2026-01-01T00:00:00Z"), source: "import" as const, vatTreatment: "single_purpose" as const, units: 5 };
    const cases = [
      { from: "2026-10-25T22:59:59.999Z", to: "2026-11-01T22:59:59.999Z" }, // end of 25 Oct (25-hour day) -> end of 1 Nov
      { from: "2026-03-22T22:59:59.999Z", to: "2026-03-29T21:59:59.999Z" }, // end of 22 Mar -> end of 29 Mar (23-hour day)
      { from: "2026-10-18T21:59:59.999Z", to: "2026-10-25T22:59:59.999Z" }, // end of 18 Oct -> end of 25 Oct (25-hour day)
    ];
    const grants = [];
    for (const c of cases) grants.push(await makeCreditGrant(h.db, { ...base, expiresAt: new Date(c.from) }));
    const clientKey = randomUUID();
    const dstFilter = { ...filter, sources: [...filter.sources], expiresFromOn: "2026-03-01", expiresToOn: "2026-10-31" };
    expect(await startBulkExtension(h.db, makeCtx(h.db, staff), { days: 7, reason: "Closed for works", ...dstFilter, clientKey })).toMatchObject({ matched: 3, created: true });
    await runJobTwice(h.db, "credits.bulk_extend", { bulkExtensionId: clientKey });
    for (const [i, c] of cases.entries()) {
      const [g] = await h.db.select({ expiresAt: creditGrants.expiresAt }).from(creditGrants).where(eq(creditGrants.id, grants[i]!.id));
      expect(g!.expiresAt!.toISOString()).toBe(c.to);
    }
  });

  it("refuses membership as a source and non-staff actors", async () => {
    const bad = { days: 3, reason: "Holiday", ...filter, sources: ["membership"], clientKey: randomUUID() };
    await expect(startBulkExtension(h.db, makeCtx(h.db, staff), bad)).rejects.toMatchObject({ code: "validation" });
    const ok = { days: 3, reason: "Holiday", ...filter, sources: [...filter.sources], clientKey: randomUUID() };
    await expect(startBulkExtension(h.db, makeCtx(h.db), ok)).rejects.toMatchObject({ code: "validation" });
  });
});
