import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "../src/client";
import { enqueue } from "../src/enqueue";
import { jobs } from "../src/schema/platform";
import { createTestDb } from "../src/testing";

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
});
afterAll(() => h.close());

describe("enqueue", () => {
  it("inserts a job with the runner's defaults", async () => {
    const result = await enqueue(h.db, {
      kind: "jobs.prune",
      payload: { a: 1 },
      key: "test:defaults",
    });
    expect(result.inserted).toBe(true);
    const [row] = await h.db.select().from(jobs).where(eq(jobs.id, result.id));
    expect(row).toMatchObject({
      kind: "jobs.prune",
      payload: { a: 1 },
      idempotencyKey: "test:defaults",
      lane: "fast",
      priority: 5,
      status: "pending",
      attempts: 0,
      maxAttempts: 6,
      requestId: null,
    });
  });

  it("returns the existing row for a key that already exists (PL-24)", async () => {
    const first = await enqueue(h.db, {
      kind: "email.send",
      payload: { n: 1 },
      key: "email:same",
    });
    const second = await enqueue(h.db, {
      kind: "email.send",
      payload: { n: 2 },
      key: "email:same",
    });
    expect(first.inserted).toBe(true);
    expect(second).toEqual({ id: first.id, inserted: false });
    const rows = await h.db
      .select()
      .from(jobs)
      .where(eq(jobs.idempotencyKey, "email:same"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toEqual({ n: 1 });
  });

  it("honours an explicit id, lane, priority, run time and request id", async () => {
    const id = randomUUID();
    const runAt = new Date("2030-01-01T10:00:00Z");
    const result = await enqueue(h.db, {
      id,
      kind: "webhook.process",
      payload: {},
      key: "webhook:mollie:tr_1",
      lane: "bulk",
      priority: 2,
      maxAttempts: 3,
      runAt,
      requestId: "req-1",
    });
    expect(result).toEqual({ id, inserted: true });
    const [row] = await h.db.select().from(jobs).where(eq(jobs.id, id));
    expect(row).toMatchObject({
      lane: "bulk",
      priority: 2,
      maxAttempts: 3,
      requestId: "req-1",
    });
    expect(row?.runAt.toISOString()).toBe(runAt.toISOString());
  });

  it("works inside a transaction and rolls back with it", async () => {
    await h.db
      .transaction(async (tx) => {
        await enqueue(tx, {
          kind: "jobs.prune",
          payload: {},
          key: "test:rollback",
        });
        throw new Error("rollback");
      })
      .catch(() => undefined);
    const rows = await h.db
      .select()
      .from(jobs)
      .where(eq(jobs.idempotencyKey, "test:rollback"));
    expect(rows).toHaveLength(0);
  });

  it("rejects a kind that is not <module>.<verb_noun>", async () => {
    await expect(
      enqueue(h.db, { kind: "NotAKind", payload: {}, key: "test:bad-kind" }),
    ).rejects.toThrow();
  });
});
