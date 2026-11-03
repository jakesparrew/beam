import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { appendOnlySql } from "../scripts/append-only-sql";
import { viewStatements } from "../scripts/views-sql";
import type { Db, DbHandle } from "./client";
import * as schema from "./schema/index";

export * from "./testing/factories";

export const migrationsFolder = path.join(import.meta.dirname, "../migrations");

/** Custom SQL files (PL-23b), applied in file-name order by `applyCustomSql`. */
export const customSqlFolder = path.join(import.meta.dirname, "sql");

/** Raw multi-statement execution for the PGlite handles this file created. */
const rawExec = new WeakMap<Db, (text: string) => Promise<unknown>>();

let schemaStatements: Promise<string[]> | undefined;

/** SQL that creates the current TypeScript schema from an empty database. */
export function schemaToSql(): Promise<string[]> {
  schemaStatements ??= (async () => {
    const { generateDrizzleJson, generateMigration } =
      await import("drizzle-kit/api");
    const empty = generateDrizzleJson({}, undefined, undefined, "snake_case");
    const current = generateDrizzleJson(
      schema,
      empty.id,
      undefined,
      "snake_case",
    );
    return generateMigration(empty, current);
  })();
  return schemaStatements;
}

/** SQL statements of every committed migration, in order. */
export function committedMigrationSql(): string[] {
  return readMigrationFiles({ migrationsFolder })
    .flatMap((m) => m.sql)
    .filter((s) => s.trim());
}

/**
 * The statements `from: "schema"` runs after the schema: every view in dependency order
 * (`pnpm db:views`), then the append-only functions and triggers (`0002_append_only.sql`).
 */
export function postSchemaSql(): string[] {
  return [...viewStatements(), appendOnlySql()];
}

/**
 * A fresh, isolated PostgreSQL 18 database in memory (PGlite). Use one per
 * test file:
 *
 *   const handle = await createTestDb();
 *   afterAll(() => handle.close());
 *
 * `from: "schema"` (default) builds the database straight from the TypeScript
 * schema, then creates the views and the append-only triggers, so new tables are
 * testable before their migration is generated.
 * `from: "migrations"` applies the committed migrations instead (used to prove
 * the migrations produce the schema); they already contain views and triggers.
 */
export async function createTestDb(
  options: { from?: "schema" | "migrations" } = {},
): Promise<DbHandle> {
  const [{ PGlite }, { drizzle }] = await Promise.all([
    import("@electric-sql/pglite"),
    import("drizzle-orm/pglite"),
  ]);
  const client = new PGlite();
  const statements =
    options.from === "migrations"
      ? committedMigrationSql()
      : [...(await schemaToSql()), ...postSchemaSql()];
  for (const statement of statements) await client.exec(statement);
  const db = drizzle({ client, schema, casing: "snake_case" }) as unknown as Db;
  rawExec.set(db, (text) => client.exec(text));
  return { driver: "pglite", db, close: () => client.close() };
}

/**
 * Applies the custom SQL files of `src/sql/` in file-name order, or only the listed file
 * names (PL-23b), so each owner can test its SQL on PGlite. The files are idempotent.
 */
export async function applyCustomSql(
  handle: DbHandle,
  options: { files?: string[] } = {},
): Promise<string[]> {
  const available = readdirSync(customSqlFolder)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const files = options.files ? [...options.files].sort() : available;
  for (const f of files) {
    if (!available.includes(f))
      throw new Error(`applyCustomSql: no file ${f} in ${customSqlFolder}`);
    const text = readFileSync(path.join(customSqlFolder, f), "utf8");
    const exec =
      rawExec.get(handle.db) ?? ((t: string) => handle.db.execute(sql.raw(t)));
    await exec(text);
  }
  return files;
}

/** The latest drizzle-kit snapshot committed in migrations/meta, if any. */
export function latestSnapshot(): Record<string, unknown> | undefined {
  const metaDir = path.join(migrationsFolder, "meta");
  const snapshots = readdirSync(metaDir)
    .filter((f) => f.endsWith("_snapshot.json"))
    .sort();
  const last = snapshots.at(-1);
  return last
    ? JSON.parse(readFileSync(path.join(metaDir, last), "utf8"))
    : undefined;
}
