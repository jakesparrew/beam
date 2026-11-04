/**
 * Erasure order (ops rule 62). External propagation first (`privacy.erase_external`, while the
 * address is still known), then one module handler per transaction in `ERASE_ORDER`
 * (`ERASE_ORDER` itself is declared in `types.ts`, the Wave 0 contract, and re-exported here):
 * crm anonymises `persons` second to last and platform redacts `audit_log` last.
 */
import { ERASE_ORDER, type ModuleId } from "./types";

export { ERASE_ORDER };

/** The three providers of `privacy.erase_external`, each its own job (cross-module D35). */
export const ERASE_EXTERNAL_PROVIDERS = ["billit", "mandates", "resend"] as const;
export type EraseExternalProvider = (typeof ERASE_EXTERNAL_PROVIDERS)[number];

/** Providers in a `PrivacyReport.external` entry (rule 63). */
export const PRIVACY_REPORT_PROVIDERS = ["billit", "mandates", "resend", "mollie", "stripe", "viva", "anthropic"] as const;
export type PrivacyReportProvider = (typeof PRIVACY_REPORT_PROVIDERS)[number];

export const PRIVACY_EXTERNAL_OUTCOMES = ["done", "not_found", "failed", "provider_retains"] as const;
export type PrivacyExternalOutcome = (typeof PRIVACY_EXTERNAL_OUTCOMES)[number];

export const PRIVACY_STEP_ACTIONS = ["deleted", "anonymised", "retained_legal", "kept"] as const;
export type PrivacyStepAction = (typeof PRIVACY_STEP_ACTIONS)[number];

/** `privacy_requests.report` (never personal data). */
export type PrivacyReport = {
  steps: { module: ModuleId; table: string; rows: number; action: PrivacyStepAction | (string & {}) }[];
  external: { provider: PrivacyReportProvider; outcome: PrivacyExternalOutcome }[];
  retained: { table: string; legal_basis: string }[];
  startedAt?: string;
  finishedAt?: string;
};

/** The module whose erase step runs after `module`, or null after the last one (`platform`). */
export function nextEraseModule(module: ModuleId): ModuleId | null {
  const i = ERASE_ORDER.indexOf(module);
  if (i === -1) throw new RangeError(`unknown module ${module}`);
  return ERASE_ORDER[i + 1] ?? null;
}

/** The first module step, run once all external providers are recorded. */
export const FIRST_ERASE_MODULE: ModuleId = ERASE_ORDER[0] as ModuleId;
