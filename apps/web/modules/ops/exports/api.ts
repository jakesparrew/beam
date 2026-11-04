/**
 * ops cross-module api, area `exports` (ops spec 4.7, rule 70): the DPIA check. Typed stub by
 * ops-P1 (platform-P5's forward stub, moved here unchanged); throws
 * `NotImplementedError('ops.isDpiaApproved')` until ops-P6 implements it here.
 */
import type { DbOrTx } from "@beam/db";
import { NotImplementedError } from "@beam/core/errors";
import type { DpiaKey } from "@beam/core/ops";

/** True when `dpia_records.status` of `key` is `approved` or `not_required`. Platform PL-55 passes 'sensitive_assessment_processing'. */
export function isDpiaApproved(db: DbOrTx, key: DpiaKey): Promise<boolean> {
  void db;
  void key;
  return Promise.reject(new NotImplementedError("ops.isDpiaApproved"));
}
