/**
 * commerce-P4b mandates (ops rule 62, section 9): `revokeMandatesForPerson` revokes every valid
 * mandate, enqueues one `commerce.revoke_mandate` job each, returns the count, and a second call
 * returns 0; other people's and already invalid mandates are untouched; `getActiveMandate`
 * returns the latest valid mandate.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson } from "@beam/db/testing";
import type { DbHandle, Tx } from "@beam/db";
import { jobs, mandates } from "@beam/db/schema";

vi.mock("next/headers", () => ({ cookies: () => Promise.resolve({ get: () => undefined }), headers: () => Promise.resolve(new Headers()) }));
vi.mock("next/server", () => ({ after: () => undefined }));

const { revokeMandatesForPerson } = await import("./mandates");
const { getActiveMandate } = await import("./recurring");
const { createCtx, eq, and, inArray } = await import("@/lib/ctx");
const { makeCtx, resetRuntime, createFakeIntegrations } = await import("@/lib/testing");

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
  makeCtx(h.db, { integrations: createFakeIntegrations() });
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

const NOW = new Date("2026-11-04T10:00:00.000Z");
const inTx = <T>(fn: (tx: Tx, ctx: ReturnType<typeof createCtx>) => Promise<T>) =>
  h.db.transaction((tx) => fn(tx, createCtx({ tx, actor: { kind: "system", jobId: "" }, durableMode: "immediate", now: NOW })));

async function mandate(personId: string, status: "valid" | "invalid" | "pending" = "valid", createdAt?: Date) {
  const [row] = await h.db
    .insert(mandates)
    .values({ personId, provider: "mollie", providerMandateId: `mdt_${randomUUID().slice(0, 10)}`, providerCustomerId: `cst_${randomUUID().slice(0, 8)}`, method: "directdebit", detailsSummary: "BE** 0000", status, ...(createdAt ? { createdAt } : {}) })
    .returning();
  return row!;
}

describe("revokeMandatesForPerson", () => {
  it("revokes every valid mandate with one job each; a second call returns 0", async () => {
    const person = await makePerson(h.db);
    const other = await makePerson(h.db);
    const older = await mandate(person.id, "valid", new Date("2026-01-01T00:00:00Z"));
    const newer = await mandate(person.id, "valid", new Date("2026-06-01T00:00:00Z"));
    const invalid = await mandate(person.id, "invalid");
    const others = await mandate(other.id, "valid");
    expect(await getActiveMandate(h.db, person.id)).toEqual({ mandateId: newer.id, method: "directdebit", summary: "BE** 0000" });

    expect(await inTx((tx, ctx) => revokeMandatesForPerson(tx, ctx, person.id))).toEqual({ revoked: 2 });
    const rows = await h.db.select().from(mandates).where(inArray(mandates.id, [older.id, newer.id, invalid.id, others.id]));
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(older.id)).toMatchObject({ status: "revoked" });
    expect(byId.get(older.id)!.revokedAt?.toISOString()).toBe(NOW.toISOString());
    expect(byId.get(newer.id)).toMatchObject({ status: "revoked" });
    expect(byId.get(invalid.id)).toMatchObject({ status: "invalid", revokedAt: null });
    expect(byId.get(others.id)).toMatchObject({ status: "valid" });

    for (const m of [older, newer]) {
      const queued = await h.db.select().from(jobs).where(and(eq(jobs.kind, "commerce.revoke_mandate"), eq(jobs.idempotencyKey, `mandate_revoke:${m.id}`)));
      expect(queued).toHaveLength(1);
      expect(queued[0]!.payload).toEqual({ mandateId: m.id });
    }
    expect(await h.db.select().from(jobs).where(eq(jobs.idempotencyKey, `mandate_revoke:${others.id}`))).toHaveLength(0);
    expect(await getActiveMandate(h.db, person.id)).toBeNull();

    expect(await inTx((tx, ctx) => revokeMandatesForPerson(tx, ctx, person.id))).toEqual({ revoked: 0 });
    expect(await h.db.select().from(jobs).where(eq(jobs.kind, "commerce.revoke_mandate"))).toHaveLength(2);
  });
});
