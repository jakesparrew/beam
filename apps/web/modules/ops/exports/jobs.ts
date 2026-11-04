/**
 * ops jobs, area `exports` (ops spec 4.4, rules 54-57, 68-69): `ops.export_chunk`,
 * `ops.export_finalise`, `privacy.retention_sweep`. Registered in `../jobs.ts` by ops-P1 and
 * implemented here by ops-P6 with the same names, inputs and signatures.
 *
 * Export states (`data_exports.status`): `queued` (createExport) → `running` (first chunk) →
 * `done` (finalise, `expires_at` = now + 7 days) → `expired` (the `ops.data_exports` sweep, once
 * `expires_at` passed); `queued` or `running` → `failed` when a chunk or the finalise job fails
 * on its last attempt or permanently (written through `writeDurably`, so it survives the job's
 * rollback). `done`, `failed` and `expired` are final; only `done` and unexpired downloads.
 */
import { z } from "zod";
import { dataExports, retentionPolicies } from "@beam/db/schema";
import type { Tx } from "@beam/db";
import type { PrivacyRegistration } from "@beam/core/privacy";
import { brusselsDate, collectBytes, EXPORT_CHUNK_ROWS, EXPORT_EXPIRY_DAYS, EXPORT_PART_MAX_BYTES, toCsv, type ExportEntity } from "@beam/core/ops";
import { and, asc, eq, inArray, sql, writeDurably } from "@/lib/ctx";
import { storeFile } from "@/lib/files";
import { PermanentError, type JobCtx } from "@/lib/job-runner";
import { reportError } from "@/lib/logger";
import { GDPR_REGISTRY } from "@/registry/privacy.generated";
import { entitySource, fullTableSource, readChunk, type ExportSource } from "./entities";
import { genericSweep, isGenericSweepTable } from "./generic-sweep";
import { OPS_SWEEP } from "./sweep";

/** Key `export:<id>:<entity>:chunk:<n>` (`entity`: an `EXPORT_ENTITIES` member, or a table of the full export). */
export const ExportChunkInput = z.object({ exportId: z.uuid(), entity: z.string().regex(/^[a-z_]+$/), offset: z.number().int().min(0) });
/** Key `export:<id>:finalise`. */
export const ExportFinaliseInput = z.object({ exportId: z.uuid() });
/** Schedule key `schedule:privacy.retention_sweep:<minute>`; continuations `retention:<runOn>:<policyKey>:<n>`. */
export const RetentionSweepInput = z.object({
  runOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  policyKey: z.string().regex(/^[a-z]+\.[a-z][a-z0-9_]*$/).optional(),
  n: z.number().int().min(0).optional(),
});

/** `maxAttempts` of `ops.export_chunk` and `ops.export_finalise` in `../jobs.ts` (the defineJob default). */
export const EXPORT_MAX_ATTEMPTS = 6;
const DAY_MS = 86_400_000;
const OPEN_STATUSES = ["queued", "running"] as const;

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/** A written part; `lastKey` is the order key of its last row, where the next chunk of its source starts. */
export type ExportPart = { name: string; fileId: string; rows: number; source: string; lastKey?: string[] | null };
/** `data_exports.cursor`: the full export's table list, the parts written and the counts per source. */
export type ExportCursor = { tables?: string[]; parts: ExportPart[]; counts: Record<string, number>; excluded: Record<string, string[]> };

export function emptyCursor(tables?: string[]): ExportCursor {
  return { ...(tables ? { tables } : {}), parts: [], counts: {}, excluded: {} };
}

export const chunkKey = (exportId: string, entity: string, n: number) => `export:${exportId}:${entity}:chunk:${n}`;
export const finaliseKey = (exportId: string) => `export:${exportId}:finalise`;

type ExportRow = typeof dataExports.$inferSelect;

async function lockExport(tx: Tx, exportId: string): Promise<ExportRow | null> {
  await tx.execute(sql`select id from data_exports where id = ${exportId}::uuid for update`);
  const [row] = await tx.select().from(dataExports).where(eq(dataExports.id, exportId));
  return row ?? null;
}

const cursorOf = (row: ExportRow): ExportCursor => {
  const c = (row.cursor ?? {}) as Partial<ExportCursor>;
  return { ...(c.tables ? { tables: c.tables } : {}), parts: c.parts ?? [], counts: c.counts ?? {}, excluded: c.excluded ?? {} };
};

const isOpen = (status: ExportRow["status"]) => (OPEN_STATUSES as readonly string[]).includes(status);

