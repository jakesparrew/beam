/**
 * Which grants pay for a booking or an order (credits rules 13 to 18, 20). Pure: the ledger
 * locks the grants first, reads balances and guest counts under the lock, then calls this.
 */
import type { GrantSharing } from "./schemas";
import type { GrantStatus } from "./state-machines";
import type { CreditKind } from "./types";

export type AllocGrant = {
  id: string;
  ownerPersonId: string;
  kind: CreditKind;
  status: GrantStatus;
  startsAt: Date;
  expiresAt: Date | null;
  remaining: number;
  sharing: GrantSharing;
  /** Distinct bookings of unreleased guest consumes on this grant in the current Brussels month. */
  guestUsesThisMonth: number;
  /** Set when an active `package_shares` row names the beneficiary (R2 named use). */
  share?: { maxUnits: number | null; usedByBeneficiary: number };
};

export type AllocationFailureReason = "insufficient" | "guest_limit" | "not_shareable" | "share_limit";

export type AllocationResult =
  | { ok: true; parts: { grantId: string; units: number }[] }
  | { ok: false; reason: AllocationFailureReason; available: number };

type Exclusion = Exclude<AllocationFailureReason, "insufficient">;

/** Rule 13: active, of the kind, `starts_at <= validAt < expires_at` (or no expiry), balance above 0. */
export function isGrantValidAt(g: AllocGrant, kind: CreditKind, validAt: Date): boolean {
  const t = validAt.getTime();
  return (
    g.status === "active" &&
    g.kind === kind &&
    g.remaining > 0 &&
    g.startsAt.getTime() <= t &&
    (g.expiresAt === null || t < g.expiresAt.getTime())
  );
}

/** Rule 14 within a group: earliest `expires_at` first (null last), then oldest `starts_at`, then `id`. */
export function compareAllocationOrder(a: AllocGrant, b: AllocGrant): number {
  const ea = a.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const eb = b.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY;
  if (ea !== eb) return ea < eb ? -1 : 1;
  const sa = a.startsAt.getTime();
  const sb = b.startsAt.getTime();
  if (sa !== sb) return sa < sb ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * How many units of grant `g` this booking may take, or why it may take none.
 * Own grant, own use: the whole balance. Own grant, guest use (rule 17): mode `guests` or
 * `named` and a monthly guest use left (a limit of 0 forbids guests). Someone else's grant
 * (rule 18, R2): only for a beneficiary booking on their own account with an active share,
 * capped by `max_units` minus what they already used.
 */
function usable(g: AllocGrant, payer: string, beneficiary: string): { units: number; excluded?: Exclusion } {
  if (g.ownerPersonId === payer) {
    if (beneficiary === payer) return { units: g.remaining };
    if (g.sharing.mode === "none" || g.sharing.max_guest_uses_per_month <= 0) return { units: 0, excluded: "not_shareable" };
    if (g.guestUsesThisMonth >= g.sharing.max_guest_uses_per_month) return { units: 0, excluded: "guest_limit" };
    return { units: g.remaining };
  }
  if (beneficiary !== payer || !g.share) return { units: 0 };
  const cap = g.share.maxUnits === null ? g.remaining : Math.max(0, g.share.maxUnits - g.share.usedByBeneficiary);
  const units = Math.min(g.remaining, cap);
  return units < g.remaining ? { units, excluded: "share_limit" } : { units };
}

/**
 * Allocates `units` of `kind` for a booking (`validAt` = session start) or an order (`validAt` =
 * now). The payer's own grants come first, then grants shared with the beneficiary; each group in
 * `compareAllocationOrder`. A booking may split across grants (rule 15). When the eligible total is
 * short, nothing is allocated: `insufficient` when no sharing rule is to blame, else the sharing
 * reason (`not_shareable`, `guest_limit`, `share_limit`) whose excluded units would have covered it
 * (rule 16). `available` is the eligible total.
 */
export function allocateCredits(
  grants: AllocGrant[],
  kind: CreditKind,
  units: number,
  ctx: { payerPersonId: string; beneficiaryPersonId: string; validAt: Date },
): AllocationResult {
  if (!Number.isInteger(units) || units <= 0) throw new RangeError(`invalid units ${units}`);
  const valid = grants.filter((g) => isGrantValidAt(g, kind, ctx.validAt));
  const own = valid.filter((g) => g.ownerPersonId === ctx.payerPersonId).sort(compareAllocationOrder);
  const shared = valid.filter((g) => g.ownerPersonId !== ctx.payerPersonId).sort(compareAllocationOrder);

  const parts: { grantId: string; units: number }[] = [];
  const excluded: Record<Exclusion, number> = { guest_limit: 0, share_limit: 0, not_shareable: 0 };
  let available = 0;
  let left = units;
  for (const g of [...own, ...shared]) {
    const u = usable(g, ctx.payerPersonId, ctx.beneficiaryPersonId);
    if (u.excluded) excluded[u.excluded] += g.remaining - u.units;
    available += u.units;
    const take = Math.min(left, u.units);
    if (take > 0) {
      parts.push({ grantId: g.id, units: take });
      left -= take;
    }
  }
  if (left === 0) return { ok: true, parts };

  const order: Exclusion[] = ["guest_limit", "share_limit", "not_shareable"];
  const totalExcluded = order.reduce((n, r) => n + excluded[r], 0);
  if (available + totalExcluded < units) return { ok: false, reason: "insufficient", available };
  const reason = order.reduce((best, r) => (excluded[r] > excluded[best] ? r : best), order[0] as Exclusion);
  return { ok: false, reason, available };
}
