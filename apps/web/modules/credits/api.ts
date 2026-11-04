/**
 * credits' cross-module door (02-data-model section 6.5, credits spec section 4). Every function
 * another module calls, with its final signature. credits-P3 implements the ledger functions
 * (`consumeCredits`, `releaseCredits`, `checkCredits`, `grantCredits`, `getGrantUsage`,
 * `revokeGrantRemainder`, `getEuroBalance`, `importGrant`, `getPersonCreditSummary`,
 * `getCreditLiabilityAsOf`) on `server/ledger.ts`; credits-P4 the membership functions
 * (`activateMembership`, `applyRenewalPayment`, `applyRenewalFailure`, `cancelMembershipForRefund`,
 * `getMembershipForPerson`, `getMembershipSummary`, `canStartMembership`, `importMembership`) on
 * `server/memberships.ts`; the others still throw `NotImplementedError('credits.<fn>')` until the
 * package that lands them (P5 merge, P8 sharing review). The three R3 referral hooks that V1 code calls at runtime return `null` or
 * nothing until credits-P9. Every write function runs in the caller's transaction.
 */
import type { DbOrTx, Tx } from "@beam/db";
import { NotImplementedError } from "@beam/core/errors";
import type { LocalizedText } from "@beam/core/i18n";
import type { AllocationResult, CreditKind, ReleaseReason, SharingReviewRow } from "@beam/core/credits";
import type { Ctx } from "@/lib/ctx";
import * as ledger from "./server/ledger";
import * as membershipService from "./server/memberships";

export type { AllocationResult, CreditKind, GrantSharing, ReleaseReason } from "@beam/core/credits";
export { InsufficientCreditsError, SharingNotAllowedError, type GrantCreditsInput } from "./server/ledger";

const notYet = <T>(fn: string): Promise<T> => Promise.reject(new NotImplementedError(`credits.${fn}`));

// booking and commerce ------------------------------------------------------------------

/**
 * booking (kind day | night, ref booking, `validAt` = session start) and commerce (kind euro, ref
 * order, `personId = beneficiaryPersonId` = the buyer). Throws `InsufficientCreditsError` or
 * `SharingNotAllowedError` (both `conflict`); a retried ref returns its existing entries.
 */
export function consumeCredits(
  tx: Tx,
  ctx: Ctx,
  input: { personId: string; beneficiaryPersonId: string; kind: CreditKind; units: number; ref: { type: "booking" | "order"; id: string }; validAt?: Date },
): Promise<{ entries: { entryId: string; grantId: string; quantity: number }[]; remainingUnits: number }> {
  return ledger.consumeCredits(tx, ctx, input);
}

/** Gives back every unreleased consume of a booking or order (rules 20, 24 to 26). */
export function releaseCredits(
  tx: Tx,
  ctx: Ctx,
  input: { ref: { type: "booking" | "order"; id: string }; reason: ReleaseReason },
): Promise<{ releasedUnits: number }> {
  return ledger.releaseCredits(tx, ctx, input);
}

/** No locks; for UI pre-checks only. */
export function checkCredits(
  db: DbOrTx,
  input: { personId: string; beneficiaryPersonId: string; kind: CreditKind; units: number; validAt: Date },
): Promise<AllocationResult> {
  return ledger.checkCredits(db, input);
}

// commerce: paid, refund and redemption transactions ------------------------------------

/** One grant per call (purchases: one per unit of the line); idempotent per `key`. */
export function grantCredits(tx: Tx, ctx: Ctx, input: ledger.GrantCreditsInput): Promise<{ grantId: string; created: boolean }> {
  return ledger.grantCredits(tx, ctx, input);
}

export function getGrantUsage(
  db: DbOrTx,
  orderLineId: string,
): Promise<{
  grants: { grantId: string; unitsGranted: number; usedUnits: number; remainingUnits: number; status: "active" | "exhausted" | "expired" | "revoked"; unitValueCents: number }[];
}> {
  return ledger.getGrantUsage(db, orderLineId);
}

export function revokeGrantRemainder(
  tx: Tx,
  ctx: Ctx,
  input: { orderLineId: string; grantIds?: string[]; refundId?: string; reason: string },
): Promise<{ revokedUnits: number; grants: { grantId: string; revokedUnits: number }[] }> {
  return ledger.revokeGrantRemainder(tx, ctx, input);
}

export function getEuroBalance(
  db: DbOrTx,
  personId: string,
): Promise<{ remainingCents: number; grants: { grantId: string; remainingCents: number; expiresAt: Date | null }[] }> {
  return ledger.getEuroBalance(db, personId);
}

export function activateMembership(
  tx: Tx,
  ctx: Ctx,
  input: { personId: string; productId: string; orderId: string; priceVersionId: string; mandateId: string | null; startsAt: Date },
): Promise<{ membershipId: string; status: "active" | "pending"; created: boolean }> {
  return membershipService.activateMembership(tx, ctx, input);
}

