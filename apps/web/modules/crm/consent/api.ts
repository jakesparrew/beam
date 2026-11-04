/**
 * Consent and suppression api (crm spec 4.8), implemented by crm-P3. crm-P1 stub with the final
 * signatures. `addSuppression` is the only writer of `suppressions` (cross-module D8).
 */
import type { DbOrTx, Tx } from "@beam/db";
import { NotImplementedError } from "@beam/core/errors";
import type { Locale } from "@beam/core/i18n";
import type { ConsentMethod, ConsentOutcome, ConsentPurpose, ConsentState, MarketingPurpose, SuppressionReason, SuppressionScope } from "@beam/core/crm";
import type { EventCtx } from "../api";

const notYet = <T>(fn: string): Promise<T> => Promise.reject(new NotImplementedError(`crm.${fn}`));

export function recordConsent(
  _tx: Tx,
  _ctx: EventCtx,
  _input: {
    personId: string;
    purpose: ConsentPurpose;
    status: "granted" | "withdrawn";
    method: ConsentMethod;
    source: string;
    wordingVersion: string;
    lawfulBasis?: "consent" | "legitimate_interest";
    ip?: string;
    userAgent?: string;
    recordedAt?: Date;
    ref?: { type: string; id: string };
  },
): Promise<{ recordId: string | null; outcome: ConsentOutcome }> {
  return notYet("recordConsent");
}

export function getCurrentConsents(_tx: DbOrTx, _personId: string): Promise<Record<ConsentPurpose, ConsentState | null>> {
  return notYet("getCurrentConsents");
}

/** Also calls `automation.requestSuppressionExit`; reason `complaint` withdraws every granted marketing purpose (rule 3.18). */
export function addSuppression(
  _tx: Tx,
  _ctx: EventCtx,
  _input: { email: string; scope: SuppressionScope; reason: SuppressionReason; source: string; personId?: string },
): Promise<{ suppressionId: string; created: boolean }> {
  return notYet("addSuppression");
}

export function unsubscribe(
  _tx: Tx,
  _ctx: EventCtx,
  _input: { personId: string; purpose: MarketingPurpose | "all"; method: ConsentMethod; source: string },
): Promise<{ suppressionId: string }> {
  return notYet("unsubscribe");
}

export function isSuppressed(_tx: DbOrTx, _email: string, _purpose: MarketingPurpose): Promise<boolean> {
  return notYet("isSuppressed");
}

/** Pure; email passes the message's link token. */
export function buildPreferenceUrls(_linkToken: string, _locale: Locale): { unsubscribeUrl: string; oneClickPostUrl: string; preferencesUrl: string } {
  throw new NotImplementedError("crm.buildPreferenceUrls");
}
