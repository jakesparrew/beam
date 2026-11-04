/**
 * `privacy_requests.report` (ops rules 62-64): module, table, row counts, actions, legal bases and
 * provider outcomes, never a personal value. Pure helpers shared by the orchestrator, the external
 * steps and the finalise job.
 *
 * - `mergeSteps` keeps the latest count per `(module, table)`: a rerun (rule 59a, `run_attempt`
 *   incremented) replaces what the earlier attempt recorded for the same table.
 * - `setExternal` keeps one outcome per provider.
 * - `retainedOf` lists what stays for a legal reason: the accounting tables a module kept or
 *   anonymised, `privacy_requests` (accountability) and `suppressions` (the erased hash).
 */
import type { EraseReportRow } from "@beam/core/privacy";
import type { ModuleId, PrivacyExternalOutcome, PrivacyReport, PrivacyReportProvider, PrivacyStepAction } from "@beam/core/ops";

export type ReportStep = PrivacyReport["steps"][number];
export type ReportExternal = PrivacyReport["external"][number];

/** Payment providers recorded as `provider_retains` when the person has payments with them (rule 63). */
export const PAYMENT_PROVIDERS = ["mollie", "stripe", "viva"] as const;

/** Tables kept (or kept anonymised) for a legal obligation, with the basis shown in the report. */
export const LEGAL_BASIS_BY_TABLE: Readonly<Record<string, string>> = {
  invoices: "accounting_law",
  invoice_lines: "accounting_law",
  credit_notes: "accounting_law",
  orders: "accounting_law",
  order_lines: "accounting_law",
  payments: "accounting_law",
  refunds: "accounting_law",
  credit_entries: "accounting_law",
  terms_acceptances: "contract",
  privacy_requests: "accountability",
  suppressions: "suppression",
};

/** Always listed under `retained`: the proof of the request and the opt-out fingerprint. */
const ALWAYS_RETAINED = ["privacy_requests", "suppressions"] as const;

export function emptyReport(): PrivacyReport {
  return { steps: [], external: [], retained: [] };
}

/** Reads a stored report (`{}` before the first run). */
export function reportOf(value: unknown): PrivacyReport {
  const r = (value ?? {}) as Partial<PrivacyReport>;
  return {
    steps: Array.isArray(r.steps) ? [...r.steps] : [],
    external: Array.isArray(r.external) ? [...r.external] : [],
    retained: Array.isArray(r.retained) ? [...r.retained] : [],
    ...(r.startedAt ? { startedAt: r.startedAt } : {}),
    ...(r.finishedAt ? { finishedAt: r.finishedAt } : {}),
  };
}

/** Maps a registry action (`EraseAction`) to the report's vocabulary. */
export function reportAction(table: string, action: string): PrivacyStepAction | (string & {}) {
  switch (action) {
    case "deleted":
      return "deleted";
    case "anonymised":
    case "redacted":
    case "unlinked":
      return LEGAL_BASIS_BY_TABLE[table] ? "retained_legal" : "anonymised";
    case "kept":
    case "retained_legal":
      return LEGAL_BASIS_BY_TABLE[table] ? "retained_legal" : "kept";
    case "none":
      return "kept";
    default:
      return action;
  }
}

/** The report rows of one module step (counts only). */
export function stepsOf(module: ModuleId, rows: readonly EraseReportRow[]): ReportStep[] {
  return rows.map((r) => ({ module, table: r.table, rows: Math.max(0, Math.trunc(Number(r.rows) || 0)), action: reportAction(r.table, r.action) }));
}

/** Replaces the earlier entries of the same `(module, table)` with the new ones, keeping the order. */
export function mergeSteps(existing: readonly ReportStep[], next: readonly ReportStep[]): ReportStep[] {
  const key = (s: ReportStep) => `${s.module}:${s.table}`;
  const incoming = new Map(next.map((s) => [key(s), s]));
  const out = existing.map((s) => incoming.get(key(s)) ?? s);
  const seen = new Set(existing.map(key));
  for (const s of next) if (!seen.has(key(s))) out.push(s);
  return out;
}

export function setExternal(existing: readonly ReportExternal[], provider: PrivacyReportProvider, outcome: PrivacyExternalOutcome): ReportExternal[] {
  return [...existing.filter((e) => e.provider !== provider), { provider, outcome }];
}

/** The legal-basis list of the report from its steps. */
export function retainedOf(steps: readonly ReportStep[]): PrivacyReport["retained"] {
  const tables = new Set<string>(ALWAYS_RETAINED);
  for (const s of steps) {
    if (LEGAL_BASIS_BY_TABLE[s.table] && s.rows > 0 && s.action !== "deleted") tables.add(s.table);
  }
  return [...tables].sort().map((table) => ({ table, legal_basis: LEGAL_BASIS_BY_TABLE[table]! }));
}

/** `new_value` of the `privacy.erased` audit row (rule 64): totals and module names only. */
export function erasedAuditValue(report: PrivacyReport): { rows_total: number; modules: string[] } {
  const modules = [...new Set(report.steps.map((s) => s.module))];
  return { rows_total: report.steps.reduce((n, s) => n + s.rows, 0), modules };
}

/** True when the request needs a person to follow up by hand (an external step recorded `failed`). */
export const hasFailedExternal = (report: PrivacyReport): boolean => report.external.some((e) => e.outcome === "failed");
