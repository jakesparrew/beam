/**
 * credits' cross-module door (02-data-model section 6.5, credits spec section 4). Every function
 * another module calls, with its final signature. credits-P3 implements the ledger functions
 * (`consumeCredits`, `releaseCredits`, `checkCredits`, `grantCredits`, `getGrantUsage`,
 * `revokeGrantRemainder`, `getEuroBalance`, `importGrant`, `getPersonCreditSummary`,
 * `getCreditLiabilityAsOf`) on `server/ledger.ts`; credits-P4 the membership functions
 * (`activateMembership`, `applyRenewalPayment`, `applyRenewalFailure`, `cancelMembershipForRefund`,
 * `getMembershipForPerson`, `getMembershipSummary`, `canStartMembership`, `importMembership`) on
 * `server/memberships.ts`; credits-P5 the merge hook `onPersonsMerged` (here); credits-P8 the
 * sharing review functions (`countSharingReviewItems`, `listSharingReview`) on `server/sharing.ts`,
 * `listGrantsSharedWith` and the desk badge re-exports. The three R3 referral hooks that V1 code
 * calls at runtime return `null` or nothing until credits-P9. Every write function runs in the
 * caller's transaction.
 */
import type { DbOrTx, Tx } from "@beam/db";
import { creditGrants, memberships } from "@beam/db/schema";
import type { LocalizedText } from "@beam/core/i18n";
import { assertMembershipTransition, type AllocationResult, type CreditKind, type ReleaseReason } from "@beam/core/credits";
import type { SharedPackage } from "./queries";
import type { SharingReviewRow } from "./server/sharing";
import { asc, ConflictError, eq, inArray, sql, ValidationError, type Ctx } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import * as ledger from "./server/ledger";
/**
 * The membership service is loaded on first call: it imports commerce, crm and email, whose
 * import graphs reach booking, and booking imports this file. A static import would close that
 * cycle while this module is still evaluating (consumers would see a half-initialised module).
 */
const membershipService = () => import("./server/memberships");

export type { AllocationResult, CreditKind, GrantSharing, ReleaseReason } from "@beam/core/credits";
export { InsufficientCreditsError, SharingNotAllowedError, type GrantCreditsInput } from "./server/ledger";
export type { SharingReviewRow } from "./server/sharing";
export type { SharedPackage } from "./queries";
export type { DeskCredits } from "./ui/desk-credits-badge";

type DeskBadgeProps = Parameters<typeof import("./ui/desk-credits-badge").DeskCreditsBadge>[0];
type DeskLineProps = Parameters<typeof import("./ui/desk-credits-badge").DeskCreditsLine>[0];

/**
 * booking-P4's check-in desk and commerce's POS (credits-P6 request): server components loaded on
 * render, because the badge reads the session (`@/lib/auth`), whose graph reaches crm and booking.
 */
export async function DeskCreditsBadge(props: DeskBadgeProps) {
  const ui = await import("./ui/desk-credits-badge");
  return ui.DeskCreditsBadge(props);
}

export async function DeskCreditsLine(props: DeskLineProps) {
  const ui = await import("./ui/desk-credits-badge");
  return ui.DeskCreditsLine(props);
}

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
  return membershipService().then((m) => m.activateMembership(tx, ctx, input));
}

export function applyRenewalPayment(
  tx: Tx,
  ctx: Ctx,
  input: { membershipId: string; orderId: string },
): Promise<{ periodStartAt: Date; periodEndAt: Date; applied: boolean }> {
  return membershipService().then((m) => m.applyRenewalPayment(tx, ctx, input));
}

export function applyRenewalFailure(
  tx: Tx,
  ctx: Ctx,
  input: { membershipId: string; paymentId: string; reason: string },
): Promise<{ status: "past_due" | "expired"; dunningAttempt: number; applied: boolean }> {
  return membershipService().then((m) => m.applyRenewalFailure(tx, ctx, input));
}

export function cancelMembershipForRefund(tx: Tx, ctx: Ctx, input: { membershipId: string; reason: string }): Promise<void> {
  return membershipService().then((m) => m.cancelMembershipForRefund(tx, ctx, input));
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
  return membershipService().then((m) => m.getMembershipForPerson(db, personId));
}

