/**
 * booking schedules (booking spec 4.6, cron in Europe/Brussels). Facade read by `pnpm gen:indexes`:
 * every `kind` is a literal and has a job in `jobs.ts`. Minute-level crons never catch up (PL-33).
 *
 * `schedules` stays empty for now: platform's `modules/platform/schedules.test.ts` and
 * `app/api/cron/tick/route.test.ts` assert that the registry holds platform's schedules only, so
 * registering these would turn them red (requested to platform in booking-P1's report). Once
 * those tests filter on platform kinds, the entries of `PLANNED_SCHEDULES` move into `schedules`
 * unchanged.
 */
import { defineSchedule } from "@/lib/job-runner";

export * from "./schedules/schedule";
export * from "./schedules/bookings";
export * from "./schedules/attendance";
export * from "./schedules/waitlist";

/** The five booking schedules of spec 4.6, not yet registered (see above). */
export const PLANNED_SCHEDULES = [
  defineSchedule({ kind: "waitlist.expire_offers", cron: "* * * * *", catchUp: false }),
  defineSchedule({ kind: "bookings.expire_reservations", cron: "* * * * *", catchUp: false }),
  defineSchedule({ kind: "bookings.mark_no_shows", cron: "*/15 * * * *", catchUp: true }),
  defineSchedule({ kind: "bookings.send_reminders", cron: "*/15 * * * *", catchUp: true }),
  defineSchedule({ kind: "sessions.materialise", cron: "10 3 * * *", catchUp: true }),
];

export const schedules = [] as const;
