/**
 * ops' cross-module door (ops spec 4.7, 02-data-model section 6.10): a barrel over the area
 * files `<area>/api.ts`, written once by ops-P1 so the later ops packages never edit it. Each
 * function keeps its final signature; until its area package lands it throws
 * `NotImplementedError('ops.<fn>')`. Other modules import only this file and `@beam/core/ops`.
 */
export type { DpiaKey, ModuleId, PrivacyKind, PrivacyStatus, RetentionReason } from "@beam/core/ops";
export { ERASE_ORDER } from "@beam/core/ops";

export * from "./stats/api";
export * from "./dashboard/api";
export * from "./reports/api";
export * from "./imports/api";
export * from "./exports/api";
export * from "./privacy/api";
export * from "./retention/api";
export * from "./marketing/api";
export * from "./insights/api";
export * from "./ai/api";
