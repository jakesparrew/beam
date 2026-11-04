import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { sql } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import type { PGlite } from "@electric-sql/pglite";
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
  const from = options.from === "migrations" ? "migrations" : "schema";
  const [{ PGlite }, { drizzle }] = await Promise.all([
    import("@electric-sql/pglite"),
    import("drizzle-orm/pglite"),
  ]);
  const build = async (): Promise<PGliteClient> => {
    const fresh = new PGlite();
    const statements =
      from === "migrations"
        ? committedMigrationSql()
        : [...(await schemaToSql()), ...postSchemaSql()];
    for (const statement of statements) await fresh.exec(statement);
    return fresh;
  };
  const client = testDbCacheEnabled()
    ? await cachedClient(from, build, (blob) => new PGlite({ loadDataDir: blob }))
    : await build();
  const db = drizzle({ client, schema, casing: "snake_case" }) as unknown as Db;
  rawExec.set(db, (text) => client.exec(text));
  return { driver: "pglite", db, close: () => client.close() };
}

// ---------------------------------------------------------------------------
// Snapshot cache (fix-w05-platform-testdb). Building the merged schema takes several
// seconds per test file; a data-directory snapshot of the built database loads in one
// or two. Snapshots live in <repo>/node_modules/.cache/beam-testdb/<key>.tar.
// ---------------------------------------------------------------------------

type PGliteClient = PGlite;

const PACKAGE_DIR = path.resolve(import.meta.dirname, "..");
const KEEP_SNAPSHOTS = 5;
const STALE_TMP_MS = 30 * 60 * 1000;

/** `BEAM_TESTDB_CACHE=0` (or `false`/`off`) turns the snapshot cache off. */
export function testDbCacheEnabled(): boolean {
  const v = process.env.BEAM_TESTDB_CACHE?.trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off");
}

/**
 * The snapshot folder: `<repo root>/node_modules/.cache/beam-testdb` (git-ignored, one per
 * worktree), or `BEAM_TESTDB_CACHE_DIR` when set (the cache tests use a temporary folder).
 */
export function testDbCacheDir(): string {
  return (
    process.env.BEAM_TESTDB_CACHE_DIR ||
    path.join(PACKAGE_DIR, "../..", "node_modules/.cache/beam-testdb")
  );
}

function listFiles(dir: string, accept: (name: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && accept(e.name))
    .map((e) => path.join(e.parentPath, e.name));
}

function pgliteVersion(): string {
  const entry = createRequire(import.meta.url).resolve("@electric-sql/pglite");
  let dir = path.dirname(entry);
  while (dir !== path.dirname(dir)) {
    const pkg = path.join(dir, "package.json");
    if (existsSync(pkg)) {
      const json = JSON.parse(readFileSync(pkg, "utf8")) as { name?: string; version?: string };
      if (json.name === "@electric-sql/pglite") return json.version ?? "unknown";
    }
    dir = path.dirname(dir);
  }
  return "unknown";
}

/**
 * The cache key of the database `createTestDb({ from })` builds: sha256 over the sorted
 * relative paths and contents of `src/schema/**\/*.ts`, `src/sql/**`, `src/testing.ts`, the
 * view and append-only generators in `scripts/`, the PGlite version, `from` and, for
 * `from: "migrations"`, the migrations folder (journal and `.sql` files). `packageDir`
 * defaults to this package; tests point it at a copy.
 */
