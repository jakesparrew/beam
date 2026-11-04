/**
 * ops queries, area `imports`: data migration imports and the cut-over checklist (ops spec 4.2,
 * ops-P4): listImports, getImport, listImportRows, getCutoverChecklist. Server-only reads; the
 * pages call `requireStaff({ permission: 'persons.write' })` before them. Lists paginate at 50
 * rows and select named columns only.
 */
import type { DbOrTx } from "@beam/db";
import { cutoverChecklistItems, importRows, imports, jobs, users } from "@beam/db/schema";
import { CUTOVER_RULES, CUTOVER_STEPS, type CutoverKey, type CutoverStepRule, type ImportRowStatus } from "@beam/core/ops";
import { and, asc, count, desc, eq, inArray, max } from "drizzle-orm";
import { isGoLiveGateComplete } from "@/modules/platform/api";
import type { Reconciliation } from "./reconcile";
import type { ImportReport } from "./report";

export const IMPORTS_PAGE_SIZE = 50;

const page = (n: number | undefined) => Math.max(1, Math.floor(n ?? 1));

export type ImportListItem = {
  id: string;
  name: string;
  kind: (typeof imports.$inferSelect)["kind"];
  source: (typeof imports.$inferSelect)["source"];
  status: (typeof imports.$inferSelect)["status"];
  counts: Partial<Record<ImportRowStatus, number>>;
  rowCount: number;
  createdAt: Date;
  createdBy: string | null;
};

export async function listImports(db: DbOrTx, opts: { page?: number } = {}): Promise<{ items: ImportListItem[]; total: number; page: number; pageSize: number }> {
  const p = page(opts.page);
  const [rows, [totalRow]] = await Promise.all([
    db
      .select({
        id: imports.id,
        name: imports.name,
        kind: imports.kind,
        source: imports.source,
        status: imports.status,
        counts: imports.counts,
        rowCount: imports.rowCount,
        createdAt: imports.createdAt,
        createdBy: users.name,
      })
      .from(imports)
      .leftJoin(users, eq(users.id, imports.createdByUserId))
      .orderBy(desc(imports.createdAt), desc(imports.id))
      .limit(IMPORTS_PAGE_SIZE)
      .offset((p - 1) * IMPORTS_PAGE_SIZE),
    db.select({ n: count() }).from(imports),
  ]);
  return { items: rows, total: Number(totalRow?.n ?? 0), page: p, pageSize: IMPORTS_PAGE_SIZE };
}

export type ImportDetail = {
  id: string;
  name: string;
  kind: ImportListItem["kind"];
  source: ImportListItem["source"];
  status: ImportListItem["status"];
  header: string[];
  rowCount: number;
  mapping: (typeof imports.$inferSelect)["mapping"];
  isDryRun: boolean;
  runSeq: number;
  counts: Partial<Record<ImportRowStatus, number>>;
  report: ImportReport;
  reconciliation: Reconciliation | null;
  signedOffAt: Date | null;
  signedOffBy: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  fileId: string;
  partCount: number;
};

export async function getImport(db: DbOrTx, importId: string): Promise<ImportDetail | null> {
  if (!/^[0-9a-f-]{36}$/i.test(importId)) return null;
  const [row] = await db
    .select({
      id: imports.id,
      name: imports.name,
      kind: imports.kind,
      source: imports.source,
      status: imports.status,
      header: imports.header,
      rowCount: imports.rowCount,
      mapping: imports.mapping,
      isDryRun: imports.isDryRun,
      runSeq: imports.runSeq,
      counts: imports.counts,
      report: imports.report,
      reconciliation: imports.reconciliation,
      signedOffAt: imports.signedOffAt,
      signedOffBy: users.name,
      startedAt: imports.startedAt,
      finishedAt: imports.finishedAt,
      createdAt: imports.createdAt,
      fileId: imports.fileId,
      partFileIds: imports.partFileIds,
    })
    .from(imports)
    .leftJoin(users, eq(users.id, imports.signedOffByUserId))
    .where(eq(imports.id, importId));
  if (!row) return null;
  const { partFileIds, ...rest } = row;
  return { ...rest, report: (row.report ?? {}) as ImportReport, reconciliation: (row.reconciliation ?? null) as Reconciliation | null, partCount: 1 + (partFileIds?.length ?? 0) };
}

