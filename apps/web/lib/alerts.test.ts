import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, makeUser } from "@beam/db/testing";
import { enqueue, type DbHandle } from "@beam/db";
import { aiRequests, integrationCalls, jobs, orders, securityIncidents, settings, supportRequests, webhookEvents } from "@beam/db/schema";
import { GB, runCheckAlerts, type CheckAlertsDeps } from "./alerts";
import { eq, sql } from "./ctx";
import type { BookingHealth } from "../modules/booking/api";
import { getSetting } from "./settings";
import { makeCtx, resetRuntime } from "./testing";

let handle: DbHandle;
let staffId: string;
beforeAll(async () => {
  handle = await createTestDb();
  staffId = (await makeUser(handle.db)).id;
});
afterAll(async () => {
  resetRuntime();
  await handle.close();
});
beforeEach(async () => {
  await handle.db.execute(sql`set beam.allow_rewrite = 'on'`);
  for (const t of ["integration_calls", "webhook_events", "ai_requests", "jobs", "rate_limits", "support_requests", "security_incidents", "orders", "settings"]) {
    await handle.db.execute(sql.raw(`delete from ${t}`));
  }
  await handle.db.execute(sql`reset beam.allow_rewrite`);
});

const ok: BookingHealth = { level: "ok", materialisedThroughOn: "2027-02-01", overdueOffers: 0, overdueReservations: 0, unsentConfirmations24h: 0 };
const deps = (over: CheckAlertsDeps = {}): CheckAlertsDeps => ({ databaseSizeBytes: () => Promise.resolve(GB), filesSizeBytes: () => Promise.resolve(GB), bookingHealth: () => Promise.resolve(ok), appEnv: "local", ...over });
const check = (over: CheckAlertsDeps = {}) => runCheckAlerts(makeCtx(handle.db), deps(over));
const fingerprints = async (over: CheckAlertsDeps = {}) => (await check(over)).map((r) => r.fingerprint);
const slackJobs = () => handle.db.select().from(jobs).where(eq(jobs.kind, "notify.slack"));
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

