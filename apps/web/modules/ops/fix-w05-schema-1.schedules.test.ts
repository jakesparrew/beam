/**
 * fix-w05-schema-1: ops's eight schedules of spec 4.5 are registered (they were parked in
 * `PLANNED_SCHEDULES`), keep their crons and catch-up rules, and each has a job whose input
 * accepts the schedule payload.
 */
import { describe, expect, it } from "vitest";
import { JOB_BY_KIND } from "@/registry/jobs.generated";
import { SCHEDULE_BY_KIND } from "@/registry/schedules.generated";
import { jobs } from "./jobs";
import { PLANNED_SCHEDULES, schedules } from "./schedules";

describe("ops schedules (fix-w05-schema-1)", () => {
  it("registers the eight schedules of spec 4.5 with their crons", () => {
    expect(schedules.map((s) => `${s.kind} ${s.cron} ${s.catchUp}`).sort()).toEqual(
      [
        "privacy.retention_sweep 0 1 * * * true",
        "ops.refresh_person_stats 0 4 * * * true",
        "ops.refresh_recent_stats */5 * * * * false",
        "ops.daily_digest 0 8 * * * true",
        "ops.build_weekly_retention_list 10 6 * * 1 true",
        "ads.pull_yesterday 30 5 * * * true",
        "ops.compute_attribution 50 5 * * * true",
        "ai.weekly_summary 30 6 * * 1 true",
      ].sort(),
    );
    expect(PLANNED_SCHEDULES).toBe(schedules);
  });

  it("every schedule is in the generated registry and has an ops job that accepts its payload", () => {
    const own = new Map<string, (typeof jobs)[number]>(jobs.map((j) => [j.kind, j]));
    for (const s of schedules) {
      expect(SCHEDULE_BY_KIND[s.kind as keyof typeof SCHEDULE_BY_KIND], s.kind).toBe(s);
      expect(JOB_BY_KIND[s.kind], s.kind).toBeDefined();
      const job = own.get(s.kind);
      expect(job, s.kind).toBeDefined();
      expect(job!.input.safeParse(s.payload ?? {}).success, s.kind).toBe(true);
    }
  });
});
