/**
 * ops jobs, area `imports` (ops spec 4.4, rules 42-53, ops-P4): `import.parse`,
 * `import.process_chunk`, `import.finalise`. Registered in `../jobs.ts` by ops-P1 (names, inputs
 * and signatures kept). Every key carries the import's `run_seq`, so a second dry run or a resume
 * never collides with an earlier run's keys; every handler exits when `imports.run_seq` moved on
 * or the import was cancelled, so each is safe to run twice.
 *
 * A job runs in one transaction: a failure that must stay visible (parse error, the last failed
 * chunk attempt) is written through `writeDurably`, which survives the rollback.
 */
import { z } from "zod";
import type { Tx } from "@beam/db";
import { cutoverChecklistItems, files, importRows, imports } from "@beam/db/schema";
import { normaliseEmail } from "@beam/core/crm";
import { CsvParseError, CUTOVER_RULES, CUTOVER_STEPS, IMPORT_CHUNK_ROWS, IMPORT_TARGETS, parseCsvStream, type ImportKind, type ImportMapping, type ImportSource } from "@beam/core/ops";
import { PermanentError } from "@beam/core/errors";
import { and, asc, eq, gt, inArray, isNotNull, lte, sql, writeDurably, type DbOrTx } from "@/lib/ctx";
import type { JobCtx } from "@/lib/job-runner";
import { readFile } from "@/modules/platform/api";
import { applyRow, DUP_MARKER, presetOf, type ImportRow, type RowApplier, type RowData } from "./apply";
import { applyBookingRow } from "./appliers/bookings";
import { applyCompanyRow } from "./appliers/companies";
import { applyConsentRow } from "./appliers/consents";
import { applyHistoryRow, WEBINAR_EXTRA_TARGETS } from "./appliers/history";
import { applyMembershipRow } from "./appliers/memberships";
import { applyPackageRow } from "./appliers/packages";
import { applyPersonRow } from "./appliers/persons";
import { applySuppressionRow } from "./appliers/suppressions";
import { applyTagRow } from "./appliers/tags";
import { reconcileMemberships, reconcilePackages, type Reconciliation } from "./reconcile";
import { buildRunReport, countRows, mappingHash, type ImportReport } from "./report";

const mode = z.enum(["dry", "run"]);

/** Key `import:<id>:<run_seq>:parse`. */
export const ImportParseInput = z.object({ importId: z.uuid(), runSeq: z.number().int().min(0) });
/** Key `import:<id>:<run_seq>:<dry|run>:chunk:<n>`. */
export const ImportProcessChunkInput = z.object({ importId: z.uuid(), runSeq: z.number().int().min(0), mode, offset: z.number().int().min(0) });
/** Key `import:<id>:<run_seq>:<dry|run>:finalise`. */
export const ImportFinaliseInput = z.object({ importId: z.uuid(), runSeq: z.number().int().min(0), mode });

export type ImportJobStubResult = { implemented: false };

/** `maxAttempts` of `import.process_chunk` in `../jobs.ts`: the last attempt sets the import `failed`. */
export const CHUNK_MAX_ATTEMPTS = 6;
/** Rule 52: raw parts expire this long after the import finishes. */
export const FILE_RETENTION_DAYS = 30;
/** `import.finalise` enqueues at most this many person refreshes; the nightly run covers the rest. */
export const MAX_REFRESHES = 5000;

/** One applier per kind (ops-P4 exposes `RowApplier`). */
export const APPLIERS: Readonly<Record<ImportKind, RowApplier>> = {
  persons: applyPersonRow,
  suppressions: applySuppressionRow,
  consents: applyConsentRow,
  tags: applyTagRow,
  companies: applyCompanyRow,
  bookings: applyBookingRow,
  packages: applyPackageRow,
  memberships: applyMembershipRow,
  history: applyHistoryRow,
};

/** The target fields a mapping may use for a kind and source (`IMPORT_TARGETS`, plus the webinar extras). */
export function allowedTargets(kind: ImportKind, source: ImportSource): readonly string[] {
  const base: readonly string[] = IMPORT_TARGETS[kind];
  return kind === "history" && source === "webinar_tool" ? [...base, ...WEBINAR_EXTRA_TARGETS] : base;
}

