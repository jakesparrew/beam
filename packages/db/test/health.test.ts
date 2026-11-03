import { afterAll, describe, expect, it } from "vitest";
import { checkDatabase } from "../src/health";
import { createTestDb } from "../src/testing";

describe("checkDatabase", () => {
  const handlePromise = createTestDb();
  afterAll(async () => (await handlePromise).close());

  it("round-trips a write inside a rolled-back transaction on PGlite", async () => {
    const health = await checkDatabase(await handlePromise);
    expect(health.error).toBeUndefined();
    expect(health.ok).toBe(true);
    expect(health.driver).toBe("pglite");
    expect(health.writeReadRoundTrip).toBe(true);
    expect(health.serverVersion).toMatch(/^PostgreSQL 1[78]/);
  });

  it("leaves no data behind", async () => {
    const { db } = await handlePromise;
    await checkDatabase(await handlePromise);
    const result = await db.execute(
      (await import("drizzle-orm")).sql`select count(*)::int as n from pg_tables where tablename = 'beam_health_probe'`,
    );
    expect((result as unknown as { rows: { n: number }[] }).rows[0]?.n).toBe(0);
  });
});
