/**
 * ops cross-module api, area `exports` (ops spec 4.7, rule 70): the DPIA check, implemented by
 * ops-P6 with the signature of platform-P5's forward stub. Forms (publishing a version with
 * sensitive fields), platform (PL-55, the sensitive-AI switch), automation (journeys with
 * `requires_dpia`) and webinar (watch-time segment fields) call it.
 */
import type { DbOrTx } from "@beam/db";
import type { DpiaKey } from "@beam/core/ops";
import { dpiaApproved } from "./dpia";

/** True when `dpia_records.status` of `key` is `approved` or `not_required`. Platform PL-55 passes 'sensitive_assessment_processing'. */
export function isDpiaApproved(db: DbOrTx, key: DpiaKey): Promise<boolean> {
  return dpiaApproved(db, key);
}