async function sourceFor(ctx: JobCtx, row: ExportRow, cursor: ExportCursor, entity: string): Promise<ExportSource> {
  if (row.kind === "entity") {
    if (entity !== row.entity) throw new PermanentError(`export_entity_mismatch: ${entity}`);
    return entitySource(row.entity as ExportEntity, row.filters);
  }
  if (!cursor.tables?.includes(entity)) throw new PermanentError(`export_table_unknown: ${entity}`);
  return fullTableSource(ctx.tx, entity);
}

/** Marks the export `failed` in a write that survives the job's rollback. */
async function failDurably(ctx: JobCtx, exportId: string): Promise<void> {
  await writeDurably(ctx, async (db) => {
    await db
      .update(dataExports)
      .set({ status: "failed", completedAt: ctx.now, updatedAt: ctx.now })
      .where(and(eq(dataExports.id, exportId), inArray(dataExports.status, [...OPEN_STATUSES])));
  });
}

async function failOnLastAttempt<T>(ctx: JobCtx, exportId: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof PermanentError || ctx.job.attempt >= EXPORT_MAX_ATTEMPTS) await failDurably(ctx, exportId);
    throw error;
  }
}

async function exportChunk(ctx: JobCtx, input: z.infer<typeof ExportChunkInput>) {
  const row = await lockExport(ctx.tx, input.exportId);
  if (!row || !isOpen(row.status)) return { skipped: row?.status ?? "missing" };
  if (input.offset % EXPORT_CHUNK_ROWS !== 0) throw new PermanentError("export_offset_not_aligned");
  const cursor = cursorOf(row);
  const source = await sourceFor(ctx, row, cursor, input.entity);
  const n = input.offset / EXPORT_CHUNK_ROWS;
  const name = `${source.name}-${n + 1}.csv`;
  let part = cursor.parts.find((p) => p.name === name);
  if (!part) {
    // Keyset paging (review findings 2 and 4): chunk n starts after the last key of part n (chunk n-1).
    // `offset` stays the chunk index of the job key and the part name; it reads rows only for a
    // source without a primary key, or a previous part written before parts carried their key.
    const previous = n > 0 ? cursor.parts.find((p) => p.name === `${source.name}-${n}.csv`) : undefined;
    if (n > 0 && !previous) throw new PermanentError("export_previous_part_missing");
    const keyset = source.key && (n === 0 || !!previous?.lastKey) ? source : { ...source, key: null };
    const { rows, lastKey } = await readChunk(ctx.tx, keyset, previous?.lastKey ?? null, EXPORT_CHUNK_ROWS, input.offset);
    const bytes = await collectBytes(toCsv(source.columns, rows));
    if (bytes.byteLength > EXPORT_PART_MAX_BYTES) throw new PermanentError("export_part_too_large");
    const { fileId } = await storeFile(ctx, { kind: "export", name, mime: "text/csv", bytes, expiresAt: new Date(ctx.now.getTime() + EXPORT_EXPIRY_DAYS * DAY_MS) });
    part = { name, fileId, rows: rows.length, source: source.name, lastKey };
    cursor.parts.push(part);
    cursor.counts[source.name] = (cursor.counts[source.name] ?? 0) + rows.length;
    cursor.excluded[source.name] = source.excluded;
    await ctx.tx
      .update(dataExports)
      .set({
        status: "running",
        cursor,
        partFileIds: sql`array_append(${dataExports.partFileIds}, ${fileId}::uuid)`,
        rowCount: sql`${dataExports.rowCount} + ${rows.length}`,
        updatedAt: ctx.now,
      })
      .where(eq(dataExports.id, row.id));
  } else if (row.status === "queued") {
    await ctx.tx.update(dataExports).set({ status: "running", updatedAt: ctx.now }).where(eq(dataExports.id, row.id));
  }

  if (part.rows === EXPORT_CHUNK_ROWS) {
    await ctx.enqueue({ kind: "ops.export_chunk", payload: { exportId: row.id, entity: input.entity, offset: input.offset + EXPORT_CHUNK_ROWS }, key: chunkKey(row.id, input.entity, n + 1) });
  } else {
    const tables = cursor.tables ?? [];
    const next = row.kind === "full" ? tables[tables.indexOf(input.entity) + 1] : undefined;
    if (next) await ctx.enqueue({ kind: "ops.export_chunk", payload: { exportId: row.id, entity: next, offset: 0 }, key: chunkKey(row.id, next, 0) });
    else await ctx.enqueue({ kind: "ops.export_finalise", payload: { exportId: row.id }, key: finaliseKey(row.id) });
  }
  return { part: part.name, rows: part.rows };
}

