/**
 * ops cross-module api, area `privacy` (ops spec 4.7). Typed stubs by ops-P1 with the final
 * signatures; each throws `NotImplementedError('ops.<fn>')` until ops-P5 implements it here.
 */
import type { DbOrTx } from "@beam/db";
import { NotImplementedError } from "@beam/core/errors";
import type { PrivacyKind, PrivacyStatus } from "@beam/core/ops";
import type { Ctx } from "@/lib/ctx";

const notYet = <T>(fn: string): Promise<T> => Promise.reject(new NotImplementedError(`ops.${fn}`));

/** Reads only `persons.processing_restricted_at` (decision 66). */
export function isProcessingRestricted(_db: DbOrTx, _personId: string): Promise<boolean> {
  return notYet("isProcessingRestricted");
}

/** Creates a privacy request (rule 59; system requests from the retention sweep are verified at once). */
export function createPrivacyRequest(
  _ctx: Ctx,
  _input: { personId: string; kind: PrivacyKind; requestedBy: "customer" | "staff" | "system"; verificationNote?: string },
): Promise<{ requestId: string }> {
  return notYet("createPrivacyRequest");
}

/** The person's requests in `received`, `verified` or `running`. */
export function getOpenPrivacyRequests(_db: DbOrTx, _personId: string): Promise<{ id: string; kind: PrivacyKind; status: PrivacyStatus; dueOn: string }[]> {
  return notYet("getOpenPrivacyRequests");
}
