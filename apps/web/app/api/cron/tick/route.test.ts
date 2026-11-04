import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { jobs, settings } from "@beam/db/schema";
import { eq, setAppDb, sql } from "@/lib/ctx";
import { setIntegrations } from "@/lib/integrations";
import { createFakeIntegrations, resetRuntime } from "@/lib/testing";
import { schedules } from "@/modules/platform/schedules";
import { GET } from "./route";

let handle: DbHandle;
beforeAll(async () => {
  handle = await createTestDb();
  setAppDb(handle.db);
  setIntegrations(createFakeIntegrations());
  vi.stubEnv("CRON_SECRET", "cron-secret-for-tests");
  vi.stubEnv("BETTERSTACK_HEARTBEAT_URL", "");
});
afterAll(async () => {
  vi.unstubAllEnvs();
  resetRuntime();
  await handle.close();
});
afterEach(() => vi.useRealTimers());

const call = (authorization?: string) =>
  GET(new Request("http://localhost/api/cron/tick", authorization ? { headers: { authorization } } : {}));

describe("GET /api/cron/tick (PL-32, PL-33)", () => {
  it("401 without the bearer secret", async () => {
    expect((await call()).status).toBe(401);
    expect((await call("Bearer wrong")).status).toBe(401);
    expect((await call("cron-secret-for-tests")).status).toBe(401);
  });

  it("enqueues due schedules once across two calls in the same minute, runs them and writes last_tick_at", async () => {
    // 10:00:10 UTC is 11:00 in Brussels: platform.check_alerts (*/5) is due.
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-03T10:00:10Z") });
    const first = await call("Bearer cron-secret-for-tests");
    expect(first.status).toBe(200);
    const body = (await first.json()) as { tickId: string; enqueuedSchedules: number; ran: { fast: number; bulk: number }; reclaimed: number };
    expect(body.tickId).toMatch(/^tick:/);
    // Modules register their own schedules: look only at platform's kinds (one due: check_alerts).
    const platformKinds = new Set<string>(schedules.map((s) => s.kind));
    const enqueued = (await handle.db.select({ key: jobs.idempotencyKey }).from(jobs).where(sql`${jobs.idempotencyKey} like 'schedule:%'`)).map((r) => r.key);
    expect(body.enqueuedSchedules).toBe(enqueued.length);
    expect(enqueued.filter((k) => platformKinds.has(k.split(":")[1]!))).toEqual(["schedule:platform.check_alerts:2026-11-03T11:00"]);
    expect(body.ran.fast).toBeGreaterThanOrEqual(1);

    const second = (await (await call("Bearer cron-secret-for-tests")).json()) as { enqueuedSchedules: number };
    expect(second.enqueuedSchedules).toBe(0);

    const scheduled = await handle.db.select().from(jobs).where(eq(jobs.idempotencyKey, "schedule:platform.check_alerts:2026-11-03T11:00"));
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.status).toBe("succeeded");
    const [tick] = await handle.db.select().from(settings).where(eq(settings.key, "last_tick_at"));
    expect(tick!.value).toBe("2026-11-03T10:00:10.000Z");
  });
});
