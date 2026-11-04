"use server";
/**
 * ops server actions, area `imports`: data migration imports and the cut-over checklist (ops spec
 * 4.1, rules 42-53, ops-P4): createImport, saveImportMapping, startDryRun, startImport,
 * cancelImport, signOffReconciliation, setCutoverStep. Every action goes through `action()` with
 * its Zod input from `@beam/core/ops` and audits its own `import.*` / `cutover.updated` row.
 *
 * States (rule 43a): `uploaded` → `dry_run` (startDryRun) → `dry_run` (a new dry run) → `running`
 * (startImport, after a finished dry run of the same mapping hash) → `done` (finalise);
 * `failed` → `running` (resume after a run failure, only `pending` rows); `uploaded`, `dry_run`,
 * `running` → `cancelled`. `done` and `cancelled` are final; a parse failure is final.
 */
import { files, cutoverChecklistItems, imports } from "@beam/db/schema";
import { ForbiddenError } from "@beam/core/errors";
import {
  CancelImportInput,
  CreateImportInput,
  CUTOVER_RULES,
  CsvParseError,
  detectDelimiter,
  IMPORT_PRESETS,
  IMPORT_SAMPLE_ROWS,
  MANUAL_CUTOVER_STEPS,
  missingTargets,
  NEEDS_SUPPRESSIONS_FIRST,
  parseCsvStream,
  SaveImportMappingInput,
  SetCutoverStepInput,
  SignOffReconciliationInput,
  StartDryRunInput,
  StartImportInput,
  type ImportMapping,
  type ImportPreset,
  type ImportPresetKey,
} from "@beam/core/ops";
import { action } from "@/lib/action";
import { and, ConflictError, eq, inArray, sql, ValidationError, type Ctx } from "@/lib/ctx";
import { isGoLiveGateComplete, readFile } from "@/modules/platform/api";
import { allowedTargets, autoTickCutover, FILE_RETENTION_DAYS, loadImport, type ImportRecord } from "./jobs";
import type { Reconciliation } from "./reconcile";
import { mappingHash, type ImportReport } from "./report";

function staffUserId(ctx: Ctx): string {
  if (ctx.actor.kind !== "staff") throw new ForbiddenError("forbidden: staff");
  return ctx.actor.userId;
}

async function lockedImport(ctx: Ctx, importId: string): Promise<ImportRecord> {
  const imp = await loadImport(ctx.tx, importId, { lock: true });
  if (!imp) throw new ValidationError("import_not_found", { importId: "not_found" });
  return imp;
}

const reportOf = (imp: ImportRecord): ImportReport => (imp.report ?? {}) as ImportReport;
const hasMapping = (m: ImportRecord["mapping"]): m is ImportMapping => !!m && "columns" in m && "options" in m;

/** Rule 43 plus the preset: the required targets a mapping still lacks. */
function missingFor(imp: Pick<ImportRecord, "kind">, mapping: ImportMapping): string[] {
  const mapped = Object.values(mapping.columns).filter((t): t is string => !!t);
  const preset: ImportPreset | null = mapping.options.preset && mapping.options.preset in IMPORT_PRESETS ? IMPORT_PRESETS[mapping.options.preset as ImportPresetKey] : null;
  if (preset?.historyKind) mapped.push("history_kind");
  return missingTargets(imp.kind, mapped, { productId: mapping.options.productId, tagKey: mapping.options.tagKey });
}

const isUniqueViolation = (e: unknown) => {
  const err = e as { code?: string; cause?: { code?: string } } | null;
  return err?.code === "23505" || err?.cause?.code === "23505";
};

// ---------------------------------------------------------------------------
// createImport
// ---------------------------------------------------------------------------

