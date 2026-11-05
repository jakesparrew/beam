/**
 * `@beam/core/ops`: the pure parts of the ops module (ops spec 4.7): stage and inactivity
 * rules, retention scores, report periods, business days, the profile, import, export,
 * cut-over, privacy and DPIA catalogues, action inputs, the streaming CSV and zip writers, the
 * predictions and the KPI catalogue of custom dashboards (ops-P9), and the ai schema description
 * and the AI SQL validator (ops-P10).
 */
export * from "./types";
export * from "./retention-defaults";
export * from "./stage";
export * from "./inactivity";
export * from "./retention-score";
export type { RetentionReason } from "./retention-score";
export * from "./periods";
export * from "./business-days";
export * from "./profile-fields";
export * from "./import-targets";
export * from "./import-presets";
export * from "./export-entities";
export * from "./cutover";
export {
  ERASE_EXTERNAL_PROVIDERS,
  FIRST_ERASE_MODULE,
  PRIVACY_EXTERNAL_OUTCOMES,
  PRIVACY_REPORT_PROVIDERS,
  PRIVACY_STEP_ACTIONS,
  nextEraseModule,
  type EraseExternalProvider,
  type PrivacyExternalOutcome,
  type PrivacyReport,
  type PrivacyReportProvider,
  type PrivacyStepAction,
} from "./privacy-order";
export * from "./privacy-notice";
export * from "./dpia";
export * from "./schemas";
export * from "./csv";
export * from "./zip";
export * from "./predict";
export * from "./kpis";
export * from "./ai-schema-doc";
export * from "./validate-ai-sql";