export function testDbCacheKey(
  from: "schema" | "migrations",
  options: { packageDir?: string } = {},
): string {
  const dir = options.packageDir ?? PACKAGE_DIR;
  const files = [
    ...listFiles(path.join(dir, "src/schema"), (n) => n.endsWith(".ts")),
    ...listFiles(path.join(dir, "src/sql"), () => true),
    path.join(dir, "src/testing.ts"),
    path.join(dir, "scripts/views-sql.ts"),
    path.join(dir, "scripts/append-only-sql.ts"),
    ...(from === "migrations"
      ? listFiles(path.join(dir, "migrations"), (n) => n.endsWith(".sql")).concat(
          path.join(dir, "migrations/meta/_journal.json"),
        )
      : []),
  ]
    .map((f) => ({ rel: path.relative(dir, f).split(path.sep).join("/"), abs: f }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const hash = createHash("sha256");
  hash.update(`beam-testdb/1\0from=${from}\0pglite=${pgliteVersion()}\0`);
  for (const { rel, abs } of files) {
    hash.update(`${rel}\0`);
    hash.update(existsSync(abs) ? readFileSync(abs) : "<missing>");
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 32);
}

/** A plausible uncompressed tar: whole 512-byte blocks, `ustar` header, end-of-archive blocks. */
function looksLikeTar(buf: Uint8Array): boolean {
  if (buf.length < 2048 || buf.length % 512 !== 0) return false;
  if (Buffer.from(buf.subarray(257, 262)).toString("latin1") !== "ustar") return false;
  return buf.subarray(buf.length - 1024).every((b) => b === 0);
}

async function readSnapshot(
  file: string,
  load: (blob: Blob) => PGliteClient,
): Promise<PGliteClient | undefined> {
  let buf: Buffer;
  try {
    buf = await readFile(file);
  } catch {
    return undefined;
  }
  if (!looksLikeTar(buf)) return undefined;
  let client: PGliteClient | undefined;
  try {
    client = load(new Blob([new Uint8Array(buf)]));
    await client.waitReady;
    const { rows } = await client.query<{ n: number }>(
      "select count(*)::int as n from pg_tables where schemaname = 'public'",
    );
    if (!rows[0] || rows[0].n < 1) throw new Error("empty snapshot");
    // A fresh build has run plpgsql (functions, triggers), which registers the `plpgsql.*`
    // settings in the session; load it so the copy's session settings are the same.
    await client.exec("load 'plpgsql'");
    const now = new Date();
    await utimes(file, now, now).catch(() => undefined);
    return client;
  } catch {
    await client?.close().catch(() => undefined);
    return undefined;
  }
}

let tmpCounter = 0;

async function writeSnapshot(dir: string, key: string, client: PGliteClient): Promise<void> {
  // A checkpoint first, so the snapshot needs no WAL replay: without it, sequences that were
  // advanced during the build jump ahead by their pre-logged values when the copy is loaded.
  await client.exec("checkpoint");
  const blob = await client.dumpDataDir("none");
  const buf = new Uint8Array(await blob.arrayBuffer());
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, `${key}.tar`);
  const tmp = `${target}.${process.pid}-${++tmpCounter}.tmp`;
  try {
    await writeFile(tmp, buf);
    await rename(tmp, target);
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
  await pruneSnapshots(dir);
}

async function pruneSnapshots(dir: string): Promise<void> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  const stats = await Promise.all(
    entries.map(async (name) => {
      const s = await stat(path.join(dir, name)).catch(() => undefined);
      return s ? { name, mtime: s.mtimeMs } : undefined;
    }),
  );
  const present = stats.filter((s): s is { name: string; mtime: number } => !!s);
  const snapshots = present
    .filter((s) => s.name.endsWith(".tar"))
    .sort((a, b) => b.mtime - a.mtime);
  const stale = [
    ...snapshots.slice(KEEP_SNAPSHOTS),
    ...present.filter((s) => s.name.endsWith(".tmp") && Date.now() - s.mtime > STALE_TMP_MS),
  ];
  await Promise.all(stale.map((s) => rm(path.join(dir, s.name), { force: true })));
}

/**
 * Loads the snapshot of `from` when one exists and is readable; otherwise builds the
 * database, writes the snapshot (atomically: a temporary file renamed into place) and
 * returns the freshly built client. A failure to write never fails the test.
 */
async function cachedClient(
  from: "schema" | "migrations",
  build: () => Promise<PGliteClient>,
  load: (blob: Blob) => PGliteClient,
): Promise<PGliteClient> {
  const dir = testDbCacheDir();
  const key = testDbCacheKey(from);
  const hit = await readSnapshot(path.join(dir, `${key}.tar`), load);
  if (hit) return hit;
  const client = await build();
  try {
    await writeSnapshot(dir, key, client);
  } catch {
    // An unwritable cache only costs speed.
  }
  return client;
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
