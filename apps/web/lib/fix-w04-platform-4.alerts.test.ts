// Review fixes of fix-w04-platform-4: both sides of the platform.check_alerts thresholds (PL-37, PL-75).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "@beam/db/testing";
import { enqueue, type DbHandle } from "@beam/db";
import { integrationCalls } from "@beam/db/schema";
import { GB, runCheckAlerts, type CheckAlertsDeps } from "./alerts";
import { sql } from "./ctx";
import type { BookingHealth } from "../modules/booking/api";
import { makeCtx, resetRuntime } from "./testing";

let handle: DbHandle;
beforeAll(async () => {
  handle = await createTestDb();
});
afterAll(async () => {
  resetRuntime();
  await handle.close();
});
beforeEach(async () => {
  await handle.db.execute(sql`set beam.allow_rewrite = 'on'`);
  for (const t of ["integration_calls", "jobs", "rate_limits", "settings"]) await handle.db.execute(sql.raw(`delete from ${t}`));
  await handle.db.execute(sql`reset beam.allow_rewrite`);
});

const ok: BookingHealth = { level: "ok", materialisedThroughOn: "2027-02-01", overdueOffers: 0, overdueReservations: 0, unsentConfirmations24h: 0 };
const deps: CheckAlertsDeps = { databaseSizeBytes: () => Promise.resolve(GB), filesSizeBytes: () => Promise.resolve(GB), bookingHealth: () => Promise.resolve(ok), appEnv: "local" };
const fingerprints = async () => (await runCheckAlerts(makeCtx(handle.db), deps)).map((r) => r.fingerprint);

describe("alert thresholds at their boundary", () => {
  it("5 webhook signature failures raise nothing, the 6th alerts", async () => {
    const row = { provider: "resend" as const, operation: "webhook.signature_failed", requestDigest: "d", statusCode: 401, ok: false, durationMs: 0 };
    await handle.db.insert(integrationCalls).values(Array.from({ length: 5 }, () => row));
    expect(await fingerprints()).not.toContain("webhook-signature-resend");
    await handle.db.insert(integrationCalls).values(row);
    expect(await fingerprints()).toContain("webhook-signature-resend");
  });

  it("9 provider failures are not down, the 10th is", async () => {
    const fail = { provider: "billit" as const, operation: "orders.create", requestDigest: "d", statusCode: 503, ok: false, durationMs: 5 };
    await handle.db.insert(integrationCalls).values(Array.from({ length: 9 }, () => fail));
    expect(await fingerprints()).not.toContain("provider-down-billit");
    await handle.db.insert(integrationCalls).values(fail);
    expect(await fingerprints()).toContain("provider-down-billit");
  });

  it("a backlog of 500 raises nothing, 501 alerts", async () => {
    for (let i = 0; i < 500; i++) await enqueue(handle.db, { kind: "jobs.prune", payload: {}, key: `bulk:${i}`, runAt: new Date(Date.now() + 3_600_000) });
    expect(await fingerprints()).not.toContain("job-backlog");
    await enqueue(handle.db, { kind: "jobs.prune", payload: {}, key: "bulk:500", runAt: new Date(Date.now() + 3_600_000) });
    expect(await fingerprints()).toContain("job-backlog");
  });
});
