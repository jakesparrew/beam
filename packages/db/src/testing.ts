import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";
import type { Db, DbHandle } from "./client";
import * as schema from "./schema/index";

export const migrationsFolder = path.join(import.meta.dirname, "../migrations");

let schemaStatements: Promise<string[]> | undefined;

/** SQL that creates the current TypeScript schema from an empty database. */
export function schemaToSql(): Promise<string[]> {
  schemaStatements ??= (async () => {
    const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
    const empty = generateDrizzleJson({}, undefined, undefined, "snake_case");
    const current = generateDrizzleJson(schema as Record<string, unknown>, empty.id, undefined, "snake_case");
    return generateMigration(empty, current);
  })();
  return schemaStatements;
}

/** SQL statements of every committed migration, in order. */
export function committedMigrationSql(): string[] {
  return readMigrationFiles({ migrationsFolder }).flatMap((m) => m.sql).filter((s) => s.trim());
}

/**
 * A fresh, isolated PostgreSQL 18 database in memory (PGlite). Use one per
 * test file:
 *
 *   const handle = await createTestDb();
 *   afterAll(() => handle.close());
 *
 * `from: "schema"` (default) builds the database straight from the TypeScript
 * schema, so new tables are testable before their migration is generated.
 * `from: "migrations"` applies the committed migrations instead (used to prove
 * the migrations produce the schema).
 */
export async function createTestDb(options: { from?: "schema" | "migrations" } = {}): Promise<DbHandle> {
  const [{ PGlite }, { drizzle }] = await Promise.all([
    import("@electric-sql/pglite"),
    import("drizzle-orm/pglite"),
  ]);
  const client = new PGlite();
  const statements = options.from === "migrations" ? committedMigrationSql() : await schemaToSql();
  for (const statement of statements) await client.exec(statement);
  const db = drizzle({ client, schema, casing: "snake_case" }) as unknown as Db;
  return { driver: "pglite", db, close: () => client.close() };
}

/** The latest drizzle-kit snapshot committed in migrations/meta, if any. */
export function latestSnapshot(): Record<string, unknown> | undefined {
  const metaDir = path.join(migrationsFolder, "meta");
  const snapshots = readdirSync(metaDir).filter((f) => f.endsWith("_snapshot.json")).sort();
  const last = snapshots.at(-1);
  return last ? JSON.parse(readFileSync(path.join(metaDir, last), "utf8")) : undefined;
}