/** The mapped fields of a CSV record: unmapped columns are dropped (ops spec 2.2 `import_rows.data`). */
export function mapRecord(record: Record<string, string>, mapping: ImportMapping): RowData {
  const data: RowData = {};
  for (const [column, target] of Object.entries(mapping.columns)) {
    if (!target) continue;
    const value = (record[column] ?? "").trim();
    if (!value || data[target]) continue;
    data[target] = value;
  }
  return data;
}

export type ImportRecord = typeof imports.$inferSelect;

export async function loadImport(tx: DbOrTx, importId: string, opts: { lock?: boolean } = {}): Promise<ImportRecord | null> {
  if (opts.lock) await tx.execute(sql`select id from imports where id = ${importId}::uuid for update`);
  const [row] = await tx.select().from(imports).where(eq(imports.id, importId));
  return row ?? null;
}

const asMapping = (imp: ImportRecord): ImportMapping => imp.mapping as ImportMapping;
const reportOf = (imp: ImportRecord): ImportReport => (imp.report ?? {});

/** Marks the import `failed` in a write that survives the job's rollback (rule 43a). */
async function failDurably(ctx: JobCtx, importId: string, runSeq: number, code: string, phase: "parse" | "dry" | "run"): Promise<void> {
  await writeDurably(ctx, async (db) => {
    await db
      .update(imports)
      .set({
        status: "failed",
        report: sql`${imports.report} || ${JSON.stringify({ error: code, failed_phase: phase })}::jsonb`,
        finishedAt: ctx.now,
        updatedAt: ctx.now,
      })
      .where(and(eq(imports.id, importId), eq(imports.runSeq, runSeq), inArray(imports.status, ["uploaded", "dry_run", "running"])));
  });
}

// ---------------------------------------------------------------------------
// import.parse
// ---------------------------------------------------------------------------

/** The import's parts in order; `PermanentError` when one is gone (expired or deleted). */
export async function readParts(tx: DbOrTx, imp: Pick<ImportRecord, "fileId" | "partFileIds">): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for (const id of [imp.fileId, ...(imp.partFileIds ?? [])]) {
    const f = await readFile(tx, id);
    if (!f) throw new PermanentError("file_missing");
    out.push(f.bytes);
  }
  return out;
}

/** Edge case 6: non-UTF-8 bytes (Windows-1252 exports) fail the parse: "save as CSV UTF-8". */
export function assertUtf8(parts: readonly Uint8Array[]): void {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    for (const p of parts) decoder.decode(p, { stream: true });
    decoder.decode();
  } catch {
    throw new PermanentError("not_utf8");
  }
}

async function upsertRows(tx: Tx, importId: string, batch: { rowNumber: number; data: RowData }[]): Promise<void> {
  if (!batch.length) return;
  await tx
    .insert(importRows)
    .values(batch.map((r) => ({ importId, rowNumber: r.rowNumber, data: r.data })))
    .onConflictDoUpdate({
      target: [importRows.importId, importRows.rowNumber],
      set: { data: sql`excluded.data`, dryRunStatus: null, message: null, personId: null, entityType: null, entityId: null, updatedAt: sql`now()` },
      setWhere: sql`${importRows.status} = 'pending'`,
    });
}