export type ImportRowItem = { rowNumber: number; status: ImportRowStatus; dryRunStatus: ImportRowStatus | null; message: string | null; entityType: string | null };

/** Rows of an import, filtered by real-run status (or dry-run status with `dry`). No row data: codes only. */
export async function listImportRows(
  db: DbOrTx,
  importId: string,
  opts: { status?: ImportRowStatus; dry?: boolean; page?: number } = {},
): Promise<{ items: ImportRowItem[]; page: number; pageSize: number }> {
  const p = page(opts.page);
  const statusCol = opts.dry ? importRows.dryRunStatus : importRows.status;
  const items = await db
    .select({ rowNumber: importRows.rowNumber, status: importRows.status, dryRunStatus: importRows.dryRunStatus, message: importRows.message, entityType: importRows.entityType })
    .from(importRows)
    .where(and(eq(importRows.importId, importId), ...(opts.status ? [eq(statusCol, opts.status)] : [])))
    .orderBy(asc(importRows.rowNumber))
    .limit(IMPORTS_PAGE_SIZE)
    .offset((p - 1) * IMPORTS_PAGE_SIZE);
  return { items, page: p, pageSize: IMPORTS_PAGE_SIZE };
}

export type CutoverStepView = {
  key: CutoverKey;
  rule: CutoverStepRule;
  done: boolean;
  doneAt: Date | null;
  doneBy: string | null;
  note: string | null;
  importId: string | null;
  manual: boolean;
};

/**
 * Rule 53: the 17 steps in order. The gate mirrors `isGoLiveGateComplete`; import steps read the
 * stored tick (set by `import.finalise` and the sign-off) or a matching `done` import; the stats
 * step is done when an `ops.refresh_person_stats` run finished after the last finished import.
 */
export async function getCutoverChecklist(db: DbOrTx): Promise<{ steps: CutoverStepView[]; done: number; total: number }> {
  const [stored, doneImports, [statsRun], [lastImport], gate] = await Promise.all([
    db
      .select({ key: cutoverChecklistItems.key, doneAt: cutoverChecklistItems.doneAt, note: cutoverChecklistItems.note, doneBy: users.name })
      .from(cutoverChecklistItems)
      .leftJoin(users, eq(users.id, cutoverChecklistItems.doneByUserId)),
    db
      .select({ id: imports.id, kind: imports.kind, finishedAt: imports.finishedAt, signedOffAt: imports.signedOffAt })
      .from(imports)
      .where(eq(imports.status, "done"))
      .orderBy(desc(imports.finishedAt)),
    db
      .select({ at: max(jobs.finishedAt) })
      .from(jobs)
      .where(and(eq(jobs.kind, "ops.refresh_person_stats"), eq(jobs.status, "succeeded"))),
    db
      .select({ at: max(imports.finishedAt) })
      .from(imports)
      .where(inArray(imports.status, ["done"])),
    isGoLiveGateComplete(db),
  ]);
  const byKey = new Map(stored.map((s) => [s.key, s]));
  const steps = CUTOVER_STEPS.map((key): CutoverStepView => {
    const rule = CUTOVER_RULES[key];
    const item = byKey.get(key);
    const base = { key, rule, doneAt: item?.doneAt ?? null, doneBy: item?.doneBy ?? null, note: item?.note ?? null, importId: null as string | null, manual: rule.mode === "manual" };
    switch (rule.mode) {
      case "gate":
        return { ...base, done: gate };
      case "stats": {
        const done = !!statsRun?.at && (!lastImport?.at || statsRun.at.getTime() > lastImport.at.getTime());
        return { ...base, done, doneAt: done ? statsRun!.at : null };
      }
      case "import": {
        const match = doneImports.find((i) => i.kind === rule.importKind && (!rule.needsSignOff || !!i.signedOffAt));
        return { ...base, done: !!item?.doneAt || !!match, importId: match?.id ?? null, doneAt: item?.doneAt ?? match?.finishedAt ?? null };
      }
      default:
        return { ...base, done: !!item?.doneAt };
    }
  });
  return { steps, done: steps.filter((s) => s.done).length, total: steps.length };
}