export function canStartMembership(
  db: DbOrTx,
  personId: string,
  opts?: { startsOn?: string },
): Promise<{ ok: true } | { ok: false; reason: "already_member" | "pending_exists" }> {
  return membershipService().then((m) => m.canStartMembership(db, personId, opts));
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
  return membershipService().then((m) => m.importMembership(tx, ctx, input));
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
  return membershipService().then((m) => m.getMembershipSummary(db, personId));
}

/** Finance month close (D29): the liability as it stood at `at`. */
export function getCreditLiabilityAsOf(
  db: DbOrTx,
  at: Date,
): Promise<{ kind: CreditKind; vatTreatment: string; vatRatePct: number | null; remainingUnits: number; remainingValueCents: number }[]> {
  return ledger.getCreditLiabilityAsOf(db, at);
}

/**
 * crm's merge hook (rule 35, edge case 12, cross-module D20), inside crm's merge transaction:
 * moves `credit_grants.person_id`, `memberships.person_id` and `package_shares` (sharee and
 * portal creator) from the loser to the winner; ledger entries and membership periods keep the
 * historical `person_id`, balances follow the grant. Two live (`active`/`past_due`) memberships
 * throw `ConflictError('both_members')` (crm refuses that merge first; defensive path). Two
 * `pending` memberships: the later-starting one is `cancelled` (`end_reason = merged`), audited
 * `memberships.merged`, and customer service gets a refund-review task. A share that would point
 * the winner at their own grant, or duplicate the winner's active share, is revoked (`merged`);
 * the sharing caches of the touched grants are rebuilt. R3 referral rows: credits-P9.
 */