/** Streams the parts, writes `import_rows` in batches of 500, sets `row_count`, starts chunk 0. */
export async function runImportParse(ctx: JobCtx, input: z.infer<typeof ImportParseInput>): Promise<unknown> {
  const imp = await loadImport(ctx.tx, input.importId);
  if (!imp || imp.runSeq !== input.runSeq || imp.status !== "dry_run") return { skipped: "stale" };
  const mapping = asMapping(imp);
  try {
    const parts = await readParts(ctx.tx, imp);
    assertUtf8(parts);
    const seen = new Map<string, number>();
    let rowNumber = 0;
    let batch: { rowNumber: number; data: RowData }[] = [];
    for await (const record of parseCsvStream(parts, { delimiter: mapping.options.delimiter })) {
      rowNumber += 1;
      const data = mapRecord(record, mapping);
      if (imp.kind === "persons") {
        const email = normaliseEmail(data.email ?? null);
        if (email) {
          const first = seen.get(email);
          if (first) data[DUP_MARKER] = String(first);
          else seen.set(email, rowNumber);
        }
      }
      batch.push({ rowNumber, data });
      if (batch.length >= IMPORT_CHUNK_ROWS) {
        await upsertRows(ctx.tx, imp.id, batch);
        batch = [];
      }
    }
    await upsertRows(ctx.tx, imp.id, batch);
    await ctx.tx.delete(importRows).where(and(eq(importRows.importId, imp.id), gt(importRows.rowNumber, rowNumber)));
    await ctx.tx.update(imports).set({ rowCount: rowNumber, counts: { pending: rowNumber }, updatedAt: ctx.now }).where(eq(imports.id, imp.id));
    await ctx.enqueue({
      kind: rowNumber ? "import.process_chunk" : "import.finalise",
      payload: rowNumber ? { importId: imp.id, runSeq: imp.runSeq, mode: "dry", offset: 0 } : { importId: imp.id, runSeq: imp.runSeq, mode: "dry" },
      key: rowNumber ? `import:${imp.id}:${imp.runSeq}:dry:chunk:0` : `import:${imp.id}:${imp.runSeq}:dry:finalise`,
    });
    return { rows: rowNumber };
  } catch (error) {
    const code = error instanceof CsvParseError ? "malformed_csv" : error instanceof PermanentError ? error.message : null;
    if (code) {
      await failDurably(ctx, imp.id, imp.runSeq, code, "parse");
      throw new PermanentError(code);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// import.process_chunk
// ---------------------------------------------------------------------------

async function processChunk(ctx: JobCtx, input: z.infer<typeof ImportProcessChunkInput>): Promise<unknown> {
  const tx = ctx.tx;
  const imp = await loadImport(tx, input.importId);
  if (!imp || imp.runSeq !== input.runSeq) return { skipped: "stale" };
  if (imp.status === "cancelled") return { skipped: "cancelled" };
  if (imp.status !== (input.mode === "dry" ? "dry_run" : "running")) return { skipped: imp.status };
  const dryRun = input.mode === "dry";
  const mapping = asMapping(imp);
  const applier = APPLIERS[imp.kind];
  const end = input.offset + IMPORT_CHUNK_ROWS;
  const rows = await tx
    .select({ id: importRows.id, rowNumber: importRows.rowNumber, data: importRows.data })
    .from(importRows)
    .where(and(eq(importRows.importId, imp.id), gt(importRows.rowNumber, input.offset), lte(importRows.rowNumber, end), ...(dryRun ? [] : [eq(importRows.status, "pending")])))
    .orderBy(asc(importRows.rowNumber));

  for (const r of rows) {
    const row: ImportRow = { id: r.id, importId: imp.id, importName: imp.name, rowNumber: r.rowNumber, source: imp.source, kind: imp.kind, data: r.data };
    const outcome = await applyRow(tx, ctx, row, { dryRun, mapping }, applier);
    await tx
      .update(importRows)
      .set({
        ...(dryRun ? { dryRunStatus: outcome.status } : { status: outcome.status }),
        message: outcome.message ?? null,
        personId: outcome.personId ?? null,
        entityType: outcome.entityType ?? null,
        entityId: outcome.entityId ?? null,
        updatedAt: ctx.now,
      })
      .where(eq(importRows.id, r.id));
  }

  await tx.update(imports).set({ counts: await countRows(tx, imp.id, input.mode), updatedAt: ctx.now }).where(eq(imports.id, imp.id));
  const n = input.offset / IMPORT_CHUNK_ROWS;
  if (end < imp.rowCount) {
    await ctx.enqueue({ kind: "import.process_chunk", payload: { ...input, offset: end }, key: `import:${imp.id}:${imp.runSeq}:${input.mode}:chunk:${n + 1}` });
  } else {
    await ctx.enqueue({ kind: "import.finalise", payload: { importId: imp.id, runSeq: imp.runSeq, mode: input.mode }, key: `import:${imp.id}:${imp.runSeq}:${input.mode}:finalise` });
  }
  return { processed: rows.length, offset: input.offset };
}

/** Rule 51: 500 rows per chunk in its own transaction, then the next offset. */
export async function runImportProcessChunk(ctx: JobCtx, input: z.infer<typeof ImportProcessChunkInput>): Promise<unknown> {
  try {
    return await processChunk(ctx, input);
  } catch (error) {
    const permanent = error instanceof Error && (error as { retryable?: unknown }).retryable === false;
    if (permanent || ctx.job.attempt >= CHUNK_MAX_ATTEMPTS) {
      await failDurably(ctx, input.importId, input.runSeq, "chunk_failed", input.mode === "dry" ? "dry" : "run");
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// import.finalise
// ---------------------------------------------------------------------------

/** Rule 53: ticks the import steps whose `done` import exists (and, for `packages_reconciled`, the sign-off). */
export async function autoTickCutover(tx: DbOrTx, now: Date): Promise<void> {
  const done = await tx
    .select({ kind: imports.kind, signedOffAt: imports.signedOffAt })
    .from(imports)
    .where(eq(imports.status, "done"));
  for (const key of CUTOVER_STEPS) {
    const rule = CUTOVER_RULES[key];
    if (rule.mode !== "import") continue;
    const hit = done.some((d) => d.kind === rule.importKind && (!rule.needsSignOff || !!d.signedOffAt));
    if (!hit) continue;
    await tx
      .insert(cutoverChecklistItems)
      .values({ key, doneAt: now })
      .onConflictDoUpdate({ target: cutoverChecklistItems.key, set: { doneAt: sql`coalesce(${cutoverChecklistItems.doneAt}, ${now.toISOString()}::timestamptz)`, updatedAt: now } });
  }
}

/** Report, reconciliation, status, cut-over auto-ticks, stats refreshes. */
export async function runImportFinalise(ctx: JobCtx, input: z.infer<typeof ImportFinaliseInput>): Promise<unknown> {
  const tx = ctx.tx;
  const imp = await loadImport(tx, input.importId, { lock: true });
  if (!imp || imp.runSeq !== input.runSeq) return { skipped: "stale" };
  const runReport = await buildRunReport(tx, imp.id, input.mode);
  const counts = runReport.rows;
  const report: ImportReport = { ...reportOf(imp) };
  let reconciliation: Reconciliation | null = null;
  if (imp.kind === "packages") reconciliation = await reconcilePackages(tx, imp.id);
  if (imp.kind === "memberships") reconciliation = await reconcileMemberships(tx, imp.id);
  const previous = imp.reconciliation as Reconciliation | null;
  if (reconciliation && previous?.signOffNote) reconciliation.signOffNote = previous.signOffNote;

  if (input.mode === "dry") {
    if (imp.status !== "dry_run") return { skipped: imp.status };
    report.dry_run = runReport;
    // Rule 44: the hash of the mapping the rows were parsed with, not of the mapping at finalise time.
    report.mapping_hash = report.dry_run_mapping_hash ?? mappingHash(asMapping(imp));
    delete report.dry_run_mapping_hash;
    await tx
      .update(imports)
      .set({ report, counts, reconciliation, finishedAt: imp.finishedAt ?? ctx.now, updatedAt: ctx.now })
      .where(eq(imports.id, imp.id));
    return { status: "dry_run", counts };
  }

  if (imp.status !== "running" && imp.status !== "done" && imp.status !== "cancelled") return { skipped: imp.status };
  report.run = runReport;
  if (imp.status === "cancelled") report.partial = true;
  const status = imp.status === "running" ? "done" : imp.status;
  const finishedAt = imp.finishedAt ?? ctx.now;
  await tx.update(imports).set({ status, report, counts, reconciliation, finishedAt, updatedAt: ctx.now }).where(eq(imports.id, imp.id));
  await tx
    .update(files)
    .set({ expiresAt: new Date(finishedAt.getTime() + FILE_RETENTION_DAYS * 86_400_000) })
    .where(inArray(files.id, [imp.fileId, ...(imp.partFileIds ?? [])]));
  if (status === "done") await autoTickCutover(tx, ctx.now);

  const touched = await tx
    .selectDistinct({ personId: importRows.personId })
    .from(importRows)
    .where(and(eq(importRows.importId, imp.id), isNotNull(importRows.personId), inArray(importRows.status, ["imported", "updated"])))
    .limit(MAX_REFRESHES + 1);
  if (touched.length <= MAX_REFRESHES) {
    for (const t of touched) {
      await ctx.enqueue({ kind: "ops.refresh_person", payload: { personId: t.personId! }, key: `ops.refresh_person:${t.personId}:import:${imp.id}:${imp.runSeq}` });
    }
  }
  return { status, counts, refreshes: touched.length <= MAX_REFRESHES ? touched.length : 0 };
}

/** The `presetOf` helper, re-exported for the screens. */
export { presetOf };
