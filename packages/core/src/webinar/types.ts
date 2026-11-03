/**
 * webinar types named in the cross-module contract (02-data-model section 6.12). Wave 0
 * skeleton by platform-P7; webinar owns this file from webinar-P1 on (R2).
 */
export const WATCH_MODES = ["live", "replay", "on_demand"] as const;
export type WatchMode = (typeof WATCH_MODES)[number];
export type WebinarMode = "live" | "simulive" | "on_demand";
export type WebinarStatus = "draft" | "published" | "live" | "ended" | "cancelled" | "archived";