/** Rule 42: attaches the uploaded parts, reads the header and the first 20 rows for the mapping step. */
export const createImport = action(
  { name: "ops.import_create", audience: "staff", permission: "persons.write", input: CreateImportInput, audit: false },
  async (ctx, input): Promise<{ importId: string; header: string[]; sample: Record<string, string>[] }> => {
    const userId = staffUserId(ctx);
    if (new Set(input.fileIds).size !== input.fileIds.length) throw new ValidationError("duplicate_part", { fileIds: "duplicate" });
    const found = await ctx.tx
      .select({ id: files.id, kind: files.kind, expiresAt: files.expiresAt })
      .from(files)
      .where(inArray(files.id, input.fileIds));
    const ok = input.fileIds.every((id) => {
      const f = found.find((x) => x.id === id);
      return f && f.kind === "import" && (!f.expiresAt || f.expiresAt.getTime() > ctx.now.getTime());
    });
    if (!ok) throw new ValidationError("file_missing", { fileIds: "file_missing" });
    const first = await readFile(ctx.tx, input.fileIds[0]!);
    if (!first) throw new ValidationError("file_missing", { fileIds: "file_missing" });

    const text = new TextDecoder("utf-8").decode(first.bytes.subarray(0, 64 * 1024));
    const delimiter = detectDelimiter(text.replace(/^﻿/, "").split(/\r\n|\n|\r/)[0] ?? "");
    let header: string[] = [];
    const sample: Record<string, string>[] = [];
    try {
      for await (const record of parseCsvStream([first.bytes], { delimiter })) {
        if (!header.length) header = Object.keys(record);
        if (sample.length >= IMPORT_SAMPLE_ROWS) break;
        sample.push(record);
      }
    } catch (error) {
      if (!(error instanceof CsvParseError) || !header.length) throw new ValidationError("malformed_csv", { file: "malformed_csv" });
    }
    if (!header.length) {
      const headerOnly = text.replace(/^﻿/, "").split(/\r\n|\n|\r/)[0] ?? "";
      header = headerOnly.split(delimiter).map((h) => h.trim().replace(/^"|"$/g, ""));
      if (!header.some(Boolean)) throw new ValidationError("malformed_csv", { file: "malformed_csv" });
    }

    const [row] = await ctx.tx
      .insert(imports)
      .values({ kind: input.kind, source: input.source, name: input.name, fileId: input.fileIds[0]!, partFileIds: input.fileIds.slice(1), header, createdByUserId: userId })
      .returning({ id: imports.id });
    const importId = row!.id;
    await ctx.tx.update(files).set({ expiresAt: null }).where(inArray(files.id, input.fileIds));
    await ctx.audit({ action: "import.created", entityType: "import", entityId: importId, newValue: { kind: input.kind, source: input.source, name: input.name, parts: input.fileIds.length } });
    return { importId, header, sample };
  },
);

// ---------------------------------------------------------------------------
// saveImportMapping
// ---------------------------------------------------------------------------

/** Rule 43: stores the mapping (also an incomplete one) and returns the required targets still missing. */
export const saveImportMapping = action(
  { name: "ops.import_map", audience: "staff", permission: "persons.write", input: SaveImportMappingInput, audit: false },
  async (ctx, input): Promise<{ ok: boolean; missingTargets: string[] }> => {
    const imp = await lockedImport(ctx, input.importId);
    if (imp.status !== "uploaded" && imp.status !== "dry_run") throw new ConflictError("import_locked");
    const allowed = allowedTargets(imp.kind, imp.source);
    for (const [column, target] of Object.entries(input.mapping.columns)) {
      if (!imp.header.includes(column)) throw new ValidationError("unknown_column", { mapping: "unknown_column" });
      if (target !== null && !allowed.includes(target)) throw new ValidationError("unknown_target", { mapping: "unknown_target" });
    }
    const presetKey = input.mapping.options.preset;
    if (presetKey) {
      const preset: ImportPreset | undefined = presetKey in IMPORT_PRESETS ? IMPORT_PRESETS[presetKey as ImportPresetKey] : undefined;
      if (!preset || preset.kind !== imp.kind || preset.source !== imp.source) throw new ValidationError("invalid_preset", { preset: "invalid_preset" });
    }
    const missing = missingFor(imp, input.mapping);
    await ctx.tx.update(imports).set({ mapping: input.mapping, updatedAt: ctx.now }).where(eq(imports.id, imp.id));
    await ctx.audit({ action: "import.mapped", entityType: "import", entityId: imp.id, newValue: { mapping: input.mapping, missing } });
    return { ok: missing.length === 0, missingTargets: missing };
  },
);

// ---------------------------------------------------------------------------
// startDryRun
// ---------------------------------------------------------------------------

/** Rule 44: `run_seq + 1`, parse and process every row in dry mode (writes only `imports` and `import_rows`). */
export const startDryRun = action(
  { name: "ops.import_dry_run", audience: "staff", permission: "persons.write", input: StartDryRunInput, audit: false },
  async (ctx, input): Promise<{ jobId: string }> => {
    const imp = await lockedImport(ctx, input.importId);
    if (imp.status !== "uploaded" && imp.status !== "dry_run") throw new ConflictError("dry_run_not_allowed");
    if (!hasMapping(imp.mapping)) throw new ValidationError("missing_targets", { mapping: "missing_targets" });
    const missing = missingFor(imp, imp.mapping);
    if (missing.length) throw new ValidationError("missing_targets", { mapping: missing.join(",") });
    const runSeq = imp.runSeq + 1;
    const { dry_run: _dry, mapping_hash: _hash, ...report } = reportOf(imp);
    await ctx.tx
      .update(imports)
      .set({ status: "dry_run", isDryRun: true, runSeq, startedAt: ctx.now, finishedAt: null, counts: {}, report, updatedAt: ctx.now })
      .where(eq(imports.id, imp.id));
    const { id } = await ctx.enqueue({ kind: "import.parse", payload: { importId: imp.id, runSeq }, key: `import:${imp.id}:${runSeq}:parse` });
    await ctx.audit({ action: "import.dry_run_started", entityType: "import", entityId: imp.id, newValue: { runSeq, mappingHash: mappingHash(imp.mapping) } });
    return { jobId: id };
  },
);