export async function onPersonsMerged(tx: Tx, ctx: Ctx, input: { winnerPersonId: string; loserPersonId: string }): Promise<void> {
  const { winnerPersonId: winner, loserPersonId: loser } = input;
  if (winner === loser) throw new ValidationError("validation", { loserPersonId: "same_person" });
  for (const id of [winner, loser].sort()) await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`membership:person:${id}`}))`);

  const rows = await tx.select().from(memberships).where(inArray(memberships.personId, [winner, loser])).orderBy(asc(memberships.id)).for("update");
  const live = rows.filter((m) => m.status === "active" || m.status === "past_due");
  if (live.some((m) => m.personId === winner) && live.some((m) => m.personId === loser)) throw new ConflictError("both_members");
  const winnerPending = rows.find((m) => m.status === "pending" && m.personId === winner);
  const loserPending = rows.find((m) => m.status === "pending" && m.personId === loser);
  if (winnerPending && loserPending) await cancelMergedPending(tx, ctx, winner, [winnerPending, loserPending]);
  await tx
    .update(memberships)
    .set({ personId: winner, version: sql`${memberships.version} + 1`, updatedAt: ctx.now })
    .where(eq(memberships.personId, loser));

  const grantIds = (await tx.select({ id: creditGrants.id }).from(creditGrants).where(inArray(creditGrants.personId, [winner, loser]))).map((g) => g.id);
  await ledger.lockGrants(tx, grantIds);
  await tx.update(creditGrants).set({ personId: winner, updatedAt: ctx.now }).where(eq(creditGrants.personId, loser));
  await mergeShares(tx, ctx, winner, loser);
}

type MembershipRow = typeof memberships.$inferSelect;

/** Two `pending` memberships (rule 35): the later-starting one is cancelled, audited, and a refund review is opened. */
async function cancelMergedPending(tx: Tx, ctx: Ctx, winner: string, pair: [MembershipRow, MembershipRow]): Promise<void> {
  const [keep, drop] = [...pair].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime() || a.id.localeCompare(b.id));
  assertMembershipTransition("pending", "cancelled", { endReason: "merged" });
  await tx
    .update(memberships)
    .set({ status: "cancelled", endReason: "merged", endedAt: ctx.now, nextChargeAt: null, version: drop!.version + 1, updatedAt: ctx.now })
    .where(eq(memberships.id, drop!.id));
  await ctx.audit({
    action: "memberships.merged",
    entityType: "membership",
    entityId: drop!.id,
    personId: winner,
    oldValue: { status: "pending", person_id: drop!.personId },
    newValue: { status: "cancelled", end_reason: "merged", kept_membership_id: keep!.id },
  });
  // Loaded on call: crm's api graph reaches booking, which imports this file.
  const { createTask } = await import("@/modules/crm/api");
  await createTask(tx, ctx, {
    title: "Merged person had two pending memberships: review a refund of the cancelled one",
    kind: "review",
    ownerRole: "customer_service",
    personId: winner,
    dueAt: new Date(ctx.now.getTime() + 86_400_000),
    source: "system",
    ref: { type: "membership", id: drop!.id },
    dedupeKey: `membership:${drop!.id}:merged`,
  });
}

/** Moves the loser's shares to the winner without a share to oneself or a duplicate active share, then rebuilds the caches. */
async function mergeShares(tx: Tx, ctx: Ctx, winner: string, loser: string): Promise<void> {
  const now = sql`${ctx.now.toISOString()}::timestamptz`;
  const w = sql`${winner}::uuid`;
  const l = sql`${loser}::uuid`;
  const touched = rowsOf<{ id: string }>(
    await tx.execute(sql`
      select distinct grant_id as id from package_shares where shared_with_person_id in (${w}, ${l}) or created_by_person_id = ${l}
      union select id from credit_grants where sharing->'allowed_person_ids' ? ${loser}`),
  ).map((r) => r.id);
  if (!touched.length) return;
  const revoke = sql`status = 'revoked', revoked_at = ${now}, revoked_reason = 'merged', updated_at = ${now}`;
  await tx.execute(sql`
    update package_shares s set ${revoke}
    where s.status = 'active' and s.shared_with_person_id = ${l}
      and (exists (select 1 from credit_grants g where g.id = s.grant_id and g.person_id = ${w})
           or exists (select 1 from package_shares x where x.grant_id = s.grant_id and x.status = 'active' and x.shared_with_person_id = ${w}))`);
  await tx.execute(sql`
    update package_shares s set ${revoke}
    where s.status = 'active' and s.shared_with_person_id = ${w}
      and exists (select 1 from credit_grants g where g.id = s.grant_id and g.person_id = ${w})`);
  await tx.execute(sql`update package_shares set shared_with_person_id = ${w}, updated_at = ${now} where shared_with_person_id = ${l}`);
  await tx.execute(sql`update package_shares set created_by_person_id = ${w}, updated_at = ${now} where created_by_person_id = ${l}`);
  await tx.execute(sql`
    update credit_grants g set sharing = jsonb_set(g.sharing, '{allowed_person_ids}',
        coalesce((select jsonb_agg(distinct s.shared_with_person_id) from package_shares s where s.grant_id = g.id and s.status = 'active'), '[]'::jsonb)),
      updated_at = ${now}
    where g.id = any(${`{${touched.join(",")}}`}::uuid[])`);
}

/**
 * Sharing (credits-P8, R2), loaded on call: `server/sharing.ts` reaches crm's api, whose graph
 * reaches booking, which imports this file.
 */
const sharingService = () => import("./server/sharing");

/** R2 (rule 43): open `v_sharing_review` items; ops action dashboard and booking's abuse list. */
export function countSharingReviewItems(db: DbOrTx): Promise<number> {
  return sharingService().then((s) => s.countSharingReviewItems(db));
}

/** R2 (rule 43): the open review items, most recent use first. */
export function listSharingReview(db: DbOrTx, opts: { limit: number }): Promise<SharingReviewRow[]> {
  return sharingService().then((s) => s.listSharingReview(db, opts));
}

/**
 * R2 (booking-P6 request): the packages named-shared with `personId` that they may book on their
 * own account, with the units left for them (`unitsForMe`), so the portal booking form can offer
 * "use a package shared with me".
 */
export function listGrantsSharedWith(db: DbOrTx, personId: string): Promise<SharedPackage[]> {
  return import("./queries").then((q) => q.listGrantsSharedWith(db, personId));
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