export function applyRenewalPayment(
  tx: Tx,
  ctx: Ctx,
  input: { membershipId: string; orderId: string },
): Promise<{ periodStartAt: Date; periodEndAt: Date; applied: boolean }> {
  return membershipService.applyRenewalPayment(tx, ctx, input);
}

export function applyRenewalFailure(
  tx: Tx,
  ctx: Ctx,
  input: { membershipId: string; paymentId: string; reason: string },
): Promise<{ status: "past_due" | "expired"; dunningAttempt: number; applied: boolean }> {
  return membershipService.applyRenewalFailure(tx, ctx, input);
}

export function cancelMembershipForRefund(tx: Tx, ctx: Ctx, input: { membershipId: string; reason: string }): Promise<void> {
  return membershipService.cancelMembershipForRefund(tx, ctx, input);
}

export function getMembershipForPerson(
  db: DbOrTx,
  personId: string,
): Promise<{
  isMember: boolean;
  membershipId: string | null;
  planProductId: string | null;
  discountPct: number;
  status: "active" | "past_due" | null;
  periodEndAt: Date | null;
  cancelAt: Date | null;
}> {
  return membershipService.getMembershipForPerson(db, personId);
}

export function canStartMembership(
  db: DbOrTx,
  personId: string,
  opts?: { startsOn?: string },
): Promise<{ ok: true } | { ok: false; reason: "already_member" | "pending_exists" }> {
  return membershipService.canStartMembership(db, personId, opts);
}

// ops, crm, site, booking, finance ---------------------------------------------------------

/** Key stored as `grant:<idempotencyKey>` (ops passes `import:<import_id>:row:<row_number>`). */
export function importGrant(
  tx: Tx,
  ctx: Ctx,
  input: {
    personId: string;
    productId: string | null;
    creditKind: CreditKind;
    units: number;
    expiresAt: Date | null;
    idempotencyKey: string;
    originalUnits?: number;
    unitValueCents?: number;
    legacyId?: string;
  },
): Promise<{ grantId: string; created: boolean }> {
  return ledger.importGrant(tx, ctx, input);
}

export function importMembership(
  tx: Tx,
  ctx: Ctx,
  input: {
    personId: string;
    productId: string;
    periodEndAt: Date;
    idempotencyKey: string;
    startedAt?: Date;
    status?: "active" | "cancelled" | "expired";
    mandateId?: string | null;
  },
): Promise<{ membershipId: string; created: boolean }> {
  return membershipService.importMembership(tx, ctx, input);
}

export function getPersonCreditSummary(
  db: DbOrTx,
  personId: string,
): Promise<{
  byKind: { kind: CreditKind; remainingUnits: number; nextExpiresAt: Date | null }[];
  membership: { id: string; status: string; periodEndAt: Date; planName: LocalizedText } | null;
  status: "lead" | "customer" | "member";
  derivedStatus: "lead" | "customer" | "member";
}> {
  return ledger.getPersonCreditSummary(db, personId);
}

export function getMembershipSummary(
  db: DbOrTx,
  personId: string,
): Promise<{ status: string; productName: LocalizedText; currentPeriodEndAt: Date; includedCredits: { kind: CreditKind; remainingUnits: number }[] } | null> {
  return membershipService.getMembershipSummary(db, personId);
}

/** Finance month close (D29): the liability as it stood at `at`. */
export function getCreditLiabilityAsOf(
  db: DbOrTx,
  at: Date,
): Promise<{ kind: CreditKind; vatTreatment: string; vatRatePct: number | null; remainingUnits: number; remainingValueCents: number }[]> {
  return ledger.getCreditLiabilityAsOf(db, at);
}

export function onPersonsMerged(_tx: Tx, _ctx: Ctx, _input: { winnerPersonId: string; loserPersonId: string }): Promise<void> {
  return notYet("onPersonsMerged");
}

/** R2. */
export function countSharingReviewItems(_db: DbOrTx): Promise<number> {
  return notYet("countSharingReviewItems");
}

/** R2. */
export function listSharingReview(_db: DbOrTx, _opts: { limit: number }): Promise<SharingReviewRow[]> {
  return notYet("listSharingReview");
}

/**
 * R3, crm person creation. V1 code calls it at runtime, so until credits-P9 implements referral
 * codes it resolves to `null` (no code known) instead of throwing (03-build-order rule 1).
 */
export function resolveReferralCode(
  _db: DbOrTx,
  _code: string,
): Promise<{ codeId: string; referrerPersonId: string | null; partnerCompanyId: string | null } | null> {
  return Promise.resolve(null);
}

/** R3, commerce paid transaction. No effect until credits-P9 (03-build-order rule 1). */
export function onOrderPaidForReferrals(_tx: Tx, _ctx: Ctx, _input: { orderId: string }): Promise<void> {
  return Promise.resolve();
}

/** R3, commerce refund transaction. No effect until credits-P9 (03-build-order rule 1). */
export function onOrderRefundedForReferrals(_tx: Tx, _ctx: Ctx, _input: { orderId: string; refundId: string }): Promise<void> {
  return Promise.resolve();
}
