/**
 * ops queries, area `exports` (ops spec 4.2, ops-P6): listExports, getExportForDownload,
 * listRetentionPolicies, listDpiaRecords. Server-only reads; the pages call
 * `requireStaff({ permission })` before them. Lists paginate at 50 rows and select named columns.
 */
import type { DbOrTx } from "@beam/db";
import { dataExports, dpiaRecords, files, retentionPolicies, users } from "@beam/db/schema";
import { DPIA_KEYS, type DpiaKey, type DpiaStatus } from "@beam/core/ops";
import { AI_FEATURES } from "@beam/core/ai";
import { asc, count, desc, eq, inArray } from "drizzle-orm";
import { listDpiaGates } from "./dpia";
import { resolveSweepHandler, type ExportCursor } from "./jobs";

export const EXPORTS_PAGE_SIZE = 50;

export type ExportListItem = {
  id: string;
  kind: (typeof dataExports.$inferSelect)["kind"];
  entity: string | null;
  status: (typeof dataExports.$inferSelect)["status"];
  rowCount: number;
  createdAt: Date;
  createdByUserId: string;
  createdBy: string | null;
  expiresAt: Date | null;
};

export async function listExports(db: DbOrTx, opts: { page?: number } = {}): Promise<{ items: ExportListItem[]; total: number; page: number; pageSize: number }> {
  const p = Math.max(1, Math.floor(opts.page ?? 1));
  const [items, [total]] = await Promise.all([
    db
      .select({
        id: dataExports.id,
        kind: dataExports.kind,
        entity: dataExports.entity,
        status: dataExports.status,
        rowCount: dataExports.rowCount,
        createdAt: dataExports.createdAt,
        createdByUserId: dataExports.createdByUserId,
        createdBy: users.name,
        expiresAt: dataExports.expiresAt,
      })
      .from(dataExports)
      .leftJoin(users, eq(users.id, dataExports.createdByUserId))
      .orderBy(desc(dataExports.createdAt), desc(dataExports.id))
      .limit(EXPORTS_PAGE_SIZE)
      .offset((p - 1) * EXPORTS_PAGE_SIZE),
    db.select({ n: count() }).from(dataExports),
  ]);
  return { items, total: Number(total?.n ?? 0), page: p, pageSize: EXPORTS_PAGE_SIZE };
}

export type DownloadableExport = {
  id: string;
  kind: ExportListItem["kind"];
  entity: string | null;
  createdByUserId: string;
  rowCount: number;
  parts: { name: string; fileId: string }[];
};

/**
 * The export and its parts when it can be downloaded: status `done` and `expires_at` in the
 * future. `failed`, `expired`, running and past-expiry exports give `null`.
 */
export async function getExportForDownload(db: DbOrTx, exportId: string, now: Date = new Date()): Promise<DownloadableExport | null> {
  const [row] = await db
    .select({
      id: dataExports.id,
      kind: dataExports.kind,
      entity: dataExports.entity,
      status: dataExports.status,
      createdByUserId: dataExports.createdByUserId,
      rowCount: dataExports.rowCount,
      expiresAt: dataExports.expiresAt,
      cursor: dataExports.cursor,
    })
    .from(dataExports)
    .where(eq(dataExports.id, exportId));
  if (!row || row.status !== "done" || !row.expiresAt || row.expiresAt <= now) return null;
  const parts = ((row.cursor ?? {}) as Partial<ExportCursor>).parts ?? [];
  return { id: row.id, kind: row.kind, entity: row.entity, createdByUserId: row.createdByUserId, rowCount: row.rowCount, parts: parts.map((p) => ({ name: p.name, fileId: p.fileId })) };
}

/** Bytes of the export's part files, in order (unknown or expired files are skipped). */
export async function readExportPart(db: DbOrTx, fileId: string): Promise<Uint8Array | null> {
  const [file] = await db.select({ bytes: files.bytes, expiresAt: files.expiresAt }).from(files).where(eq(files.id, fileId));
  if (!file || (file.expiresAt && file.expiresAt <= new Date())) return null;
  return file.bytes;
}