// ---------------------------------------------------------------------------
// startImport
// ---------------------------------------------------------------------------

async function suppressionsReady(ctx: Ctx): Promise<boolean> {
  const [done] = await ctx.tx
    .select({ id: imports.id })
    .from(imports)
    .where(and(eq(imports.kind, "suppressions"), eq(imports.status, "done")))
    .limit(1);
  if (done) return true;
  const [item] = await ctx.tx
    .select({ doneAt: cutoverChecklistItems.doneAt, note: cutoverChecklistItems.note })
    .from(cutoverChecklistItems)
    .where(eq(cutoverChecklistItems.key, "suppressions_imported"));
  return !!item?.doneAt || item?.note === NO_SUPPRESSION_SOURCE;
}

/** The note stored on `suppressions_imported` when the user confirms there is no suppression source (rule 53). */
const NO_SUPPRESSION_SOURCE = "no_suppression_source";

async function sameFileAsDonePackages(ctx: Ctx, imp: ImportRecord): Promise<boolean> {
  const rows = await ctx.tx.execute(sql`
    select 1 from imports i
    join files f on f.id = i.file_id
    join files mine on mine.id = ${imp.fileId}::uuid
    where i.kind = 'packages' and i.status = 'done' and i.id <> ${imp.id}::uuid and f.sha256 = mine.sha256
    limit 1`);
  const list = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? []);
  return list.length > 0;
}

