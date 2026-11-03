import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { sql } from "./ctx";
import { checkRateLimits, limitApiRequest, rateLimit, rateLimitResponse } from "./rate-limit";

let handle: DbHandle;
beforeAll(async () => {
  handle = await createTestDb();
});
afterAll(() => handle.close());
beforeEach(async () => {
  await handle.db.execute(sql`delete from rate_limits`);
});

// A fixed instant at the start of a minute window, so 60 hits stay inside one window.
const t0 = new Date("2026-11-03T10:00:05Z");
const at = (seconds: number) => new Date(t0.getTime() + seconds * 1000);

describe("rateLimit", () => {
  it("counts within a fixed window and rolls over", async () => {
    const spec = { key: "test:k", limit: 2, windowSeconds: 60 };
    expect((await rateLimit(handle.db, spec, at(0))).ok).toBe(true);
    expect((await rateLimit(handle.db, spec, at(1))).ok).toBe(true);
    const third = await rateLimit(handle.db, spec, at(2));
    expect(third).toEqual({ ok: false, retryAfterSeconds: 53 });
    expect((await rateLimit(handle.db, spec, at(56))).ok).toBe(true);
  });
});

describe("PL-68 limits", () => {
  it("the 11th login per IP in a minute is refused with Retry-After", async () => {
    for (let i = 0; i < 10; i++) {
      expect((await checkRateLimits(handle.db, { route: "login", ip: "198.51.100.1", email: `user${i}@example.com` }, at(i))).ok).toBe(true);
    }
    const eleventh = await checkRateLimits(handle.db, { route: "login", ip: "198.51.100.1", email: "user10@example.com" }, at(10));
    expect(eleventh.ok).toBe(false);
    const res = rateLimitResponse(eleventh.retryAfterSeconds);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("20 logins per account per hour from many IPs", async () => {
    for (let i = 0; i < 20; i++) {
      expect((await checkRateLimits(handle.db, { route: "login", ip: `203.0.113.${i}`, email: "victim@example.com" }, at(i))).ok).toBe(true);
    }
    expect((await checkRateLimits(handle.db, { route: "login", ip: "203.0.113.99", email: "VICTIM@example.com" }, at(30))).ok).toBe(false);
  });

  it("5 magic links per address per hour", async () => {
    for (let i = 0; i < 5; i++) expect((await checkRateLimits(handle.db, { route: "magic_link", email: "a@example.com" }, at(i))).ok).toBe(true);
    expect((await checkRateLimits(handle.db, { route: "magic_link", email: "a@example.com" }, at(9))).ok).toBe(false);
  });

  it("heartbeat and state are counted per registration, not against the per-IP bucket", async () => {
    const ip = "192.0.2.10";
    for (let i = 0; i < 59; i++) {
      expect(await limitApiRequest(handle.db, { pathname: "/api/webinar/heartbeat", ip, registrationId: `reg-${i}` }, at(0))).toBeNull();
      expect(await limitApiRequest(handle.db, { pathname: "/api/webinar/state", ip, registrationId: `reg-${i}` }, at(0))).toBeNull();
    }
    // The per-IP bucket of /api/* is untouched by those 118 requests.
    expect(await limitApiRequest(handle.db, { pathname: "/api/public/claim/x", ip }, at(1))).toBeNull();
    const rows = (await handle.db.execute(sql`select count from rate_limits where key = ${`api:ip:${ip}`}`)) as unknown as { rows: { count: number }[] };
    expect(rows.rows[0]!.count).toBe(1);
  });

  it("the 9th heartbeat of one registration in a minute is 429", async () => {
    for (let i = 0; i < 8; i++) expect(await limitApiRequest(handle.db, { pathname: "/api/webinar/heartbeat", ip: "192.0.2.1", registrationId: "r1" }, at(i))).toBeNull();
    const res = await limitApiRequest(handle.db, { pathname: "/api/webinar/heartbeat", ip: "192.0.2.1", registrationId: "r1" }, at(9));
    expect(res?.status).toBe(429);
    expect(res?.headers.get("retry-after")).toBeTruthy();
  });

  it("24 state polls of one registration in a minute pass, the 31st is 429", async () => {
    for (let i = 0; i < 24; i++) expect(await limitApiRequest(handle.db, { pathname: "/api/webinar/state", ip: "192.0.2.2", registrationId: "r2" }, at(i))).toBeNull();
    for (let i = 24; i < 30; i++) expect(await limitApiRequest(handle.db, { pathname: "/api/webinar/state", ip: "192.0.2.2", registrationId: "r2" }, at(i))).toBeNull();
    expect((await limitApiRequest(handle.db, { pathname: "/api/webinar/state", ip: "192.0.2.2", registrationId: "r2" }, at(31)))?.status).toBe(429);
  });

  it("public forms 20 per IP per minute; other /api routes 60", async () => {
    for (let i = 0; i < 20; i++) expect(await limitApiRequest(handle.db, { pathname: "/api/public/forms/contact/submit", ip: "192.0.2.3" }, at(i))).toBeNull();
    expect((await limitApiRequest(handle.db, { pathname: "/api/public/forms/contact/submit", ip: "192.0.2.3" }, at(21)))?.status).toBe(429);
    for (let i = 0; i < 60; i++) expect(await limitApiRequest(handle.db, { pathname: "/api/public/files/x", ip: "192.0.2.4" }, at(0))).toBeNull();
    expect((await limitApiRequest(handle.db, { pathname: "/api/public/files/x", ip: "192.0.2.4" }, at(1)))?.status).toBe(429);
  });
});
