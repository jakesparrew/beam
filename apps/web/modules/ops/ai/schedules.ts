/**
 * ops schedules, area `ai` (ops spec 4.5, Europe/Brussels). The cron of `ai.weekly_summary`
 * (Monday 06:30, R4) is declared in `../schedules.ts`; its handler summarises the Brussels week
 * before the run (`lastWeekStart`) and returns early while `ff_ops_ai` is off.
 */
export { lastWeekStart } from "./summary";

/** The cron of `ai.weekly_summary` as declared in `../schedules.ts` (rule 78). */
export const WEEKLY_SUMMARY_CRON = "30 6 * * 1";