/** Rules 43a, 44, 44a, 53 and edge cases 7 and 29: the real run, after the dry run of the same mapping. */
export const startImport = action(
  { name: "ops.import_run", audience: "staff", permission: "persons.write", input: StartImportInput, audit: false },
  async (ctx, input): Promise<{ jobId: string }> => {
    ctx.require("settings.write");
    const userId = staffUserId(ctx);
    const imp = await lockedImport(ctx, input.importId);
    const report = reportOf(imp);
    if (imp.status === "dry_run") {
      const same = hasMapping(imp.mapping) && !!imp.finishedAt && !!report.dry_run && report.mapping_hash === mappingHash(imp.mapping);
      if (!same) throw new ConflictError("dry_run_first");
    } else if (imp.status === "failed") {
      if (report.failed_phase !== "run") throw new ConflictError("import_not_runnable");
    } else if (imp.status === "uploaded") {
      throw new ConflictError("dry_run_first");
    } else {
      throw new ConflictError("import_not_runnable");
    }
    if (!(await isGoLiveGateComplete(ctx.tx))) throw new ConflictError("go_live_gate");

    if ((NEEDS_SUPPRESSIONS_FIRST as readonly string[]).includes(imp.kind) && !(await suppressionsReady(ctx))) {
      if (!input.confirmNoSuppressionSource) throw new ConflictError("suppressions_first");
      await ctx.tx
        .insert(cutoverChecklistItems)
        .values({ key: "suppressions_imported", note: NO_SUPPRESSION_SOURCE, doneByUserId: userId })
        .onConflictDoUpdate({ target: cutoverChecklistItems.key, set: { note: NO_SUPPRESSION_SOURCE, doneByUserId: userId, updatedAt: ctx.now } });
    }
    if (imp.kind === "packages" && !input.confirmDifferentFile && (await sameFileAsDonePackages(ctx, imp))) throw new ConflictError("same_file");

    const runSeq = imp.runSeq + 1;
    const { error: _e, failed_phase: _p, partial: _x, ...kept } = report;
    try {
      await ctx.tx.transaction((sp) =>
        sp
          .update(imports)
          .set({ status: "running", isDryRun: false, runSeq, startedAt: ctx.now, finishedAt: null, report: kept, updatedAt: ctx.now })
          .where(eq(imports.id, imp.id)),
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError("another_running");
      throw error;
    }
    const first = imp.rowCount > 0;
    const { id } = await ctx.enqueue({
      kind: first ? "import.process_chunk" : "import.finalise",
      payload: first ? { importId: imp.id, runSeq, mode: "run", offset: 0 } : { importId: imp.id, runSeq, mode: "run" },
      key: first ? `import:${imp.id}:${runSeq}:run:chunk:0` : `import:${imp.id}:${runSeq}:run:finalise`,
    });
    await ctx.audit({
      action: "import.started",
      entityType: "import",
      entityId: imp.id,
      newValue: { runSeq, resumed: imp.status === "failed", confirmNoSuppressionSource: !!input.confirmNoSuppressionSource, confirmDifferentFile: !!input.confirmDifferentFile },
    });
    return { jobId: id };
  },
);

// ---------------------------------------------------------------------------
// cancelImport, signOffReconciliation
// ---------------------------------------------------------------------------

/** Rule 43a: running chunks see `cancelled` at their start and exit; imported rows stay ("partial"). */
export const cancelImport = action(
  { name: "ops.import_cancel", audience: "staff", permission: "persons.write", input: CancelImportInput, audit: false },
  async (ctx, input): Promise<{ ok: true }> => {
    const imp = await lockedImport(ctx, input.importId);
    if (imp.status !== "uploaded" && imp.status !== "dry_run" && imp.status !== "running") throw new ConflictError("import_final");
    const report: ImportReport = { ...reportOf(imp), ...(imp.status === "running" ? { partial: true } : {}) };
    await ctx.tx.update(imports).set({ status: "cancelled", report, finishedAt: ctx.now, updatedAt: ctx.now }).where(eq(imports.id, imp.id));
    await ctx.tx
      .update(files)
      .set({ expiresAt: new Date(ctx.now.getTime() + FILE_RETENTION_DAYS * 86_400_000) })
      .where(inArray(files.id, [imp.fileId, ...(imp.partFileIds ?? [])]));
    await ctx.audit({ action: "import.cancelled", entityType: "import", entityId: imp.id, oldValue: { status: imp.status }, newValue: { status: "cancelled", partial: imp.status === "running" } });
    return { ok: true };
  },
);

/** Rule 48: BEAM signs the reconciliation of a finished packages or memberships import off. */
export const signOffReconciliation = action(
  { name: "ops.import_sign_off", audience: "staff", permission: "settings.write", input: SignOffReconciliationInput, audit: false },
  async (ctx, input): Promise<{ ok: true }> => {
    const userId = staffUserId(ctx);
    const imp = await lockedImport(ctx, input.importId);
    if ((imp.kind !== "packages" && imp.kind !== "memberships") || imp.status !== "done" || !imp.reconciliation) throw new ConflictError("not_reconcilable");
    if (imp.signedOffAt) throw new ConflictError("already_signed_off");
    const reconciliation = { ...(imp.reconciliation as Reconciliation), signOffNote: input.note };
    await ctx.tx.update(imports).set({ signedOffByUserId: userId, signedOffAt: ctx.now, reconciliation, updatedAt: ctx.now }).where(eq(imports.id, imp.id));
    await autoTickCutover(ctx.tx, ctx.now);
    await ctx.audit({ action: "import.signed_off", entityType: "import", entityId: imp.id, newValue: { note: input.note } });
    return { ok: true };
  },
);

// ---------------------------------------------------------------------------
// setCutoverStep
// ---------------------------------------------------------------------------

/** Rule 53: only the manual steps are ticked by hand; the gate, import and stats steps tick themselves. */
export const setCutoverStep = action(
  { name: "ops.cutover_tick", audience: "staff", permission: "settings.write", input: SetCutoverStepInput, audit: false },
  async (ctx, input): Promise<{ ok: true }> => {
    const userId = staffUserId(ctx);
    if (!MANUAL_CUTOVER_STEPS.includes(input.key) || CUTOVER_RULES[input.key].mode !== "manual") throw new ConflictError("not_manual");
    const [before] = await ctx.tx
      .select({ doneAt: cutoverChecklistItems.doneAt, note: cutoverChecklistItems.note })
      .from(cutoverChecklistItems)
      .where(eq(cutoverChecklistItems.key, input.key))
      .for("update");
    const values = { doneAt: input.done ? ctx.now : null, doneByUserId: input.done ? userId : null, note: input.note ?? before?.note ?? null };
    await ctx.tx
      .insert(cutoverChecklistItems)
      .values({ key: input.key, ...values })
      .onConflictDoUpdate({ target: cutoverChecklistItems.key, set: { ...values, updatedAt: ctx.now } });
    await ctx.audit({
      action: "cutover.updated",
      entityType: "cutover_step",
      entityId: null,
      oldValue: { key: input.key, done: !!before?.doneAt, note: before?.note ?? null },
      newValue: { key: input.key, done: input.done, note: values.note },
    });
    return { ok: true };
  },
);
