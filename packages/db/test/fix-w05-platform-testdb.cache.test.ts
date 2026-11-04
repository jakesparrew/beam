import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../src/client";
import { createTestDb, testDbCacheDir, testDbCacheEnabled, testDbCacheKey } from "../src/testing";

const PACKAGE_DIR = path.resolve(import.meta.dirname, "..");
const SLOW = 180_000;

const saved = {
  dir: process.env.BEAM_TESTDB_CACHE_DIR,
  enabled: process.env.BEAM_TESTDB_CACHE,
};
const temps: string[] = [];
const handles: DbHandle[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `fix-w05-platform-testdb-${prefix}-`));
  temps.push(dir);
  return dir;
}

/** Points the cache at a new, empty folder for one test. */
function freshCache(): string {
  const dir = tempDir("cache");
  process.env.BEAM_TESTDB_CACHE_DIR = dir;
  delete process.env.BEAM_TESTDB_CACHE;
  return dir;
}

async function open(options?: { from?: "schema" | "migrations" }): Promise<DbHandle> {
  const h = await createTestDb(options);
  handles.push(h);
  return h;
}

async function rows(h: DbHandle, query: string): Promise<unknown[]> {
  const result: unknown = await h.db.execute(sql.raw(query));
  return (result as { rows: unknown[] }).rows;
}

/** Everything the snapshot must reproduce: tables, columns, views, triggers, enums, sequences, functions, settings. */
async function catalogue(h: DbHandle) {
  return {
    tables: await rows(
      h,
      `select table_schema, table_name, table_type from information_schema.tables
        where table_schema not in ('pg_catalog', 'information_schema') order by 1, 2`,
    ),
    columns: await rows(
      h,
      `select table_schema, table_name, column_name, data_type, is_nullable, column_default
         from information_schema.columns
        where table_schema not in ('pg_catalog', 'information_schema') order by 1, 2, 3`,
    ),
    views: await rows(
      h,
      `select schemaname, viewname, definition from pg_views
        where schemaname not in ('pg_catalog', 'information_schema') order by 1, 2`,
    ),
    triggers: await rows(
      h,
      `select c.relname, t.tgname, t.tgenabled, p.proname
         from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_proc p on p.oid = t.tgfoid
        where not t.tgisinternal order by 1, 2`,
    ),
    enums: await rows(
      h,
      `select t.typname, e.enumlabel, e.enumsortorder
         from pg_enum e join pg_type t on t.oid = e.enumtypid order by 1, 3`,
    ),
    sequences: await rows(
      h,
      `select schemaname, sequencename, start_value, increment_by, last_value
         from pg_sequences order by 1, 2`,
    ),
    constraints: await rows(
      h,
      `select conrelid::regclass::text as rel, conname, contype, pg_get_constraintdef(oid) as def
         from pg_constraint where connamespace not in ('pg_catalog'::regnamespace) order by 1, 2`,
    ),
    indexes: await rows(
      h,
      `select schemaname, tablename, indexname, indexdef from pg_indexes
        where schemaname not in ('pg_catalog', 'information_schema') order by 1, 2, 3`,
    ),
    functions: await rows(
      h,
      `select n.nspname, p.proname, md5(p.prosrc) as src from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname not in ('pg_catalog', 'information_schema') order by 1, 2, 3`,
    ),
    settings: await rows(h, `select name, setting from pg_settings order by name`),
  };
}

function snapshotFiles(dir: string, suffix = ".tar"): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(suffix)).sort() : [];
}

beforeEach(() => {
  freshCache();
});

afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => h.close()));
});

