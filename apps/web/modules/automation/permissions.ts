/**
 * automation permissions (architecture section 4, 02-data-model 5.3). Facade read by `pnpm gen:indexes`.
 * Wave 0 by platform-P7, so `registry/permissions.generated.ts` is complete from Wave 0.
 */
export const permissions = [
  "automations.write",
  "automations.publish",
  "automations.move_person",
] as const;
