import { describe, expect, it } from "vitest";
import { IntegrationError, type IntegrationCallEntry } from "../_shared";
import { createBetterstackClient } from "./client";
import { createBetterstackFake, FAKE_AVAILABILITY_PCT } from "./fake";

describe("createBetterstackFake", () => {
  it("returns 99.95 % availability and 0 incidents for a month by default", async () => {
    const fake = createBetterstackFake();
    const sla = await fake.getMonitorSla({ monitorId: "123", from: "2026-10-01", to: "2026-10-31" });
    expect(FAKE_AVAILABILITY_PCT).toBe(99.95);
    expect(sla).toEqual({ availabilityPct: 99.95, downtimeSeconds: 1339, incidents: 0 });
    expect(fake.calls).toEqual([{ operation: "monitors.sla", input: { monitorId: "123", from: "2026-10-01", to: "2026-10-31" }, at: expect.any(Date) }]);
  });

  it("skips the heartbeat and only counts it", async () => {
    const fake = createBetterstackFake();
    expect(await fake.pingHeartbeat("https://uptime.betterstack.com/api/v1/heartbeat/fake")).toBe(true);
    expect(fake.heartbeats).toBe(1);
  });

  it("can be told other figures and to fail (the report job retries, then manual entry)", async () => {
    const entries: IntegrationCallEntry[] = [];
    const fake = createBetterstackFake({ onCall: (e) => void entries.push(e) });
    fake.setSla({ availabilityPct: 99.2, incidents: 2, downtimeSeconds: 21_427 });
    expect(await fake.getMonitorSla({ monitorId: "1", from: new Date("2026-10-01T00:00:00Z"), to: new Date("2026-10-31T00:00:00Z") })).toEqual({
      availabilityPct: 99.2,
      downtimeSeconds: 21_427,
      incidents: 2,
    });
    fake.failNext(503);
    const error = await fake.getMonitorSla({ monitorId: "1", from: "2026-10-01", to: "2026-10-31" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IntegrationError);
    expect(error).toMatchObject({ provider: "betterstack", retryable: true, statusCode: 503 });
    expect(entries.map((e) => e.ok)).toEqual([true, false]);
    fake.reset();
    expect((await fake.getMonitorSla({ monitorId: "1", from: "2026-10-01", to: "2026-10-01" })).availabilityPct).toBe(99.95);
  });
});

describe("createBetterstackClient (injected fetch, no network)", () => {
  it("reads the SLA endpoint with a bearer token and validates the body", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const client = createBetterstackClient({
      apiToken: "fake-token",
      fetch: (url, init) => {
        seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
        return Promise.resolve(Response.json({ data: { id: "1", type: "monitor_sla", attributes: { availability: 99.987, total_downtime: 348.4, number_of_incidents: 1 } } }));
      },
    });
    const sla = await client.getMonitorSla({ monitorId: "42", from: "2026-10-01", to: "2026-10-31" });
    expect(sla).toEqual({ availabilityPct: 99.987, downtimeSeconds: 348, incidents: 1 });
    expect(seen[0]).toEqual({ url: "https://uptime.betterstack.com/api/v2/monitors/42/sla?from=2026-10-01&to=2026-10-31", auth: "Bearer fake-token" });
  });

  it("maps 401 to permanent, 500 to retryable, a bad body to permanent; the heartbeat never throws", async () => {
    const status = (s: number) => createBetterstackClient({ apiToken: "x", fetch: () => Promise.resolve(new Response("no", { status: s })) });
    await expect(status(401).getMonitorSla({ monitorId: "1", from: "2026-10-01", to: "2026-10-31" })).rejects.toMatchObject({ retryable: false, statusCode: 401 });
    await expect(status(500).getMonitorSla({ monitorId: "1", from: "2026-10-01", to: "2026-10-31" })).rejects.toMatchObject({ retryable: true });
    const bad = createBetterstackClient({ apiToken: "x", fetch: () => Promise.resolve(Response.json({ nope: true })) });
    await expect(bad.getMonitorSla({ monitorId: "1", from: "2026-10-01", to: "2026-10-31" })).rejects.toMatchObject({ code: "invalid_response" });
    expect(await status(500).pingHeartbeat("https://example.com/hb")).toBe(false);
  });
});
