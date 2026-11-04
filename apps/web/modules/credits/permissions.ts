/**
 * credits permissions (architecture section 4, 02-data-model 5.3, credits spec section 7). Facade
 * read by `pnpm gen:indexes`. `credits.read` (balances, grants, memberships), `credits.adjust`
 * (staff grants, adjustments, extensions, revocations, transfers, bulk extensions),
 * `memberships.write` (membership changes) and R3 `referrals.manage`. `partner.own`, which credits'
 * partner view (R3) checks, is declared once by platform (`modules/platform/permissions.ts`):
 * every permission is declared by exactly one module.
 */
export const permissions = [
  "credits.read",
  "credits.adjust",
  "memberships.write",
  "referrals.manage",
] as const;
