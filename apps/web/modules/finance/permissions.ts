/**
 * finance permissions (architecture section 4, 02-data-model 5.3, finance spec section 7).
 * Facade read by `pnpm gen:indexes`. `reports.finance` is the third finance permission of the
 * spec; it is declared once, by ops (`modules/ops/permissions.ts`), because the generator refuses
 * a key declared twice. Finance's actions and queries guard with all three.
 */
export const permissions = [
  "invoices.read",
  "invoices.issue",
] as const;
