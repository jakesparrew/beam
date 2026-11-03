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
});
