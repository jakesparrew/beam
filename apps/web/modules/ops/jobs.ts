/**
 * ops jobs (ops spec 4.4, data model 5.2). Facade read by `pnpm gen:indexes`: every `kind` is a
 * literal. Written once by ops-P1 with every job kind of V1 to R4; the handlers live in the area
 * files `<area>/jobs.ts`, which the later ops packages implement (stats P2, imports P4, privacy
 * P5, exports P6, retention P7, marketing P8, ai P10) without editing this file. R2-R4 handlers
 * return early while their release flag is off.
 */
import { defineJob } from "@/lib/job-runner";
import { AnswerQuestionInput, WeeklySummaryCollectInput, WeeklySummaryInput, runAnswerQuestion, runWeeklySummary, runWeeklySummaryCollect } from "./ai/jobs";
import { ExportChunkInput, ExportFinaliseInput, RetentionSweepInput, runExportChunk, runExportFinalise, runRetentionSweep } from "./exports/jobs";
import { ImportFinaliseInput, ImportParseInput, ImportProcessChunkInput, runImportFinalise, runImportParse, runImportProcessChunk } from "./imports/jobs";
import { AdsBackfillInput, AdsPullYesterdayInput, ComputeAttributionInput, runAdsBackfill, runAdsPullYesterday, runComputeAttribution } from "./marketing/jobs";
import {
  PrivacyEraseExternalInput,
  PrivacyEraseInput,
  PrivacyEraseStepInput,
  PrivacyExportInput,
  PrivacyFinaliseInput,
  runPrivacyErase,
  runPrivacyEraseExternal,
  runPrivacyEraseStep,
  runPrivacyExport,
  runPrivacyFinalise,
} from "./privacy/jobs";
import { BuildWeeklyRetentionListInput, runBuildWeeklyRetentionList } from "./retention/jobs";
import {
  DailyDigestInput,
  RefreshPersonInput,
  RefreshPersonStatsInput,
  RefreshRecentStatsInput,
  runDailyDigest,
  runRefreshPerson,
  runRefreshPersonStats,
  runRefreshRecentStats,
} from "./stats/jobs";

export const jobs = [
  // stats (ops-P2)
  defineJob({ kind: "ops.refresh_person_stats", lane: "bulk", priority: 9, input: RefreshPersonStatsInput, timeoutMs: 120_000, run: runRefreshPersonStats }),
  defineJob({ kind: "ops.refresh_recent_stats", lane: "bulk", priority: 5, input: RefreshRecentStatsInput, maxAttempts: 3, run: runRefreshRecentStats }),
  defineJob({ kind: "ops.refresh_person", lane: "fast", priority: 5, input: RefreshPersonInput, run: runRefreshPerson }),
  defineJob({ kind: "ops.daily_digest", lane: "fast", priority: 5, input: DailyDigestInput, run: runDailyDigest }),
  // retention (ops-P7, R2)
  defineJob({ kind: "ops.build_weekly_retention_list", lane: "bulk", priority: 5, input: BuildWeeklyRetentionListInput, run: runBuildWeeklyRetentionList }),
  // imports (ops-P4)
  defineJob({ kind: "import.parse", lane: "bulk", priority: 5, input: ImportParseInput, timeoutMs: 120_000, run: runImportParse }),
  defineJob({ kind: "import.process_chunk", lane: "bulk", priority: 9, input: ImportProcessChunkInput, maxAttempts: 6, timeoutMs: 120_000, run: runImportProcessChunk }),
  defineJob({ kind: "import.finalise", lane: "bulk", priority: 5, input: ImportFinaliseInput, run: runImportFinalise }),
  // exports and the retention sweep (ops-P6)
  defineJob({ kind: "ops.export_chunk", lane: "bulk", priority: 9, input: ExportChunkInput, timeoutMs: 120_000, run: runExportChunk }),
  defineJob({ kind: "ops.export_finalise", lane: "bulk", priority: 5, input: ExportFinaliseInput, run: runExportFinalise }),
  defineJob({ kind: "privacy.retention_sweep", lane: "bulk", priority: 9, input: RetentionSweepInput, timeoutMs: 120_000, run: runRetentionSweep }),
  // privacy requests (ops-P5)
  defineJob({ kind: "privacy.export", lane: "bulk", priority: 5, input: PrivacyExportInput, timeoutMs: 120_000, run: runPrivacyExport }),
  defineJob({ kind: "privacy.erase", lane: "fast", priority: 1, input: PrivacyEraseInput, run: runPrivacyErase }),
  defineJob({ kind: "privacy.erase_external", lane: "fast", priority: 1, input: PrivacyEraseExternalInput, run: runPrivacyEraseExternal }),
  defineJob({ kind: "privacy.erase_step", lane: "fast", priority: 1, input: PrivacyEraseStepInput, run: runPrivacyEraseStep }),
  defineJob({ kind: "privacy.finalise", lane: "fast", priority: 1, input: PrivacyFinaliseInput, run: runPrivacyFinalise }),
  // ads and attribution (ops-P8, R3)
  defineJob({ kind: "ads.pull_yesterday", lane: "bulk", priority: 5, input: AdsPullYesterdayInput, run: runAdsPullYesterday }),
  defineJob({ kind: "ads.backfill", lane: "bulk", priority: 9, input: AdsBackfillInput, run: runAdsBackfill }),
  defineJob({ kind: "ops.compute_attribution", lane: "bulk", priority: 9, input: ComputeAttributionInput, timeoutMs: 120_000, run: runComputeAttribution }),
  // AI (ops-P10, R4)
  defineJob({ kind: "ai.weekly_summary", lane: "bulk", priority: 5, input: WeeklySummaryInput, run: runWeeklySummary }),
  defineJob({ kind: "ai.weekly_summary_collect", lane: "bulk", priority: 5, input: WeeklySummaryCollectInput, maxAttempts: 3, run: runWeeklySummaryCollect }),
  defineJob({ kind: "ai.answer_question", lane: "fast", priority: 1, input: AnswerQuestionInput, inline: true, timeoutMs: 20_000, maxAttempts: 1, run: runAnswerQuestion }),
];
