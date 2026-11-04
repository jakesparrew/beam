/**
 * The import report (ops spec rule 44, ops-P4): rows per outcome, new versus matched persons, and
 * the row numbers of in-file duplicates, invalid emails, unknown products, suppressed consents,
 * erased addresses and over-capacity bookings. Row numbers and message codes only, never an
 * address or a name (webinar rule 3). `imports.report` keeps one report per mode plus the
 * mapping hash of the finished dry run (rule 44: a real run needs a dry run of the same mapping).
 */
import { createHash } from "node:crypto";
import type { DbOrTx } from "@beam/db";
import { importRows } from "@beam/db/schema";
import { IMPORT_ROW_STATUSES, type ImportMapping, type ImportRowStatus } from "@beam/core/ops";
import { asc, eq } from "@/lib/ctx";

/** At most this many row numbers per list (the CSV download has every row). */
export const REPORT_LIST_CAP = 500;

export type RunReport = {
  mode: "dry" | "run";
  rows: Record<ImportRowStatus, number>;
  total: number;
  new_persons: number;
  matched_persons: number;
  duplicates_in_file: number[];
  invalid_emails: number[];
  missing_emails: number[];
  unknown_products: number[];
  suppressed_skipped: number[];
  erased_skipped: number[];
  over_capacity: number[];
  errors: { row: number; code: string }[];
  error_codes: Record<string, number>;
};

/** `imports.report`: `ImportReport`. */
export type ImportReport = {
  mapping_hash?: string;
  /** The mapping hash the running dry run parsed with (set by `startDryRun`, copied into `mapping_hash` by the dry finalise). */
  dry_run_mapping_hash?: string;
  dry_run?: RunReport;
  run?: RunReport;
  error?: string;
  failed_phase?: "parse" | "dry" | "run";
  partial?: boolean;
};

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)]),
    );
  }
  return value;
}

/** sha256 of the mapping with sorted keys (rule 44 `report.mapping_hash`). */
export function mappingHash(mapping: ImportMapping | Record<string, never>): string {
  return createHash("sha256").update(JSON.stringify(canonical(mapping))).digest("hex");
}

const emptyCounts = (): Record<ImportRowStatus, number> => Object.fromEntries(IMPORT_ROW_STATUSES.map((s) => [s, 0])) as Record<ImportRowStatus, number>;

function push(list: number[], row: number): void {
  if (list.length < REPORT_LIST_CAP) list.push(row);
}

/** Counts per outcome of one mode (`status` for the real run, `dry_run_status` for the dry run). */
export async function countRows(tx: DbOrTx, importId: string, mode: "dry" | "run"): Promise<Record<ImportRowStatus, number>> {
  const rows = await tx
    .select({ status: mode === "dry" ? importRows.dryRunStatus : importRows.status })
    .from(importRows)
    .where(eq(importRows.importId, importId));
  const counts = emptyCounts();
  for (const r of rows) counts[r.status ?? "pending"] += 1;
  return counts;
}

/** Builds the report of one mode from `import_rows`. */
export async function buildRunReport(tx: DbOrTx, importId: string, mode: "dry" | "run"): Promise<RunReport> {
  const rows = await tx
    .select({ rowNumber: importRows.rowNumber, status: importRows.status, dryRunStatus: importRows.dryRunStatus, message: importRows.message, entityType: importRows.entityType })
    .from(importRows)
    .where(eq(importRows.importId, importId))
    .orderBy(asc(importRows.rowNumber));
  const report: RunReport = {
    mode,
    rows: emptyCounts(),
    total: rows.length,
    new_persons: 0,
    matched_persons: 0,
    duplicates_in_file: [],
    invalid_emails: [],
    missing_emails: [],
    unknown_products: [],
    suppressed_skipped: [],
    erased_skipped: [],
    over_capacity: [],
    errors: [],
    error_codes: {},
  };
  for (const r of rows) {
    const status: ImportRowStatus = (mode === "dry" ? r.dryRunStatus : r.status) ?? "pending";
    report.rows[status] += 1;
    const message = r.message ?? "";
    if (r.entityType === "person" && status === "imported") report.new_persons += 1;
    if (r.entityType === "person" && status === "updated") report.matched_persons += 1;
    if (message === "duplicate_in_file") push(report.duplicates_in_file, r.rowNumber);
    if (message === "invalid_email") push(report.invalid_emails, r.rowNumber);
    if (message === "missing_email") push(report.missing_emails, r.rowNumber);
    if (message === "unknown_product") push(report.unknown_products, r.rowNumber);
    if (message === "suppressed") push(report.suppressed_skipped, r.rowNumber);
    if (message === "erased") push(report.erased_skipped, r.rowNumber);
    if (message === "over_capacity") push(report.over_capacity, r.rowNumber);
    if (status === "error") {
      report.error_codes[message || "error"] = (report.error_codes[message || "error"] ?? 0) + 1;
      if (report.errors.length < REPORT_LIST_CAP) report.errors.push({ row: r.rowNumber, code: message || "error" });
    }
  }
  return report;
}
