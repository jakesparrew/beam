/**
 * fix-w05-schema-1: booking's five schedules of spec 4.6 are registered (they were parked in
 * `PLANNED_SCHEDULES`), keep their crons and catch-up rules, and each has a job whose input
 * accepts the schedule payload.
 */
import { describe, expect, it } from "vitest";
import { JOB_BY_KIND } from "@/registry/jobs.generated";
import { GDPR_REGISTRY } from "@/registry/privacy.generated";
import { SCHEDULE_BY_KIND } from "@/registry/schedules.generated";
import { jobs } from "./jobs";
import { privacy } from "./privacy";
import { PLANNED_SCHEDULES, schedules } from "./schedules";

describe("booking schedules (fix-w05-schema-1)", () => {
  it("registers the five schedules of spec 4.6 with their crons", () => {
    expect(schedules.map((s) => `${s.kind} ${s.cron} ${s.catchUp}`).sort()).toEqual(
      [
        "waitlist.expire_offers * * * * * false",
        "bookings.expire_reservations * * * * * false",
        "bookings.mark_no_shows */15 * * * * true",
        "bookings.send_reminders */15 * * * * true",
        "sessions.materialise 10 3 * * * true",
      ].sort(),
    );
    expect(PLANNED_SCHEDULES).toBe(schedules);
  });

  it("every schedule is in the generated registry and has a booking job that accepts its payload", () => {
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

describe("booking privacy registration (fix-w05-schema-1)", () => {
  it("lists waitlist_entries next to bookings and keeps the handler shapes", () => {
    expect(privacy.tables).toEqual(["bookings", "waitlist_entries"]);
    expect(GDPR_REGISTRY.booking.tables).toContain("waitlist_entries");
    // The handlers are real since booking-P6 (privacy.test.ts runs them on a test database);
    // here only the registration's shape is checked.
    expect(GDPR_REGISTRY.booking).toBe(privacy);
    expect(typeof privacy.export).toBe("function");
    expect(typeof privacy.erase).toBe("function");
  });
});
