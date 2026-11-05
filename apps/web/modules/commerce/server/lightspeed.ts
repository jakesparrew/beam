/**
 * Lightspeed till import (commerce rule 53, edge case 24, R3, commerce-P9). Staff upload the
 * daily sales CSV exported from the Lightspeed back office (`uploadLightspeedCsv`); the file is
 * stored in `files` (kind `import`), a `lightspeed_imports` row is created and
 * `commerce.import_lightspeed {importId, offset: 0}` is enqueued in the same transaction, so the
 * upload is processed at once after the response; the nightly
 * `commerce.import_lightspeed_pending` (02:40) picks up any import still `uploaded`.
 *
 * Each run parses the file with `parseLightspeedCsv`, inserts 1,000 rows from `offset` with
 * `on conflict (external_line_key) do nothing` and enqueues the next chunk
 * (`lightspeed:<import_id>:<offset>`). The counters are recounted from `lightspeed_sales`, so a
 * replayed run changes nothing: `rows_imported` is the number of rows this import added,
 * `rows_skipped` the rows it did not add (lines already imported by an earlier upload, and
 * broken rows, which are listed in `errors` with their row numbers). Rows are reporting data
 * only: no orders, persons or invoices are created.
 */
import { z } from "zod";
import { files, lightspeedImports, lightspeedSales, vLightspeedDaily, type LightspeedImportErrorJson } from "@beam/db/schema";
import { readFile, storeFile } from "@/lib/files";
import { and, asc, desc, eq, gte, lte, sql, NotFoundError, ValidationError, type Ctx, type DbOrTx } from "@/lib/ctx";
import type { JobCtx } from "@/lib/job-runner";
import { businessDayRange, parseLightspeedCsv, type RowError } from "../../../../../packages/core/src/commerce/lightspeed";

/** Upload limit of the spec (section 4.2). */
export const LIGHTSPEED_MAX_BYTES = 5 * 1024 * 1024;
/** Rows per `commerce.import_lightspeed` run. */
export const LIGHTSPEED_CHUNK = 1000;
/** At most this many row errors are kept on the import (the count is in `rows_skipped`). */
export const LIGHTSPEED_MAX_ERRORS = 500;

const CSV_MIMES = new Set(["text/csv", "text/plain", "application/csv", "application/vnd.ms-excel", "text/comma-separated-values", ""]);

export const ImportLightspeedInput = z.object({ importId: z.uuid(), offset: z.number().int().min(0) });
export const ImportLightspeedPendingInput = z.object({}).passthrough();

export const importKey = (importId: string, offset: number) => `lightspeed:${importId}:${offset}`;

function staffUserId(ctx: Ctx): string {
  if (ctx.actor.kind !== "staff") throw new ValidationError("staff_only");
  return ctx.actor.userId;
}

