// Review fixes of fix-w04-platform-4: the public files route counts the PL-68 per-IP API bucket.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestDb } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { setAppDb } from "@/lib/ctx";
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

describe("GET /api/public/files/[id] (PL-68)", () => {
  it("answers 404 for an unknown file until the IP passes 60 per minute, then 429 with Retry-After", async () => {
    const id = randomUUID();
    const call = (ip: string) =>
      GET(new Request(`http://localhost/api/public/files/${id}`, { headers: { "x-forwarded-for": ip } }), { params: Promise.resolve({ id }) });
    for (let i = 0; i < 60; i++) expect((await call("203.0.113.9")).status).toBe(404);
    const limited = await call("203.0.113.9");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    // Another IP has its own bucket.
    expect((await call("203.0.113.10")).status).toBe(404);
  });
});