/** Rule 55: 5,000 rows to one CSV part, then the next chunk, the next table or the finalise job. */
export function runExportChunk(ctx: JobCtx, input: z.infer<typeof ExportChunkInput>): Promise<unknown> {
  return failOnLastAttempt(ctx, input.exportId, () => exportChunk(ctx, input));
}

/** `README.csv` of the full export (rule 56): every table, its row count and its excluded columns. */
export async function readmeCsv(cursor: ExportCursor): Promise<Uint8Array> {
  const tables = cursor.tables ?? [];
  return collectBytes(toCsv(["table", "row_count", "excluded_columns"], tables.map((t) => [t, cursor.counts[t] ?? 0, (cursor.excluded[t] ?? []).join(" ")])));
}

async function exportFinalise(ctx: JobCtx, input: z.infer<typeof ExportFinaliseInput>) {
  const row = await lockExport(ctx.tx, input.exportId);
  if (!row || !isOpen(row.status)) return { skipped: row?.status ?? "missing" };
  const cursor = cursorOf(row);
  const expiresAt = new Date(ctx.now.getTime() + EXPORT_EXPIRY_DAYS * DAY_MS);
  const partFileIds = [...row.partFileIds];
  if (row.kind === "full" && !cursor.parts.some((p) => p.name === "README.csv")) {
    const { fileId } = await storeFile(ctx, { kind: "export", name: "README.csv", mime: "text/csv", bytes: await readmeCsv(cursor), expiresAt });
    cursor.parts.push({ name: "README.csv", fileId, rows: (cursor.tables ?? []).length, source: "README" });
    partFileIds.push(fileId);
  }
  await ctx.tx
    .update(dataExports)
    .set({ status: "done", cursor, partFileIds, completedAt: ctx.now, expiresAt, updatedAt: ctx.now })
    .where(eq(dataExports.id, row.id));
  // Rule 57: once per export, with entity, filters and row count.
  await ctx.audit({
    action: "data.exported",
    entityType: "data_export",
    entityId: row.id,
    newValue: { kind: row.kind, entity: row.entity ?? "full", filters: row.filters, rows: row.rowCount, createdByUserId: row.createdByUserId },
  });
  return { done: true, rows: row.rowCount };
}

/** Sets `done`, `expires_at`, audit `data.exported`. */
export function runExportFinalise(ctx: JobCtx, input: z.infer<typeof ExportFinaliseInput>): Promise<unknown> {
  return failOnLastAttempt(ctx, input.exportId, () => exportFinalise(ctx, input));
}

// ---------------------------------------------------------------------------
// Retention sweep (rules 68-69a)
// ---------------------------------------------------------------------------

type SweepHandler = (tx: Tx, cutoff: Date) => Promise<number>;
type Registry = Readonly<Record<string, Pick<PrivacyRegistration<Tx>, "sweep">>>;

/**
 * Accounting-linked keys (cross-module decision 34): whatever the row says, no handler touches
 * such a record younger than 3653 days.
 */
export const ACCOUNTING_MIN_DAYS = 3653;
export const ACCOUNTING_KEYS = ["finance.invoices", "commerce.orders", "commerce.lightspeed_sales", "credits.ledger", "credits.memberships", "site.terms_acceptances"] as const;

export type SweepResolution = { kind: "module"; handler: SweepHandler } | { kind: "generic" } | { kind: "none" };

/** The owner of a key is its prefix; its `sweep[key]` wins, then the generic handler for allow-listed tables. */
export function resolveSweepHandler(policy: { key: string; tableName: string }, registry: Registry = GDPR_REGISTRY): SweepResolution {
  const owner = policy.key.split(".")[0]!;
  const registered = Object.prototype.hasOwnProperty.call(registry, owner) ? registry[owner]?.sweep?.[policy.key] : undefined;
  const handler = registered ?? (owner === "ops" ? OPS_SWEEP[policy.key] : undefined);
  if (handler) return { kind: "module", handler };
  if (isGenericSweepTable(policy.tableName)) return { kind: "generic" };
  return { kind: "none" };
}

export function effectiveDays(policy: { key: string; days: number }): number {
  return (ACCOUNTING_KEYS as readonly string[]).includes(policy.key) ? Math.max(policy.days, ACCOUNTING_MIN_DAYS) : policy.days;
}

