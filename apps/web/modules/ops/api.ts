/**
 * ops' cross-module door. Forward stub written by platform-P5 (runbook DR-10): platform's
 * sensitive-AI switch (PL-55) calls `isDpiaApproved`. platform-P7 rewrites this file with the
 * full stub set and keeps this export unchanged; ops implements it.
 */
import type { DbOrTx } from "@beam/db";
import { NotImplementedError } from "@beam/core/errors";

/** Values of ops' `dpia_records_key` enum (cross-module D38). */
export type DpiaKey =
  | "sensitive_assessment_processing"
  | "behavioural_scoring"
  | "ai_customer_ranking"
  | "watch_time_profiling"
  | "b2b_prospecting"
  | "voice_ai";

export function isDpiaApproved(db: DbOrTx, key: DpiaKey): Promise<boolean> {
  void db;
  void key;
  return Promise.reject(new NotImplementedError("ops.isDpiaApproved"));
}