describe("platform.check_alerts (PL-75)", () => {
  it("raises nothing on a quiet system", async () => {
    expect(await fingerprints()).toEqual([]);
    expect(await slackJobs()).toHaveLength(0);
  });

  it("a backlog of 501 raises one alert; a second run in the same hour adds no Slack job", async () => {
    for (let i = 0; i < 501; i++) await enqueue(handle.db, { kind: "jobs.prune", payload: {}, key: `bulk:${i}`, runAt: new Date(Date.now() + 3_600_000) });
    expect(await fingerprints()).toEqual(["job-backlog"]);
    expect(await fingerprints()).toEqual(["job-backlog"]);
    expect(await slackJobs()).toHaveLength(1);
  });

  it("a stale tick alerts only in staging and production", async () => {
    await handle.db.insert(settings).values({ key: "last_tick_at", value: hoursAgo(1).toISOString() });
    expect(await fingerprints()).toEqual([]);
    expect(await fingerprints({ appEnv: "production" })).toEqual(["tick-stale"]);
  });

  it("6 webhook signature failures in 10 minutes alert", async () => {
    const row = { provider: "resend" as const, operation: "webhook.signature_failed", requestDigest: "d", statusCode: 401, ok: false, durationMs: 0 };
    await handle.db.insert(integrationCalls).values(Array.from({ length: 6 }, () => row));
    expect(await fingerprints()).toContain("webhook-signature-resend");
  });

  it("Mollie silence for 24 hours with a portal order is High; without orders nothing", async () => {
    expect(await fingerprints()).not.toContain("mollie-silence");
    await handle.db.insert(orders).values({ channel: "portal", subtotalCents: 1000, vatCents: 174, totalCents: 1000, locale: "nl-BE", clientKey: randomUUID() });
    const raised = await check();
    expect(raised.find((r) => r.fingerprint === "mollie-silence")?.severity).toBe("high");
    await handle.db.insert(webhookEvents).values({ provider: "mollie", externalEventId: "tr_1:1", payload: {}, jobId: randomUUID() });
    expect(await fingerprints()).not.toContain("mollie-silence");
  });

  it("a provider with 10 failures and no success in 60 minutes is down", async () => {
    const fail = { provider: "billit" as const, operation: "orders.create", requestDigest: "d", statusCode: 503, ok: false, durationMs: 5 };
    await handle.db.insert(integrationCalls).values(Array.from({ length: 10 }, () => fail));
    expect(await fingerprints()).toContain("provider-down-billit");
    await handle.db.insert(integrationCalls).values({ ...fail, ok: true, statusCode: 200 });
    expect(await fingerprints()).not.toContain("provider-down-billit");
  });

  it("database above 8 GB and files above 5 GB", async () => {
    const raised = await fingerprints({ databaseSizeBytes: () => Promise.resolve(8 * GB + 1), filesSizeBytes: () => Promise.resolve(5 * GB + 1) });
    expect(raised).toEqual(expect.arrayContaining(["database-size", "files-size"]));
    expect(await fingerprints({ filesSizeBytes: () => Promise.resolve(4 * GB + 1) })).not.toContain("files-size");
  });

  it("AI spend above 80 % alerts once per month", async () => {
    await handle.db.insert(aiRequests).values({ feature: "ai.classify", model: "claude-haiku-5-5", actor: { kind: "system", id: null }, prompt: "x", status: "ok", costCents: "8001" });
    const first = await fingerprints();
    expect(first.some((f) => f.startsWith("ai-budget-80-"))).toBe(true);
    expect((await fingerprints()).some((f) => f.startsWith("ai-budget-80-"))).toBe(false);
  });

  it("an incident without BEAM notification after 20 hours", async () => {
    await handle.db.insert(securityIncidents).values({ title: "Laptop lost", severity: "high", discoveredAt: hoursAgo(19), createdByUserId: staffId });
    expect((await fingerprints()).filter((f) => f.startsWith("incident-notify-"))).toEqual([]);
    await handle.db.insert(securityIncidents).values({ title: "Phishing", severity: "high", discoveredAt: hoursAgo(21), createdByUserId: staffId });
    expect((await fingerprints()).filter((f) => f.startsWith("incident-notify-"))).toHaveLength(1);
  });

  it("an unanswered critical support request past its due time", async () => {
    const base = { channel: "phone" as const, title: "Checkout broken", receivedAt: hoursAgo(3), responseDueAt: hoursAgo(1) };
    await handle.db.insert(supportRequests).values({ ...base, reference: "SUP-2026-0001", severity: "critical" });
    await handle.db.insert(supportRequests).values({ ...base, reference: "SUP-2026-0002", severity: "normal" });
    const raised = await fingerprints();
    expect(raised).toContain("support-breach-SUP-2026-0001");
    expect(raised).not.toContain("support-breach-SUP-2026-0002");
  });

  it("the pentest reminder from 7 days before the due date, once per day", async () => {
    const due = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    const security = await getSetting(handle.db, "security");
    await handle.db.insert(settings).values({ key: "security", value: { ...security, next_pentest_due_on: due } });
    expect(await fingerprints()).toContain("pentest-due");
    expect(await fingerprints()).not.toContain("pentest-due");
  });

  it("booking health alert raises one High alert; warn and a throwing stub raise nothing", async () => {
    const raised = await check({ bookingHealth: () => Promise.resolve({ ...ok, level: "alert" as const, overdueOffers: 12 }) });
    expect(raised).toEqual([expect.objectContaining({ fingerprint: "booking-health", severity: "high" })]);
    await check({ bookingHealth: () => Promise.resolve({ ...ok, level: "alert" as const }) });
    expect((await slackJobs()).filter((j) => j.idempotencyKey.startsWith("slack:booking-health:"))).toHaveLength(1);
    await handle.db.execute(sql`delete from jobs`);
    expect(await fingerprints({ bookingHealth: () => Promise.resolve({ ...ok, level: "warn" as const, overdueOffers: 1 }) })).toEqual([]);
    expect(await fingerprints({ bookingHealth: undefined })).toEqual([]);
    expect(await slackJobs()).toHaveLength(0);
  });
});
