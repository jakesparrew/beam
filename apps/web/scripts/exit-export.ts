/**
 * `pnpm exit:export --recipient age1... [--out <dir>] [--skip-dump]` (platform spec PL-92,
 * blueprints 68 and 70, proposal section 10).
 *
 * BEAM's exit copy of its own data, taken from `DATABASE_URL_UNPOOLED` (the direct Neon URL):
 *
 * - `database.dump`: `pg_dump --format=custom --no-owner --no-privileges` of the whole database
 *   (restore with `pg_restore --no-owner -d <url> database.dump`), unless `--skip-dump`;
 * - `tables/<table>.csv`: one CSV with a header row per table of the public schema (every table of
 *   the Drizzle schema index plus any other base table found), in the format of
 *   `COPY ... TO STDOUT WITH CSV HEADER` (PostgreSQL text output, `NULL` as an unquoted empty
 *   field, an empty string as `""`), rows ordered by primary key, read in one repeatable-read
 *   snapshot with `TimeZone = UTC`;
 * - `files/<id>/<name>`: the bytes of every `files` row; in `tables/files.csv` the `bytes` column
 *   holds that archive path instead of the hex dump;
 * - `manifest.json`: tables, columns, row counts, SHA-256 of every entry, the sensitive columns
 *   and the note on their key, and `generatedAt`.
 *
 * Special-category columns (`SENSITIVE_COLUMNS`) and the staff MFA secrets are exported exactly as
 * stored, still AES-256-GCM encrypted: this script never reads `SENSITIVE_DATA_KEY_V<n>` and
 * never calls `readSensitive()` (CONVENTIONS item 10). The keys stay in BEAM's Vercel environment
 * and are handed over separately (`docs/handbook/ownership-and-exit.md`).
 *
 * The entries are packed into one zip with a fixed modification time, so two runs over the same
 * data give the same archive apart from `generatedAt` in the manifest (and the dump, which
 * `pg_dump` stamps itself), and the zip is encrypted with `age -r <recipient>` into
 * `<out>/beam-exit-<Brussels date>.zip.age` (mode 0600). Nothing is written unencrypted. Decrypt
 * with `age -d -i <identity file> beam-exit-....zip.age > beam-exit.zip`.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { is, sql } from "drizzle-orm";
import { zipSync } from "fflate";
import type { Db, DbOrTx } from "@beam/db";
import * as schema from "@beam/db/schema";
import { SENSITIVE_COLUMNS } from "@beam/db/schema";
import { TIME_ZONE } from "@beam/core/i18n";
import { rowsOf } from "@/lib/sensitive";

export const MANIFEST_FORMAT = "beam-exit-export/1";

/** The fixed zip modification time (the zip format cannot store dates before 1980). */
export const ZIP_MTIME = new Date("1980-01-01T00:00:00Z");

/** Secret columns that are encrypted like the special-category columns (PL-5, PL-69). */
export const ENCRYPTED_SECRET_COLUMNS = [
  { table: "users", column: "totp_secret_enc", keyColumn: "secret_key_version" },
  { table: "users", column: "recovery_codes_enc", keyColumn: "secret_key_version" },
] as const;

export const KEY_NOTE =
  "Sensitive columns are exported exactly as stored: AES-256-GCM ciphertext (format byte, 12-byte IV, ciphertext, 16-byte tag; " +
  "activity_events.data holds it base64 in body_enc). The key of version n is the environment variable SENSITIVE_DATA_KEY_V<n> " +
  "(base64, 32 bytes) in BEAM's Vercel project; it is not in this archive and is handed over separately (docs/handbook/ownership-and-exit.md).";

export type ExitEntry = { path: string; bytes: Uint8Array };

export type ExitTable = { name: string; columns: string[]; rows: number; file: string; inSchemaIndex: boolean };

export type ExitManifest = {
  format: typeof MANIFEST_FORMAT;
  generatedAt: string;
  source: { pgDump: boolean; serverVersion: string };
  tables: ExitTable[];
  files: { id: string; path: string; sizeBytes: number; sha256: string }[];
  sensitiveColumns: { table: string; column: string; keyColumn: string }[];
  keyNote: string;
  entries: { path: string; sha256: string; bytes: number }[];
};

