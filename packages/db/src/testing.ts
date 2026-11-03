import path from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";
import type { Db, DbHandle } from "./client";
import * as schema from "./schema/index";

export const migrationsFolder = path.join(import.meta.dirname, "../migrations");

/**
 * A fresh, isolated PostgreSQL 18 database in memory (PGlite) with every
 * committed migration applied. Use one per test file:
 *
 *   const { db, close } = await createTestDb();
 *   afterAll(close);
 */
export async function createTestDb(): Promise<DbHandle> {
  const [{ PGlite }, { drizzle }] = await Promise.all([
    import("@electric-sql/pglite"),
    import("drizzle-orm/pglite"),
  ]);
  const client = new PGlite();
  for (const migration of readMigrationFiles({ migrationsFolder })) {
    for (const statement of migration.sql) {
      if (statement.trim()) await client.exec(statement);
    }
  }
  const db = drizzle({ client, schema, casing: "snake_case" }) as unknown as Db;
  return { driver: "pglite", db, close: () => client.close() };
}
