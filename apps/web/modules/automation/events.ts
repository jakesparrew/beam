/**
 * automation timeline events (automation spec 4.6). Facade read by `pnpm gen:indexes`. The module
 * emits no `activity_events` (A-7 prevents feedback loops): journeys reach the person timeline
 * through `automation_runs` (`getTimelineItems`), so the list stays empty.
 */
export const events = [] as const;
