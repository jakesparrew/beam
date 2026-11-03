/**
 * webinar flags (02-data-model 5.5); webinar owns no settings key. Facade read by
 * `pnpm gen:indexes`. Wave 0 by platform-P7; webinar owns it from webinar-P1 on (R2).
 */
export const settings = [] as const;

export const flags = [{ key: "ff_webinar_portal", description: "Portal webinar pages (R2)" }] as const;
