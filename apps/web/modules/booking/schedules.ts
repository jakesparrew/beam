/**
 * booking schedules (booking spec 4.6, cron in Europe/Brussels). Facade read by `pnpm gen:indexes`:
 * every `kind` is a literal and has a job in `jobs.ts`. Minute-level crons never catch up (PL-33).
 *
 * Registered by fix-w05-schema-1 once platform's schedule tests filtered on platform kinds
 * (fix-w04-platform-3). Handlers that a later booking package implements are no-ops until then.
 */
import { defineSchedule } from "@/lib/job-runner";

export * from "./schedules/schedule";
export * from "./schedules/bookings";
export * from "./schedules/attendance";
export * from "./schedules/waitlist";

/** The five booking schedules of spec 4.6. */
export const schedules = [
  defineSchedule({ kind: "waitlist.expire_offers", cron: "* * * * *", catchUp: false }),
  defineSchedule({ kind: "bookings.expire_reservations", cron: "* * * * *", catchUp: false }),
  defineSchedule({ kind: "bookings.mark_no_shows", cron: "*/15 * * * *", catchUp: true }),
  defineSchedule({ kind: "bookings.send_reminders", cron: "*/15 * * * *", catchUp: true }),
  defineSchedule({ kind: "sessions.materialise", cron: "10 3 * * *", catchUp: true }),
];

/** @deprecated Kept for earlier imports; the same entries as `schedules`. */
export const PLANNED_SCHEDULES = schedules;
