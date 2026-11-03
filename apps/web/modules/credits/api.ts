/**
 * credits' cross-module door (02-data-model section 6.5, credits spec section 4). Every function
 * another module calls, with its final signature (Wave 0 stubs by platform-P7, completed by
 * credits-P1): each throws `NotImplementedError('credits.<fn>')` until the credits package that
 * lands it (P3 ledger, P4 memberships, P5 merge, P8 sharing review). The three R3 referral hooks
 * that V1 code calls at runtime return `null` or nothing until credits-P9.
 */
import type { DbOrTx, Tx } from "@beam/db";
import { NotImplementedError } from "@beam/core/errors";
import type { LocalizedText } from "@beam/core/i18n";
import type { AllocationResult, CreditKind, GrantSharing, ReleaseReason, SharingReviewRow } from "@beam/core/credits";
import { ConflictError, type Ctx } from "@/lib/ctx";

export type { AllocationResult, CreditKind, GrantSharing, ReleaseReason } from "@beam/core/credits";

const notYet = <T>(fn: string): Promise<T> => Promise.reject(new NotImplementedError(`credits.${fn}`));

export class InsufficientCreditsError extends ConflictError {
  override readonly name: string = "InsufficientCreditsError";
  constructor(
    readonly kind: CreditKind,
    readonly needed: number,
    readonly available: number,
    readonly reason: "insufficient" | "guest_limit" | "not_shareable" | "share_limit" = "insufficient",
  ) {
    super(`insufficient_credits: ${reason}`);
  }
}

/** Booking R55: reason `guest_limit`, `not_shareable` or `share_limit`. */
export class SharingNotAllowedError extends InsufficientCreditsError {
  override readonly name: string = "SharingNotAllowedError";
}

export type GrantCreditsInput = {
  personId: string;
  kind: CreditKind;
  units: number;
  source: "purchase" | "voucher" | "bonus" | "manual" | "import" | "referral";
  productId?: string;
  orderLineId?: string;
  lineUnitIndex?: number;
  voucherId?: string;
  refundId?: string;
  unitValueCents?: number;
  vatRatePct?: number | null;
  sharing?: GrantSharing;
  label?: LocalizedText;
  startsAt?: Date;
  expiresAt: Date | null;
  reason?: string;
  /** The full idempotency key, e.g. `grant:order_line:<id>:<n>`, `grant:voucher:<id>`. */
  key: string;
  data?: { original_units?: number; legacy_source?: string; legacy_id?: string; import_id?: string };
};

// booking and commerce ------------------------------------------------------------------

export function consumeCredits(
  _tx: Tx,
  _ctx: Ctx,
  _input: { personId: string; beneficiaryPersonId: string; kind: CreditKind; units: number; ref: { type: "booking" | "order"; id: string }; validAt?: Date },
): Promise<{ entries: { entryId: string; grantId: string; quantity: number }[]; remainingUnits: number }> {
  return notYet("consumeCredits");
}

export function releaseCredits(
  _tx: Tx,
  _ctx: Ctx,
  _input: { ref: { type: "booking" | "order"; id: string }; reason: ReleaseReason },
): Promise<{ releasedUnits: number }> {
  return notYet("releaseCredits");
}

export function checkCredits(
  _db: DbOrTx,
  _input: { personId: string; beneficiaryPersonId: string; kind: CreditKind; units: number; validAt: Date },
): Promise<AllocationResult> {
  return notYet("checkCredits");
}

// commerce: paid, refund and redemption transactions ------------------------------------

export function grantCredits(_tx: Tx, _ctx: Ctx, _input: GrantCreditsInput): Promise<{ grantId: string; created: boolean }> {
  return notYet("grantCredits");
}

export function getGrantUsage(
  _db: DbOrTx,
  _orderLineId: string,
): Promise<{
  grants: { grantId: string; unitsGranted: number; usedUnits: number; remainingUnits: number; status: "active" | "exhausted" | "expired" | "revoked"; unitValueCents: number }[];
}> {
  return notYet("getGrantUsage");
}