afterAll(() => {
  if (saved.dir === undefined) delete process.env.BEAM_TESTDB_CACHE_DIR;
  else process.env.BEAM_TESTDB_CACHE_DIR = saved.dir;
  if (saved.enabled === undefined) delete process.env.BEAM_TESTDB_CACHE;
  else process.env.BEAM_TESTDB_CACHE = saved.enabled;
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

describe("createTestDb snapshot cache", () => {
  it("is on by default, off with BEAM_TESTDB_CACHE=0, and uses the folder override", () => {
    expect(testDbCacheEnabled()).toBe(true);
    process.env.BEAM_TESTDB_CACHE = "0";
    expect(testDbCacheEnabled()).toBe(false);
    delete process.env.BEAM_TESTDB_CACHE;
    expect(testDbCacheDir()).toBe(process.env.BEAM_TESTDB_CACHE_DIR);
    delete process.env.BEAM_TESTDB_CACHE_DIR;
    expect(testDbCacheDir()).toBe(
      path.resolve(PACKAGE_DIR, "../../node_modules/.cache/beam-testdb"),
    );
  });

  it(
    "a cache hit has the same tables, views, triggers, enums and sequences as a fresh build",
    async () => {
      const dir = testDbCacheDir();
      const key = testDbCacheKey("schema");
      const miss = await open();
      expect(snapshotFiles(dir)).toEqual([`${key}.tar`]);
      expect(snapshotFiles(dir, ".tmp")).toEqual([]);
      const written = statSync(path.join(dir, `${key}.tar`)).ino;

      const hit = await open();
      // A hit loads the file in place; it is not rebuilt or rewritten.
      expect(statSync(path.join(dir, `${key}.tar`)).ino).toBe(written);

      process.env.BEAM_TESTDB_CACHE = "0";
      const fresh = await open();
      delete process.env.BEAM_TESTDB_CACHE;
      expect(snapshotFiles(dir)).toEqual([`${key}.tar`]);

      const expected = await catalogue(fresh);
      expect(expected.tables.length).toBeGreaterThan(50);
      expect(expected.views.length).toBeGreaterThan(0);
      expect(expected.triggers.length).toBeGreaterThan(0);
      expect(expected.enums.length).toBeGreaterThan(0);
      expect(await catalogue(hit)).toEqual(expected);
      expect(await catalogue(miss)).toEqual(expected);

      // The loaded copy is a working, writable database with the append-only triggers active.
      await hit.db.execute(sql.raw("create table fix_w05_probe (id serial primary key, v text)"));
      await hit.db.execute(sql.raw("insert into fix_w05_probe (v) values ('a'), ('b')"));
      expect(await rows(hit, "select id, v from fix_w05_probe order by id")).toEqual([
        { id: 1, v: "a" },
        { id: 2, v: "b" },
      ]);
      await expect(hit.db.execute(sql.raw("truncate audit_log"))).rejects.toThrow();
      // Each handle is its own database: the probe table exists only in the one that made it.
      expect(await rows(miss, "select to_regclass('fix_w05_probe') as t")).toEqual([{ t: null }]);
    },
    SLOW,
  );

  it(
    "caches from: 'migrations' under its own key with the same result as a fresh build",
    async () => {
      const dir = testDbCacheDir();
      const key = testDbCacheKey("migrations");
      expect(key).not.toBe(testDbCacheKey("schema"));
      await open({ from: "migrations" });
      expect(snapshotFiles(dir)).toEqual([`${key}.tar`]);
      const hit = await open({ from: "migrations" });
      process.env.BEAM_TESTDB_CACHE = "0";
      const fresh = await open({ from: "migrations" });
      delete process.env.BEAM_TESTDB_CACHE;
      expect(await catalogue(hit)).toEqual(await catalogue(fresh));
    },
    SLOW,
  );

  it("changes the key when schema content changes, and only then", () => {
    const copy = tempDir("pkg");
    for (const rel of ["src/schema", "src/sql", "src/testing.ts", "scripts", "migrations"]) {
      cpSync(path.join(PACKAGE_DIR, rel), path.join(copy, rel), { recursive: true });
    }
    const schemaKey = testDbCacheKey("schema");
    const migrationsKey = testDbCacheKey("migrations");
    // Paths are hashed relative to the package, so an identical copy has identical keys.
    expect(testDbCacheKey("schema", { packageDir: copy })).toBe(schemaKey);
    expect(testDbCacheKey("migrations", { packageDir: copy })).toBe(migrationsKey);

    const crm = path.join(copy, "src/schema/crm.ts");
    writeFileSync(crm, `${readFileSync(crm, "utf8")}\n// changed\n`);
    const changedSchemaKey = testDbCacheKey("schema", { packageDir: copy });
    expect(changedSchemaKey).not.toBe(schemaKey);
    expect(testDbCacheKey("migrations", { packageDir: copy })).not.toBe(migrationsKey);

    // A new migration changes only the migrations key.
    writeFileSync(path.join(copy, "migrations/9999_extra.sql"), "select 1;");
    expect(testDbCacheKey("schema", { packageDir: copy })).toBe(changedSchemaKey);

    // A new custom SQL file and a new schema file change the key too.
    writeFileSync(path.join(copy, "src/sql/9999_extra.sql"), "select 1;");
    const withSql = testDbCacheKey("schema", { packageDir: copy });
    expect(withSql).not.toBe(changedSchemaKey);
    mkdirSync(path.join(copy, "src/schema/extra"), { recursive: true });
    writeFileSync(path.join(copy, "src/schema/extra/x.ts"), "export {};");
    expect(testDbCacheKey("schema", { packageDir: copy })).not.toBe(withSql);
  });

  it(
    "rebuilds and rewrites a corrupt snapshot, and prunes all but the newest five",
    async () => {
      const dir = testDbCacheDir();
      const key = testDbCacheKey("schema");
      const target = path.join(dir, `${key}.tar`);
      const old = new Date(Date.now() - 3_600_000);
      for (let i = 0; i < 6; i++) {
        const f = path.join(dir, `old${i}.tar`);
        writeFileSync(f, "stale");
        utimesSync(f, new Date(old.getTime() + i * 1000), new Date(old.getTime() + i * 1000));
      }
      writeFileSync(path.join(dir, "leftover.tar.1-1.tmp"), "half");
      utimesSync(path.join(dir, "leftover.tar.1-1.tmp"), old, old);

      for (const corrupt of [
        Buffer.from("this is not a tar archive"),
        Buffer.alloc(0),
        Buffer.alloc(8192),
        null, // truncated copy of a valid snapshot, filled in below
      ]) {
        const bytes = corrupt ?? readFileSync(target).subarray(0, 1_048_576 + 512);
        writeFileSync(target, bytes);
        const h = await open();
        const [count] = (await rows(
          h,
          "select count(*)::int as n from pg_tables where schemaname = 'public'",
        )) as { n: number }[];
        expect(count?.n).toBeGreaterThan(50);
        expect(await rows(h, "select to_regclass('audit_log') is not null as ok")).toEqual([
          { ok: true },
        ]);
        const rewritten = readFileSync(target);
        expect(rewritten.length).toBeGreaterThan(1_048_576);
        expect(rewritten.subarray(257, 262).toString("latin1")).toBe("ustar");
      }
      const left = snapshotFiles(dir);
      expect(left).toHaveLength(5);
      expect(left).toContain(`${key}.tar`);
      expect(left).not.toContain("old0.tar");
      expect(left).not.toContain("old1.tar");
      expect(snapshotFiles(dir, ".tmp")).toEqual([]);
    },
    SLOW,
  );

  it(
    "two concurrent first calls both succeed and leave one complete snapshot",
    async () => {
      const dir = testDbCacheDir();
      const [a, b] = await Promise.all([open(), open()]);
      for (const h of [a, b]) {
        expect(await rows(h, "select to_regclass('audit_log') is not null as ok")).toEqual([
          { ok: true },
        ]);
      }
      expect(snapshotFiles(dir)).toEqual([`${testDbCacheKey("schema")}.tar`]);
      expect(snapshotFiles(dir, ".tmp")).toEqual([]);
      const c = await open();
      expect(await catalogue(c)).toEqual(await catalogue(a));
    },
    SLOW,
  );

  it(
    "writes nothing when BEAM_TESTDB_CACHE=0",
    async () => {
      const dir = testDbCacheDir();
      process.env.BEAM_TESTDB_CACHE = "0";
      await open();
      expect(readdirSync(dir)).toEqual([]);
    },
    SLOW,
  );
});
