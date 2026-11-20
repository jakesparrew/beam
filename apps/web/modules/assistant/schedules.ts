/**
 * assistant schedules (cron in Europe/Brussels). Facade read by `pnpm gen:indexes`. Conversation
 * analysis runs on delayed jobs; the one schedule is the daily profile-advice sweep.
 */
import { defineSchedule } from "@/lib/job-runner";

export const schedules = [defineSchedule({ kind: "assistant.advise_recent", cron: "30 6 * * *" })] as const;
