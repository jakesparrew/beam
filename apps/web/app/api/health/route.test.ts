import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@beam/db/testing";
import { enqueue, type DbHandle } from "@beam/db";
import { settings } from "@beam/db/schema";

const booking = vi.hoisted(() => ({ impl: null as null | (() => Promise<unknown>) }));
vi.mock("@/modules/booking/api", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown> & { getBookingHealth: (db: unknown) => Promise<unknown> };
  return { ...original, getBookingHealth: (db: unknown) => (booking.impl ? booking.impl() : original.getBookingHealth(db)) };
});

import { setAppDb, sql } from "@/lib/ctx";
import { resetRuntime } from "@/lib/testing";
import { GET } from "./route";

let handle: DbHandle;
beforeAll(async () => {
  handle = await createTestDb();
  setAppDb(handle.db);
});
afterAll(async () => {
  resetRuntime();
  await handle.close();
});
beforeEach(async () => {
  booking.impl = null;
  await handle.db.execute(sql`delete from jobs`);
  await handle.db.execute(sql`delete from settings`);
  vi.stubEnv("APP_ENV", "local");
});
afterEach(() => vi.unstubAllEnvs());

const KEY = Buffer.alloc(32, 3).toString("base64");
const alertHealth = { level: "alert", materialisedThroughOn: "2026-11-10", overdueOffers: 11, overdueReservations: 0, unsentConfirmations24h: 0 };

function production(over: Record<string, string | undefined> = {}) {
  const env: Record<string, string | undefined> = {
    APP_ENV: "production",
    SENSITIVE_DATA_KEY_V1: KEY,
    DATABASE_URL: "postgresql://u:p@host/db?sslmode=require",
    EMAIL_SINK: undefined,
    PAYMENTS_FAKE: undefined,
    INTEGRATIONS: undefined,
    MOLLIE_API_KEY: "live_abc",
    ...over,
  };
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v as string);
}

async function freshTick() {
  await handle.db.insert(settings).values({ key: "last_tick_at", value: new Date().toISOString() }).onConflictDoUpdate({ target: settings.key, set: { value: new Date().toISOString() } });
}

describe("GET /api/health (PL-74)", () => {
  it("200 with the documented shape; a throwing booking stub gives level unknown", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as Record<string, unknown> & { checks: Record<string, unknown> };
    expect(body.status).toBe("ok");
    expect(typeof body.version).toBe("string");
    expect(Object.keys(body.checks).sort()).toEqual(["booking", "config", "database", "jobs", "tick"]);
    expect(body.checks.booking).toEqual({ level: "unknown" });
  });

  it("booking health alert is still 200, with status degraded", async () => {
    booking.impl = () => Promise.resolve(alertHealth);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; checks: { booking: unknown } };
    expect(body.status).toBe("degraded");
    expect(body.checks.booking).toEqual(alertHealth);
  });

  it("503 on a backlog of 501", async () => {
    for (let i = 0; i < 501; i++) await enqueue(handle.db, { kind: "jobs.prune", payload: {}, key: `b:${i}` });
    expect((await GET()).status).toBe(503);
  });

  it("a stale tick is 503 in production only", async () => {
    await handle.db.insert(settings).values({ key: "last_tick_at", value: new Date(Date.now() - 181_000).toISOString() });
    expect((await GET()).status).toBe(200);
    production();
    expect((await GET()).status).toBe(503);
  });

  it("a correct production configuration is 200", async () => {
    production();
    await freshTick();
    expect((await GET()).status).toBe(200);
  });

  it.each([
    ["PAYMENTS_FAKE=1", { PAYMENTS_FAKE: "1" }],
    ["EMAIL_SINK set", { EMAIL_SINK: "sink@beam.be" }],
    ["INTEGRATIONS=fake", { INTEGRATIONS: "fake" }],
    ["a test_ Mollie key", { MOLLIE_API_KEY: "test_abc" }],
    ["no SENSITIVE_DATA_KEY_V1", { SENSITIVE_DATA_KEY_V1: undefined }],
    ["DATABASE_URL without sslmode=require", { DATABASE_URL: "postgresql://u:p@host/db" }],
  ])("503 in production with %s", async (_label, over) => {
    production(over);
    await freshTick();
    const res = await GET();
    expect(res.status).toBe(503);
    const body = (await res.json()) as { checks: { config: { ok: boolean; problems: string[] } } };
    expect(body.checks.config.ok).toBe(false);
    expect(JSON.stringify(body)).not.toContain(KEY);
  });
});
