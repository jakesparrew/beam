/**
 * booking permissions (architecture section 4, 02-data-model 5.3). Facade read by `pnpm gen:indexes`.
 * Wave 0 by platform-P7, so `registry/permissions.generated.ts` is complete from Wave 0.
 */
export const permissions = [
  "bookings.read",
  "bookings.write",
  "bookings.override",
  "waitlist.manage",
] as const;