export type RetentionPolicyItem = {
  key: string;
  tableName: string;
  days: number | null;
  action: (typeof retentionPolicies.$inferSelect)["action"];
  description: string;
  runOrder: number;
  isActive: boolean;
  lastRunAt: Date | null;
  lastRunRows: number | null;
  lastRunStatus: string | null;
  handler: "module" | "generic" | "none" | "keep";
};

/** Every policy by `run_order` (about 60 rows, one page), with how the sweep would run it. */
export async function listRetentionPolicies(db: DbOrTx): Promise<RetentionPolicyItem[]> {
  const rows = await db
    .select({
      key: retentionPolicies.key,
      tableName: retentionPolicies.tableName,
      days: retentionPolicies.days,
      action: retentionPolicies.action,
      description: retentionPolicies.description,
      runOrder: retentionPolicies.runOrder,
      isActive: retentionPolicies.isActive,
      lastRunAt: retentionPolicies.lastRunAt,
      lastRunRows: retentionPolicies.lastRunRows,
      lastRunStatus: retentionPolicies.lastRunStatus,
    })
    .from(retentionPolicies)
    .orderBy(asc(retentionPolicies.runOrder), asc(retentionPolicies.key))
    .limit(500);
  return rows.map((r) => ({ ...r, handler: r.action === "keep" ? "keep" : resolveSweepHandler(r).kind }));
}

export type DpiaRecordItem = {
  key: DpiaKey;
  status: DpiaStatus;
  purpose: string | null;
  risks: string | null;
  measures: string | null;
  decisionNote: string | null;
  documentFileId: string | null;
  documentName: string | null;
  reviewedAt: Date | null;
  reviewedBy: string | null;
  gates: string[];
};

/** The six DPIA records (a missing row shows as `not_started`) with what each gates. */
export async function listDpiaRecords(db: DbOrTx): Promise<DpiaRecordItem[]> {
  const rows = await db
    .select({
      key: dpiaRecords.key,
      status: dpiaRecords.status,
      purpose: dpiaRecords.purpose,
      risks: dpiaRecords.risks,
      measures: dpiaRecords.measures,
      decisionNote: dpiaRecords.decisionNote,
      documentFileId: dpiaRecords.documentFileId,
      reviewedAt: dpiaRecords.reviewedAt,
      reviewedBy: users.name,
    })
    .from(dpiaRecords)
    .leftJoin(users, eq(users.id, dpiaRecords.reviewedByUserId));
  const fileIds = rows.map((r) => r.documentFileId).filter((v): v is string => !!v);
  const names = fileIds.length ? await db.select({ id: files.id, name: files.name }).from(files).where(inArray(files.id, fileIds)) : [];
  const gates = await listDpiaGates(db);
  return DPIA_KEYS.map((key) => {
    const r = rows.find((x) => x.key === key);
    return {
      key,
      status: r?.status ?? "not_started",
      purpose: r?.purpose ?? null,
      risks: r?.risks ?? null,
      measures: r?.measures ?? null,
      decisionNote: r?.decisionNote ?? null,
      documentFileId: r?.documentFileId ?? null,
      documentName: names.find((n) => n.id === r?.documentFileId)?.name ?? null,
      reviewedAt: r?.reviewedAt ?? null,
      reviewedBy: r?.reviewedBy ?? null,
      gates: gates[key],
    };
  });
}

/** Blueprint 61 documentation per AI feature, read from platform's register (no second copy). */
export function listAiFeatureDocs(): { key: string; module: string; purpose: string; model: string; allowedFields: readonly string[]; when: string; location: string; retention: string; trainingStatus: string; outputStorage: string }[] {
  return Object.entries(AI_FEATURES).map(([key, f]) => ({
    key,
    module: f.module,
    purpose: f.purpose,
    model: f.model,
    allowedFields: f.allowedFields,
    when: f.when,
    location: f.location,
    retention: f.retention,
    trainingStatus: f.trainingStatus,
    outputStorage: f.outputStorage,
  }));
}
