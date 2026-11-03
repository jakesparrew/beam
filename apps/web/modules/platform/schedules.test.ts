import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { jobs } from "@beam/db/schema";
import { zonedTimeToUtc } from "@beam/core/platform";
import { enqueueDueSchedules, loadSchedules } from "@/lib/job-runner";
import { sql } from "@/lib/ctx";
import { schedules } from "./schedules";

let handle: DbHandle;
beforeAll(async () => {
  handle = await createTestDb();
});
afterAll(() => handle.close());
beforeEach(async () => {
  await handle.db.execute(sql`delete from jobs`);
});

const brussels = (day: number, hour: number, minute: number) => zonedTimeToUtc({ year: 2026, month: 11, day, hour, minute });
const keys = async () => (await handle.db.select({ key: jobs.idempotencyKey }).from(jobs)).map((r) => r.key).sort();

describe("platform schedules (PL-33)", () => {
  it("are all registered with valid crons", async () => {
    const registered = await loadSchedules();
    expect(registered.map((s) => s.kind).sort()).toEqual(schedules.map((s) => s.kind).sort());
    expect(schedules.find((s) => s.kind === "platform.check_alerts")).toMatchObject({ cron: "*/5 * * * *", catchUp: false });
  });

  it("a daily schedule catches up a missed slot within 60 minutes", async () => {
    const inserted = await enqueueDueSchedules(handle.db, brussels(10, 2, 31), brussels(10, 1, 55));
    expect(await keys()).toEqual(["schedule:files.purge_expired:2026-11-10T02:00", "schedule:platform.prune_ephemeral:2026-11-10T02:17"]);
    expect(inserted).toBe(2);
  });

  it("does not catch up more than 60 minutes back", async () => {
    await enqueueDueSchedules(handle.db, brussels(10, 3, 31), brussels(10, 0, 0));
    expect(await keys()).not.toContain("schedule:files.purge_expired:2026-11-10T02:00");
    expect(await keys()).toEqual(["schedule:jobs.prune:2026-11-10T03:30", "schedule:platform.prune_ephemeral:2026-11-10T03:17"]);
  });

  it("a five-minute schedule only enqueues the current slot, never missed ones", async () => {
    await enqueueDueSchedules(handle.db, brussels(10, 9, 20), brussels(10, 8, 30));
    const k = await keys();
    expect(k.filter((x) => x.startsWith("schedule:platform.check_alerts:"))).toEqual(["schedule:platform.check_alerts:2026-11-10T09:20"]);
    expect(k).toContain("schedule:platform.prune_ephemeral:2026-11-10T09:17");
  });

  it("enqueues each slot once across overlapping ticks", async () => {
    const now = brussels(10, 3, 30);
    expect(await enqueueDueSchedules(handle.db, now, null)).toBe(2);
    expect(await enqueueDueSchedules(handle.db, now, null)).toBe(0);
    expect(await keys()).toEqual(["schedule:jobs.prune:2026-11-10T03:30", "schedule:platform.check_alerts:2026-11-10T03:30"]);
  });

  it("the monthly report runs at 07:10 on the first of the month", async () => {
    await enqueueDueSchedules(handle.db, brussels(1, 7, 10), null);
    expect(await keys()).toContain("schedule:platform.build_monthly_report:2026-11-01T07:10");
  });
});