export type SweepOptions = { registry?: Registry; budgetMs?: number; maxCallsPerJob?: number };
export type PolicyOutcome = { key: string; status: "ok" | "no_handler" | "error"; rows: number; calls: number; continued?: boolean };

type Policy = typeof retentionPolicies.$inferSelect;

/** One call of a handler in its own savepoint under `SET LOCAL beam.allow_rewrite = 'on'`. */
async function callUnderRewrite(tx: Tx, run: (sp: Tx) => Promise<number>): Promise<number> {
  return tx.transaction(async (sp) => {
    await sp.execute(sql`select set_config('beam.allow_rewrite', 'on', true)`);
    const n = await run(sp);
    await sp.execute(sql`select set_config('beam.allow_rewrite', 'off', true)`);
    return n;
  });
}

async function sweepPolicy(ctx: JobCtx, policy: Policy, resolution: SweepResolution, deadline: number, maxCalls: number): Promise<PolicyOutcome> {
  if (resolution.kind === "none") return { key: policy.key, status: "no_handler", rows: 0, calls: 0 };
  const cutoff = new Date(ctx.now.getTime() - effectiveDays({ key: policy.key, days: policy.days ?? 0 }) * DAY_MS);
  const run = (sp: Tx) => (resolution.kind === "module" ? resolution.handler(sp, cutoff) : genericSweep(sp, policy.tableName, cutoff, policy.batchSize));
  let rows = 0;
  let calls = 0;
  try {
    for (;;) {
      const n = await callUnderRewrite(ctx.tx, run);
      rows += n;
      calls += 1;
      if (n < policy.batchSize) return { key: policy.key, status: "ok", rows, calls };
      if (calls >= maxCalls || Date.now() >= deadline) return { key: policy.key, status: "ok", rows, calls, continued: true };
    }
  } catch (error) {
    reportError(error, { tags: { job: "privacy.retention_sweep", policy: policy.key } });
    return { key: policy.key, status: "error", rows, calls };
  }
}

/** Rule 68 with injectable registry and budget (tests); `runRetentionSweep` is the job handler. */
export async function sweepRetention(ctx: JobCtx, input: z.infer<typeof RetentionSweepInput>, opts: SweepOptions = {}): Promise<{ runOn: string; policies: PolicyOutcome[] }> {
  const runOn = input.runOn ?? brusselsDate(ctx.now);
  const deadline = Date.now() + (opts.budgetMs ?? 90_000);
  const maxCalls = opts.maxCallsPerJob ?? 200;
  const policies = await ctx.tx
    .select()
    .from(retentionPolicies)
    .where(and(eq(retentionPolicies.isActive, true), sql`${retentionPolicies.action} <> 'keep'`))
    .orderBy(asc(retentionPolicies.runOrder), asc(retentionPolicies.key));
  let start = 0;
  if (input.policyKey) {
    start = policies.findIndex((p) => p.key === input.policyKey);
    if (start < 0) return { runOn, policies: [] };
  }
  const outcomes: PolicyOutcome[] = [];
  for (const policy of policies.slice(start)) {
    const outcome = await sweepPolicy(ctx, policy, resolveSweepHandler(policy, opts.registry), deadline, maxCalls);
    outcomes.push(outcome);
    const continuing = input.policyKey === policy.key && (input.n ?? 0) > 0;
    await ctx.tx
      .update(retentionPolicies)
      .set({
        lastRunAt: ctx.now,
        lastRunRows: continuing ? sql`coalesce(${retentionPolicies.lastRunRows}, 0) + ${outcome.rows}` : outcome.rows,
        lastRunStatus: outcome.status,
        updatedAt: ctx.now,
      })
      .where(eq(retentionPolicies.id, policy.id));
    if (outcome.continued) {
      const n = (input.policyKey === policy.key ? (input.n ?? 0) : 0) + 1;
      await ctx.enqueue({ kind: "privacy.retention_sweep", payload: { runOn, policyKey: policy.key, n }, key: `retention:${runOn}:${policy.key}:${n}` });
      break;
    }
  }
  return { runOn, policies: outcomes };
}

/** Rules 68-69: active policies by `run_order` through their owners' `sweep[key]` handlers. */
export function runRetentionSweep(ctx: JobCtx, input: z.infer<typeof RetentionSweepInput>): Promise<unknown> {
  return sweepRetention(ctx, input);
}
