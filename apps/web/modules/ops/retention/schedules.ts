/**
 * ops schedules, area `retention` (ops spec 4.5, Europe/Brussels). The cron of
 * `ops.build_weekly_retention_list` (`10 6 * * 1`, Monday 06:10, catch-up on) is declared in
 * `../schedules.ts`; the scheduled run passes no input and the handler derives the week from
 * `ctx.now` (`weekStartOf` in `./build-list`).
 */
export {};