export type ExitExport = { entries: ExitEntry[]; manifest: ExitManifest };

const encoder = new TextEncoder();
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** The table names of the Drizzle schema index (`@beam/db/schema`), views excluded, sorted. */
export function schemaTableNames(): string[] {
  const names = new Set<string>();
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) names.add(getTableConfig(value).name);
  }
  return [...names].sort();
}

/** One CSV field as `COPY ... CSV` writes it: `null` unquoted and empty, quotes when needed. */
export function csvField(value: string | null): string {
  if (value === null) return "";
  if (value === "" || /[",\r\n]/.test(value) || value === "\\.") return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function csvLine(values: readonly (string | null)[]): string {
  return `${values.map(csvField).join(",")}\n`;
}

type ColumnRow = { table_name: string; column_name: string; ordinal: number | string };
type KeyRow = { table_name: string; column_name: string; position: number | string };

async function publicTables(tx: DbOrTx): Promise<Map<string, { columns: string[]; key: string[] }>> {
  const columns = rowsOf<ColumnRow>(
    await tx.execute(sql`
      select c.table_name::text as table_name, c.column_name::text as column_name, c.ordinal_position as ordinal
      from information_schema.columns c
      join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
      where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
      order by c.table_name, c.ordinal_position`),
  );
  const keys = rowsOf<KeyRow>(
    await tx.execute(sql`
      select k.table_name::text as table_name, k.column_name::text as column_name, k.ordinal_position as position
      from information_schema.table_constraints tc
      join information_schema.key_column_usage k
        on k.constraint_schema = tc.constraint_schema and k.constraint_name = tc.constraint_name and k.table_name = tc.table_name
      where tc.table_schema = 'public' and tc.constraint_type = 'PRIMARY KEY'
      order by k.table_name, k.ordinal_position`),
  );
  const out = new Map<string, { columns: string[]; key: string[] }>();
  for (const c of columns) {
    const entry = out.get(c.table_name) ?? { columns: [], key: [] };
    entry.columns.push(c.column_name);
    out.set(c.table_name, entry);
  }
  for (const k of keys) out.get(k.table_name)?.key.push(k.column_name);
  return out;
}

/** Every row of one table as text, in a fixed order (primary key, else every column). */
async function tableRows(tx: DbOrTx, table: string, columns: readonly string[], key: readonly string[], replace: Record<string, string> = {}): Promise<(string | null)[][]> {
  const select = columns.map((c, i) => `${replace[c] ?? `${quoteIdent(c)}::text`} as c${i}`).join(", ");
  const order = (key.length ? key : columns).map((c) => (key.length ? quoteIdent(c) : `${quoteIdent(c)}::text`)).join(", ");
  const rows = rowsOf<Record<string, string | null>>(await tx.execute(sql.raw(`select ${select} from ${quoteIdent(table)} order by ${order}`)));
  return rows.map((r) => columns.map((_, i) => r[`c${i}`] ?? null));
}

/** A file name that is safe inside the archive (the `files_name_ck` check already forbids slashes). */
const safeName = (name: string): string => name.replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(0, 200) || "file";

/**
 * Reads every table and file in one read-only, repeatable-read snapshot and returns the archive
 * entries (CSV per table, the files, `database.dump` when given, and `manifest.json` last).
 */
export async function collectExitExport(db: Db, opts: { now: Date; pgDump?: Uint8Array | null }): Promise<ExitExport> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set transaction isolation level repeatable read, read only`);
    await tx.execute(sql`set local time zone 'UTC'`);
    await tx.execute(sql`set local datestyle = 'ISO, YMD'`);
    await tx.execute(sql`set local intervalstyle = 'postgres'`);
    await tx.execute(sql`set local bytea_output = 'hex'`);
    await tx.execute(sql`set local extra_float_digits = 1`);
    const version = rowsOf<{ v: string }>(await tx.execute(sql`select current_setting('server_version') as v`))[0]?.v ?? "";

    const inDb = await publicTables(tx);
    const indexed = new Set(schemaTableNames());
    const names = [...new Set([...indexed].filter((n) => inDb.has(n)).concat([...inDb.keys()]))].sort();
    const missing = [...indexed].filter((n) => !inDb.has(n));
    if (missing.length) throw new Error(`exit-export: tables of the schema index missing in the database: ${missing.join(", ")}`);

    const entries: ExitEntry[] = [];
    const tables: ExitTable[] = [];
    const fileList: ExitManifest["files"] = [];

    for (const name of names) {
      const { columns, key } = inDb.get(name)!;
      const replace: Record<string, string> =
        name === "files" && columns.includes("bytes") && columns.includes("id") && columns.includes("name")
          ? { bytes: `'files/' || "id"::text || '/' || "name"` }
          : {};
      const rows = await tableRows(tx, name, columns, key, replace);
      const csv = csvLine(columns) + rows.map(csvLine).join("");
      const file = `tables/${name}.csv`;
      entries.push({ path: file, bytes: encoder.encode(csv) });
      tables.push({ name, columns, rows: rows.length, file, inSchemaIndex: indexed.has(name) });
    }

    if (inDb.has("files")) {
      const files = rowsOf<{ id: string; name: string; bytes: Uint8Array | string; sha256: string }>(
        await tx.execute(sql`select id::text as id, name, bytes, sha256 from files order by id`),
      );
      for (const f of files) {
        const bytes = toBytes(f.bytes);
        const filePath = `files/${f.id}/${safeName(f.name)}`;
        entries.push({ path: filePath, bytes });
        fileList.push({ id: f.id, path: filePath, sizeBytes: bytes.length, sha256: sha256(bytes) });
      }
    }

    if (opts.pgDump) entries.push({ path: "database.dump", bytes: opts.pgDump });
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    const sensitiveColumns = [...SENSITIVE_COLUMNS, ...ENCRYPTED_SECRET_COLUMNS]
      .map((c) => ({ table: c.table, column: c.column, keyColumn: c.keyColumn }))
      .sort((a, b) => `${a.table}.${a.column}`.localeCompare(`${b.table}.${b.column}`));
    const manifest: ExitManifest = {
      format: MANIFEST_FORMAT,
      generatedAt: opts.now.toISOString(),
      source: { pgDump: Boolean(opts.pgDump), serverVersion: version },
      tables,
      files: fileList,
      sensitiveColumns,
      keyNote: KEY_NOTE,
      entries: entries.map((e) => ({ path: e.path, sha256: sha256(e.bytes), bytes: e.bytes.length })),
    };
    entries.push({ path: "manifest.json", bytes: encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`) });
    return { entries, manifest };
  });
}