export function revokeGrantRemainder(
  _tx: Tx,
  _ctx: Ctx,
  _input: { orderLineId: string; grantIds?: string[]; refundId?: string; reason: string },
): Promise<{ revokedUnits: number; grants: { grantId: string; revokedUnits: number }[] }> {
  return notYet("revokeGrantRemainder");
}

export function getEuroBalance(
  _db: DbOrTx,
  _personId: string,
): Promise<{ remainingCents: number; grants: { grantId: string; remainingCents: number; expiresAt: Date | null }[] }> {
  return notYet("getEuroBalance");
}

export function activateMembership(
  _tx: Tx,
  _ctx: Ctx,
  _input: { personId: string; productId: string; orderId: string; priceVersionId: string; mandateId: string | null; startsAt: Date },
): Promise<{ membershipId: string; status: "active" | "pending"; created: boolean }> {
  return notYet("activateMembership");
}

export function applyRenewalPayment(
  _tx: Tx,
  _ctx: Ctx,
  _input: { membershipId: string; orderId: string },
): Promise<{ periodStartAt: Date; periodEndAt: Date; applied: boolean }> {
  return notYet("applyRenewalPayment");
}

export function applyRenewalFailure(
  _tx: Tx,
  _ctx: Ctx,
  _input: { membershipId: string; paymentId: string; reason: string },
): Promise<{ status: "past_due" | "expired"; dunningAttempt: number; applied: boolean }> {
  return notYet("applyRenewalFailure");
}

export function cancelMembershipForRefund(_tx: Tx, _ctx: Ctx, _input: { membershipId: string; reason: string }): Promise<void> {
  return notYet("cancelMembershipForRefund");
}

export function getMembershipForPerson(
  _db: DbOrTx,
  _personId: string,
): Promise<{
  isMember: boolean;
  membershipId: string | null;
  planProductId: string | null;
  discountPct: number;
  status: "active" | "past_due" | null;
  periodEndAt: Date | null;
  cancelAt: Date | null;
}> {
  return notYet("getMembershipForPerson");
}

export function canStartMembership(
  _db: DbOrTx,
  _personId: string,
  _opts?: { startsOn?: string },
): Promise<{ ok: true } | { ok: false; reason: "already_member" | "pending_exists" }> {
  return notYet("canStartMembership");
}

// ops, crm, site, booking, finance ---------------------------------------------------------

export function importGrant(
  _tx: Tx,
  _ctx: Ctx,
  _input: {
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
  return notYet("importGrant");
}

export function importMembership(
  _tx: Tx,
  _ctx: Ctx,
  _input: {
    personId: string;
    productId: string;
    periodEndAt: Date;
    idempotencyKey: string;
    startedAt?: Date;
    status?: "active" | "cancelled" | "expired";
    mandateId?: string | null;
  },
): Promise<{ membershipId: string; created: boolean }> {
  return notYet("importMembership");
}

export function getPersonCreditSummary(
  _db: DbOrTx,
  _personId: string,
): Promise<{
  byKind: { kind: CreditKind; remainingUnits: number; nextExpiresAt: Date | null }[];
  membership: { id: string; status: string; periodEndAt: Date; planName: LocalizedText } | null;
  status: "lead" | "customer" | "member";
  derivedStatus: "lead" | "customer" | "member";
}> {
  return notYet("getPersonCreditSummary");
}

export function getMembershipSummary(
  _db: DbOrTx,
  _personId: string,
): Promise<{ status: string; productName: LocalizedText; currentPeriodEndAt: Date; includedCredits: { kind: CreditKind; remainingUnits: number }[] } | null> {
  return notYet("getMembershipSummary");
}

export function getCreditLiabilityAsOf(
  _db: DbOrTx,
  _at: Date,
): Promise<{ kind: CreditKind; vatTreatment: string; vatRatePct: number | null; remainingUnits: number; remainingValueCents: number }[]> {
  return notYet("getCreditLiabilityAsOf");
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
