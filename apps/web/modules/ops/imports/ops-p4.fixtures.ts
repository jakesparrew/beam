/**
 * Test helpers of the import suites (ops-P4): CSV parts as `files` rows, an `imports` row with a
 * mapping, rows for appliers, and a driver that runs the real job chain (parse, chunks,
 * finalise) through the job runner on the test database.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Db } from "@beam/db";
import { files, importRows, imports, jobs } from "@beam/db/schema";
import { makeUser } from "@beam/db/testing";
import type { ImportKind, ImportMapping, ImportSource } from "@beam/core/ops";
import { and, enqueueJob, eq, inArray, sql } from "@/lib/ctx";
import { runJobs } from "@/lib/job-runner";
import { createFakeIntegrations, makeJobCtx } from "@/lib/testing";
import type { ImportRow, RowData } from "./apply";

export const baseOptions = (over: Partial<ImportMapping["options"]> = {}): ImportMapping["options"] => ({
  delimiter: ",",
  dateFormat: "iso",
  defaultLocale: "nl-BE",
  overwrite: false,
  ...over,
});

/** A mapping that maps every listed column to the target of the same name. */
export function identityMapping(columns: string[], options: Partial<ImportMapping["options"]> = {}): ImportMapping {
  return { columns: Object.fromEntries(columns.map((c) => [c, c])), options: baseOptions(options) };
}

/** Stores CSV text as `files` parts of at most `partBytes` bytes (kind `import`). */
export async function storeCsv(db: Db, csv: string | Uint8Array, opts: { partBytes?: number; userId?: string } = {}): Promise<string[]> {
  const bytes = typeof csv === "string" ? new TextEncoder().encode(csv) : csv;
  const size = opts.partBytes ?? bytes.length;
  const ids: string[] = [];
  for (let at = 0; at < Math.max(1, bytes.length); at += size) {
    const part = bytes.subarray(at, at + size);
    const [row] = await db
      .insert(files)
      .values({ kind: "import", name: `part-${ids.length + 1}.csv`, mime: "text/csv", sizeBytes: part.byteLength, bytes: part, sha256: createHash("sha256").update(part).digest("hex") })
      .returning({ id: files.id });
    ids.push(row!.id);
  }
  return ids;
}

export async function staffUser(db: Db): Promise<string> {
  return (await makeUser(db, { roleKey: "technical_admin" })).id;
}

/** An `imports` row with its parts and mapping, status `uploaded`. */
export async function seedImport(
  db: Db,
  input: { kind: ImportKind; source?: ImportSource; name?: string; csv: string; mapping: ImportMapping; userId?: string; partBytes?: number },
): Promise<string> {
  const fileIds = await storeCsv(db, input.csv, { partBytes: input.partBytes });
  const header = (input.csv.split(/\r?\n/)[0] ?? "").split(input.mapping.options.delimiter).map((h) => h.trim());
  const [row] = await db
    .insert(imports)
    .values({
      kind: input.kind,
      source: input.source ?? "spreadsheet",
      name: input.name ?? "Test import",
      fileId: fileIds[0]!,
      partFileIds: fileIds.slice(1),
      header,
      mapping: input.mapping,
      createdByUserId: input.userId ?? (await staffUser(db)),
    })
    .returning({ id: imports.id });
  return row!.id;
}

/** Runs pending import jobs (and anything they enqueue in the bulk lane) until none is left. */
export async function drain(db: Db, opts: { now?: () => Date } = {}): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const summary = await runJobs({ db, budgetMs: 60_000, lanes: ["bulk"], integrations: createFakeIntegrations(), ...(opts.now ? { now: opts.now } : {}) });
    const pending = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.status, "pending"), inArray(jobs.kind, ["import.parse", "import.process_chunk", "import.finalise"]), sql`${jobs.runAt} <= now()`))
      .limit(1);
    if (!pending.length && summary.ran.bulk === 0) return;
    if (!pending.length) return;
  }
}

/** Starts a dry run directly (what `startDryRun` does) and drains the chain. */
export async function dryRun(db: Db, importId: string): Promise<void> {
  const [imp] = await db
    .update(imports)
    .set({ status: "dry_run", isDryRun: true, runSeq: sql`${imports.runSeq} + 1`, finishedAt: null })
    .where(eq(imports.id, importId))
    .returning({ runSeq: imports.runSeq });
  await enqueueJob(db, { kind: "import.parse", payload: { importId, runSeq: imp!.runSeq }, key: `import:${importId}:${imp!.runSeq}:parse` });
  await drain(db);
}

/** Starts the real run directly (what `startImport` does after its checks) and drains the chain. */
export async function realRun(db: Db, importId: string): Promise<void> {
  const [imp] = await db
    .update(imports)
    .set({ status: "running", isDryRun: false, runSeq: sql`${imports.runSeq} + 1`, finishedAt: null })
    .where(eq(imports.id, importId))
    .returning({ runSeq: imports.runSeq });
  await enqueueJob(db, { kind: "import.process_chunk", payload: { importId, runSeq: imp!.runSeq, mode: "run", offset: 0 }, key: `import:${importId}:${imp!.runSeq}:run:chunk:0` });
  await drain(db);
}

export async function importOf(db: Db, importId: string) {
  const [row] = await db.select().from(imports).where(eq(imports.id, importId));
  return row!;
}

export async function rowsOf(db: Db, importId: string) {
  return db.select().from(importRows).where(eq(importRows.importId, importId)).orderBy(importRows.rowNumber);
}

/** An applier input row (no database row needed for direct applier calls). */
export function row(data: RowData, over: Partial<ImportRow> = {}): ImportRow {
  return { id: randomUUID(), importId: over.importId ?? randomUUID(), importName: "Test import", rowNumber: 1, source: "spreadsheet", kind: "persons", ...over, data };
}

/** A job context on the test database for direct applier calls. */
export const jobCtx = (db: Db, now?: Date) => makeJobCtx(db, "import.process_chunk", now ? { now } : {});

/** Rows of a table, for "nothing else changed" assertions. */
export async function tableCounts(db: Db, tables: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of tables) {
    const res = (await db.execute(sql.raw(`select count(*)::int as n from ${t}`))) as unknown as { rows: { n: number }[] };
    out[t] = Number(res.rows[0]!.n);
  }
  return out;
}

/**
 * Signs a staff user of `roleKey` in through the mocked cookie jar after giving that role
 * exactly `permissions` (the test files mock `next/headers` with `headersMock(jar)`).
 */
export async function signInStaff(
  db: Db,
  jar: Map<string, string>,
  permissions: string[],
  roleKey: "management" | "reception" | "technical_admin" | "sales" | "external_partner" = "management",
) {
  const { createAuthSession, SESSION_COOKIE } = await import("@/lib/auth");
  const { roles } = await import("@beam/db/schema");
  const user = await makeUser(db, { roleKey });
  await db.update(roles).set({ permissions }).where(eq(roles.key, roleKey));
  const { token } = await createAuthSession(db, { userId: user.id, audience: "staff", roleKey, now: new Date(), mfaAt: new Date() });
  jar.set(SESSION_COOKIE, token);
  return user;
}

/** The `next/headers` mock every action suite installs with its own jar. */
export function headersMock(jar: Map<string, string>) {
  return {
    cookies: () =>
      Promise.resolve({
        get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
        set: (name: string, value: string) => void jar.set(name, value),
        delete: (name: string) => void jar.delete(name),
      }),
    headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.10" })),
  };
}
