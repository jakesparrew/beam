import { describe, expect, it } from "vitest";
import { committedMigrationSql, createTestDb, schemaToSql } from "../src/testing";

describe("createTestDb", () => {
  it("builds a database from the TypeScript schema", async () => {
    const handle = await createTestDb();
    expect(handle.driver).toBe("pglite");
    await handle.close();
    expect(Array.isArray(await schemaToSql())).toBe(true);
  });

  it("can build a database from the committed migrations", async () => {
    const handle = await createTestDb({ from: "migrations" });
    await handle.close();
    expect(Array.isArray(committedMigrationSql())).toBe(true);
  });

  it("the committed migrations create the R4 role beam_ai_ro and ops' ai views (0100, 0101)", async () => {
    const handle = await createTestDb({ from: "migrations" });
    try {
      const rows = async (q: string) => {
        const r: unknown = await handle.db.execute(q);
        return ((r as { rows?: unknown[] }).rows ?? r) as Record<string, unknown>[];
      };
      expect(await rows("select rolname from pg_roles where rolname = 'beam_ai_ro'")).toHaveLength(1);
      const views = (await rows("select table_name from information_schema.views where table_schema = 'ai'")).map((r) => r.table_name);
      expect(views).toEqual(expect.arrayContaining(["customers", "orders", "revenue", "form_funnel_daily"]));
      const [grant] = await rows("select has_table_privilege('beam_ai_ro', 'ai.orders', 'select') as ok");
      expect(grant?.ok).toBe(true);
    } finally {
      await handle.close();
    }
  });
});