/** bytea arrives as a Uint8Array (PGlite, node-postgres) or as `\x...` hex text. */
function toBytes(value: Uint8Array | string): Uint8Array {
  if (typeof value === "string") return new Uint8Array(Buffer.from(value.startsWith("\\x") ? value.slice(2) : value, "hex"));
  return new Uint8Array(value);
}

/** One zip of the entries with a fixed modification time (byte-identical for identical entries). */
export function packArchive(entries: readonly ExitEntry[]): Uint8Array {
  const zippable: Record<string, [Uint8Array, { mtime: Date; level: 6 }]> = {};
  for (const e of entries) zippable[e.path] = [e.bytes, { mtime: ZIP_MTIME, level: 6 }];
  return zipSync(zippable);
}

/** An age X25519 recipient (`age1` + 58 bech32 characters). */
export const AGE_RECIPIENT = /^age1[02-9ac-hj-np-z]{58}$/;

export type Encryptor = (plain: Uint8Array, recipient: string) => Promise<Uint8Array>;
export type DumpRunner = (url: string) => Promise<Uint8Array>;

/** Runs a binary with `input` on stdin and returns its stdout; a non-zero exit throws with stderr. */
export function runBinary(command: string, args: readonly string[], input?: Uint8Array, env?: NodeJS.ProcessEnv): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env: env ?? process.env });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(new Uint8Array(Buffer.concat(out)));
      else reject(new Error(`${command} exited with ${code}: ${Buffer.concat(err).toString("utf8").slice(0, 500)}`));
    });
    child.stdin.end(input ? Buffer.from(input) : undefined);
  });
}