/** Decodes the upload: UTF-8 (BOM allowed), else Windows-1252, which older Lightspeed exports use. */
export function decodeCsv(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

/**
 * `uploadLightspeedCsv` (staff, `commerce.sell`): `{file}` (csv, at most 5 MB). Stores the file,
 * creates the import, enqueues its first chunk and audits `lightspeed.uploaded`.
 */
export async function uploadLightspeedCsvRecord(ctx: Ctx, form: FormData): Promise<{ importId: string }> {
  const userId = staffUserId(ctx);
  const file = form.get("file");
  if (!(file instanceof Blob) || file.size === 0) throw new ValidationError("file_required", { file: "required" });
  if (file.size > LIGHTSPEED_MAX_BYTES) throw new ValidationError("file_too_large", { file: "too_large" });
  const name = (file as Blob & { name?: string }).name || "lightspeed.csv";
  if (!/\.(csv|txt)$/i.test(name) || !CSV_MIMES.has(file.type)) throw new ValidationError("file_type", { file: "type_not_allowed" });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const { fileId, sha256 } = await storeFile(ctx, { kind: "import", name, mime: "text/csv", bytes });
  const [row] = await ctx.tx.insert(lightspeedImports).values({ fileId, createdByUserId: userId }).returning({ id: lightspeedImports.id });
  const importId = row!.id;
  await ctx.enqueue({ kind: "commerce.import_lightspeed", payload: { importId, offset: 0 }, key: importKey(importId, 0) });
  await ctx.audit({
    action: "lightspeed.uploaded",
    entityType: "lightspeed_import",
    entityId: importId,
    newValue: { file_id: fileId, name, size_bytes: bytes.byteLength, sha256 },
  });
  return { importId };
}

const toErrorJson = (errors: readonly RowError[]): LightspeedImportErrorJson[] =>
  errors.slice(0, LIGHTSPEED_MAX_ERRORS).map((e) => (e.column ? { row: e.row, code: e.code, column: e.column } : { row: e.row, code: e.code }));

export type ImportLightspeedResult = { status: "running" | "done" | "failed" | "skipped"; inserted: number; nextOffset: number | null };

/** `commerce.import_lightspeed` (bulk, 9; key `lightspeed:<import_id>:<offset>`). */
export async function importLightspeedChunk(ctx: JobCtx, input: z.infer<typeof ImportLightspeedInput>): Promise<ImportLightspeedResult> {
  const [imp] = await ctx.tx.select().from(lightspeedImports).where(eq(lightspeedImports.id, input.importId)).for("update");
  if (!imp) throw new NotFoundError("lightspeed_import_not_found");
  if (imp.status === "done" || imp.status === "failed") return { status: "skipped", inserted: 0, nextOffset: null };

  const file = await readFile(ctx.tx, imp.fileId);
  if (!file) {
    await ctx.tx
      .update(lightspeedImports)
      .set({ status: "failed", errors: [{ row: 0, code: "file_missing" }], updatedAt: sql`now()` })
      .where(eq(lightspeedImports.id, imp.id));
    return { status: "failed", inserted: 0, nextOffset: null };
  }
  const { rows, errors } = parseLightspeedCsv(decodeCsv(file.bytes));
  const headerBroken = rows.length === 0 && errors.some((e) => e.code === "missing_column" || e.code === "empty_file");
  if (headerBroken) {
    await ctx.tx
      .update(lightspeedImports)
      .set({ status: "failed", errors: toErrorJson(errors), updatedAt: sql`now()` })
      .where(eq(lightspeedImports.id, imp.id));
    return { status: "failed", inserted: 0, nextOffset: null };
  }

  const chunk = rows.slice(input.offset, input.offset + LIGHTSPEED_CHUNK);
  const inserted = chunk.length
    ? await ctx.tx
        .insert(lightspeedSales)
        .values(
          chunk.map((r) => ({
            importId: imp.id,
            externalLineKey: r.externalLineKey,
            businessDayOn: r.businessDayOn,
            soldAt: r.soldAt,
            receiptNumber: r.receiptNumber,
            productName: r.productName,
            category: r.category,
            quantity: r.quantity,
            totalCents: r.totalCents,
            vatRatePct: r.vatRatePct,
            vatCents: r.vatCents,
            paymentMethod: r.paymentMethod,
          })),
        )
        .onConflictDoNothing({ target: lightspeedSales.externalLineKey })
        .returning({ id: lightspeedSales.id })
    : [];

  const [counted] = await ctx.tx
    .select({ n: sql<number>`count(*)::int` })
    .from(lightspeedSales)
    .where(eq(lightspeedSales.importId, imp.id));
  const rowsImported = Number(counted?.n ?? 0);
  const rowsTotal = rows.length + errors.length;
  const next = input.offset + LIGHTSPEED_CHUNK;
  const more = next < rows.length;
  const range = businessDayRange(rows);
  await ctx.tx
    .update(lightspeedImports)
    .set({
      status: more ? "running" : "done",
      rowsTotal,
      rowsImported,
      rowsSkipped: more ? errors.length : rowsTotal - rowsImported,
      errors: toErrorJson(errors),
      businessFromOn: range?.from ?? null,
      businessToOn: range?.to ?? null,
      updatedAt: sql`now()`,
    })
    .where(eq(lightspeedImports.id, imp.id));
  if (more) await ctx.enqueue({ kind: "commerce.import_lightspeed", payload: { importId: imp.id, offset: next }, key: importKey(imp.id, next) });
  return { status: more ? "running" : "done", inserted: inserted.length, nextOffset: more ? next : null };
}

/** `onDead` of `commerce.import_lightspeed`: the import is marked `failed` with the reason. */
export async function failLightspeedImport(ctx: JobCtx, input: z.infer<typeof ImportLightspeedInput>): Promise<void> {
  await ctx.tx
    .update(lightspeedImports)
    .set({ status: "failed", errors: sql`${lightspeedImports.errors} || ${JSON.stringify([{ row: 0, code: "import_failed" }])}::jsonb`, updatedAt: sql`now()` })
    .where(and(eq(lightspeedImports.id, input.importId), sql`${lightspeedImports.status} in ('uploaded', 'running')`));
}

/**
 * `commerce.import_lightspeed_pending` (bulk, 9; daily 02:40, key
 * `schedule:commerce.import_lightspeed_pending:<minute>`): enqueues the first chunk of every
 * import still `uploaded` (the key dedupes against the upload's own job).
 */
export async function importPendingLightspeed(ctx: JobCtx): Promise<{ enqueued: number }> {
  const pending = await ctx.tx
    .select({ id: lightspeedImports.id })
    .from(lightspeedImports)
    .where(eq(lightspeedImports.status, "uploaded"))
    .orderBy(asc(lightspeedImports.createdAt))
    .limit(200);
  let enqueued = 0;
  for (const p of pending) {
    const r = await ctx.enqueue({ kind: "commerce.import_lightspeed", payload: { importId: p.id, offset: 0 }, key: importKey(p.id, 0) });
    if (r.inserted) enqueued++;
  }
  return { enqueued };
}

// ---------------------------------------------------------------------------
// Reads (`/admin/pos/lightspeed`)
// ---------------------------------------------------------------------------

export type LightspeedImportListItem = {
  id: string;
  fileName: string;
  status: (typeof lightspeedImports.$inferSelect)["status"];
  businessFromOn: string | null;
  businessToOn: string | null;
  rowsTotal: number;
  rowsImported: number;
  rowsSkipped: number;
  errors: LightspeedImportErrorJson[];
  createdAt: Date;
};

/** The latest imports, newest first. */
export async function listLightspeedImports(db: DbOrTx, opts: { limit?: number } = {}): Promise<LightspeedImportListItem[]> {
  return db
    .select({
      id: lightspeedImports.id,
      fileName: files.name,
      status: lightspeedImports.status,
      businessFromOn: lightspeedImports.businessFromOn,
      businessToOn: lightspeedImports.businessToOn,
      rowsTotal: lightspeedImports.rowsTotal,
      rowsImported: lightspeedImports.rowsImported,
      rowsSkipped: lightspeedImports.rowsSkipped,
      errors: lightspeedImports.errors,
      createdAt: lightspeedImports.createdAt,
    })
    .from(lightspeedImports)
    .innerJoin(files, eq(files.id, lightspeedImports.fileId))
    .orderBy(desc(lightspeedImports.createdAt), desc(lightspeedImports.id))
    .limit(Math.min(Math.max(opts.limit ?? 50, 1), 200));
}

/** `v_lightspeed_daily` between two business days (inclusive), by day then category. */
export async function getLightspeedDaily(
  db: DbOrTx,
  input: { from: string; to: string },
): Promise<Array<{ businessDayOn: string; category: string; totalCents: number; vatCents: number; receipts: number; lines: number }>> {
  return db
    .select()
    .from(vLightspeedDaily)
    .where(and(gte(vLightspeedDaily.businessDayOn, input.from), lte(vLightspeedDaily.businessDayOn, input.to)))
    .orderBy(desc(vLightspeedDaily.businessDayOn), asc(vLightspeedDaily.category));
}
