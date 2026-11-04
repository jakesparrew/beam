// Review fixes of fix-w09-platform-review: the `claim` (booking-P5) and `commerce` (commerce-P5)
// rate-limit routes.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { sql } from "./ctx";
import { bucketsFor, checkRateLimits } from "./rate-limit";

let handle: DbHandle;
beforeAll(async () => {
  handle = await createTestDb();
});
afterAll(() => handle.close());
beforeEach(async () => {
  await handle.db.execute(sql`delete from rate_limits`);
});

const t0 = new Date("2026-11-03T10:00:05Z");
const at = (seconds: number) => new Date(t0.getTime() + seconds * 1000);

describe("claim and commerce routes", () => {
  it("claim counts claim:ip:<ip>, 20 per 60 s", async () => {
    expect(bucketsFor({ route: "claim", ip: "198.51.100.7" })).toEqual([{ key: "claim:ip:198.51.100.7", limit: 20, windowSeconds: 60 }]);
    for (let i = 0; i < 20; i++) expect((await checkRateLimits(handle.db, { route: "claim", ip: "198.51.100.7" }, at(i))).ok).toBe(true);
    const over = await checkRateLimits(handle.db, { route: "claim", ip: "198.51.100.7" }, at(20));
    expect(over.ok).toBe(false);
    expect(over.retryAfterSeconds).toBeGreaterThan(0);
    // Its own bucket: the api bucket of the same IP is untouched.
    expect((await checkRateLimits(handle.db, { route: "api", ip: "198.51.100.7" }, at(21))).ok).toBe(true);
  });

  it("commerce counts commerce:ip:<ip> 20 per 60 s, and with payId also commerce:pay:<id> 5 per 60 s", async () => {
    expect(bucketsFor({ route: "commerce", ip: "198.51.100.8" })).toEqual([{ key: "commerce:ip:198.51.100.8", limit: 20, windowSeconds: 60 }]);
    expect(bucketsFor({ route: "commerce", ip: "198.51.100.8", payId: "o1" })).toEqual([
      { key: "commerce:ip:198.51.100.8", limit: 20, windowSeconds: 60 },
      { key: "commerce:pay:o1", limit: 5, windowSeconds: 60 },
    ]);
    // Different IPs, one order: the sixth pay attempt in the minute is refused.
    for (let i = 0; i < 5; i++) {
      expect((await checkRateLimits(handle.db, { route: "commerce", ip: `203.0.113.${i}`, payId: "o1" }, at(i))).ok).toBe(true);
    }
    expect((await checkRateLimits(handle.db, { route: "commerce", ip: "203.0.113.9", payId: "o1" }, at(6))).ok).toBe(false);
    // One IP without payId: the 21st public checkout action is refused.
    for (let i = 0; i < 20; i++) expect((await checkRateLimits(handle.db, { route: "commerce", ip: "198.51.100.8" }, at(i))).ok).toBe(true);
    expect((await checkRateLimits(handle.db, { route: "commerce", ip: "198.51.100.8" }, at(20))).ok).toBe(false);
  });
});