/** `age -r <recipient>`: the archive never touches the disk unencrypted. */
export const ageEncrypt: Encryptor = (plain, recipient) => {
  if (!AGE_RECIPIENT.test(recipient)) return Promise.reject(new Error("exit-export: --recipient must be an age public key (age1...)"));
  return runBinary("age", ["--encrypt", "--recipient", recipient], plain);
};

/** `pg_dump --format=custom` of the whole database (run it from a trusted machine: the URL is an argument). */
export const pgDump: DumpRunner = (url) => runBinary("pg_dump", ["--format=custom", "--no-owner", "--no-privileges", `--dbname=${url}`]);

/** The Brussels calendar day of `now` (`YYYY-MM-DD`), for the file name. */
export function brusselsDay(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export type ExitExportOptions = {
  db: Db;
  recipient: string;
  outDir: string;
  now?: Date;
  /** The direct database URL for `pg_dump`; without it (or with `skipDump`) no dump is included. */
  databaseUrl?: string | null;
  skipDump?: boolean;
  encrypt?: Encryptor;
  dump?: DumpRunner;
};

/** Collects, packs, encrypts and writes the exit archive; returns its path and the manifest. */
export async function runExitExport(opts: ExitExportOptions): Promise<{ file: string; manifest: ExitManifest; bytes: number }> {
  if (!AGE_RECIPIENT.test(opts.recipient)) throw new Error("exit-export: --recipient must be an age public key (age1...)");
  const now = opts.now ?? new Date();
  const dumpBytes = !opts.skipDump && opts.databaseUrl ? await (opts.dump ?? pgDump)(opts.databaseUrl) : null;
  const { entries, manifest } = await collectExitExport(opts.db, { now, pgDump: dumpBytes });
  const encrypted = await (opts.encrypt ?? ageEncrypt)(packArchive(entries), opts.recipient);
  await mkdir(opts.outDir, { recursive: true });
  const file = path.join(opts.outDir, `beam-exit-${brusselsDay(now)}.zip.age`);
  await writeFile(file, encrypted, { mode: 0o600 });
  return { file, manifest, bytes: encrypted.length };
}

export type ExitArgs = { recipient: string; outDir: string; skipDump: boolean };

/** Parses `--recipient`, `--out` and `--skip-dump`; throws with a usage line on bad input. */
export function parseArgs(argv: readonly string[]): ExitArgs {
  const get = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const recipient = get("recipient") ?? "";
  if (!AGE_RECIPIENT.test(recipient)) throw new Error("usage: exit-export.ts --recipient age1... [--out <dir>] [--skip-dump]");
  return { recipient, outDir: get("out") ?? ".", skipDump: argv.includes("--skip-dump") };
}

async function main(argv: string[]): Promise<number> {
  const { config } = await import("dotenv");
  config({ path: ["../../.env.local", "../../.env", ".env.local"], quiet: true });
  let args: ExitArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return 2;
  }
  const url = process.env.DATABASE_URL_UNPOOLED;
  if (!url) {
    console.error("exit-export: DATABASE_URL_UNPOOLED is required (the direct, unpooled database URL)");
    return 2;
  }
  process.env.DATABASE_URL = url;
  const { getDbHandle } = await import("@beam/db");
  const handle = await getDbHandle();
  try {
    const result = await runExitExport({ db: handle.db, recipient: args.recipient, outDir: path.resolve(args.outDir), databaseUrl: url, skipDump: args.skipDump });
    const rows = result.manifest.tables.reduce((n, t) => n + t.rows, 0);
    console.log(`exit-export: ${result.manifest.tables.length} tables, ${rows} rows, ${result.manifest.files.length} files${result.manifest.source.pgDump ? ", pg_dump" : ""}`);
    console.log(`exit-export: wrote ${result.file} (${result.bytes} bytes, age-encrypted)`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return 1;
  } finally {
    await handle.close();
  }
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) {
  void main(process.argv.slice(2)).then((code) => process.exit(code));
}
