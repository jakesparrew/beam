// Review fixes of fix-w09-platform-review: `meta` and `webhook` call-log entries are written
// (requests of automation-P3 and platform-P9).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { integrationCalls, integrationCallsProvider } from "@beam/db/schema";
import { INTEGRATION_PROVIDERS, type IntegrationCallEntry } from "@beam/integrations/_shared";
import { writeIntegrationCalls } from "./ctx";

let handle: DbHandle;
beforeAll(async () => {
  handle = await createTestDb();
});
afterAll(() => handle.close());

const entry = (provider: IntegrationCallEntry["provider"], operation: string): IntegrationCallEntry => ({
  provider,
  operation,
  requestDigest: "d".repeat(16),
  statusCode: 200,
  ok: true,
  durationMs: 12.4,
  error: null,
});

describe("integration_calls providers", () => {
  it("INTEGRATION_PROVIDERS lists exactly the integration_calls_provider enum values", () => {
    expect([...INTEGRATION_PROVIDERS]).toEqual(integrationCallsProvider.enumValues);
  });

  it("writes meta and webhook entries and still drops an unknown provider", async () => {
    await writeIntegrationCalls(
      handle.db,
      [
        entry("meta", "messages.send"),
        entry("webhook", "webhook.post"),
        { ...entry("meta", "x"), provider: "carrier_pigeon" as IntegrationCallEntry["provider"] },
      ],
      null,
    );
    const rows = await handle.db.select().from(integrationCalls);
    expect(rows.map((r) => [r.provider, r.operation]).sort()).toEqual([
      ["meta", "messages.send"],
      ["webhook", "webhook.post"],
    ]);
    expect(rows.every((r) => r.durationMs === 12)).toBe(true);
  });
});
