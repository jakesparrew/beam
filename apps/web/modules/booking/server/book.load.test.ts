/**
 * Load test (tag `load`, booking spec edge case 32): 200 concurrent booking attempts on the last
 * 20 seats of one session against `beam_dev` through `neon-ws`. Exactly 20 are confirmed, the
 * other 180 get `session_full`, and the p95 latency of an attempt stays under 1 s. It runs only
 * when `BEAM_LOAD_TEST=1` and `DATABASE_DRIVER=neon-ws` (the `e2e.yml` job); on PGlite, which has
 * one connection and no real concurrency, it is skipped.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDbHandle, type DbHandle } from "@beam/db";
import { bookings, sessions } from "@beam/db/schema";
import { makePerson } from "@beam/db/testing";
import { eq } from "@/lib/ctx";
import { resetRuntime } from "@/lib/testing";
import { bookSeats } from "./book";
import { customerActor, inTx, openSession } from "./booking-p3a.fixtures";

vi.mock("@/modules/site/api", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getCurrentLegalVersion: vi.fn().mockResolvedValue(null),
  hasAcceptedCurrentTerms: vi.fn().mockResolvedValue(true),
  recordTermsAcceptance: vi.fn(),
}));

const enabled = process.env.BEAM_LOAD_TEST === "1" && process.env.DATABASE_DRIVER === "neon-ws" && !!process.env.DATABASE_URL;
const ATTEMPTS = 200;
const SEATS = 20;

describe.skipIf(!enabled)("[load] booking burst on the last seats", () => {
  let h: DbHandle;
  let sessionId: string;

  beforeAll(async () => {
    h = await createDbHandle("neon-ws");
    const session = await openSession(h.db, { capacitySeats: SEATS, creditKind: null, creditCost: 0, title: { "nl-BE": "Loadtest", "fr-BE": "Test de charge", en: "Load test" } });
    sessionId = session.id;
  }, 60_000);

  afterAll(async () => {
    if (h && sessionId) {
      await h.db.update(bookings).set({ status: "cancelled", cancelledAt: new Date(), cancelReasonCode: "staff" }).where(eq(bookings.sessionId, sessionId));
      await h.db.update(sessions).set({ status: "cancelled", cancelledAt: new Date(), cancelReason: "load test" }).where(eq(sessions.id, sessionId));
    }
    resetRuntime();
    await h?.close();
  });

  it(`${ATTEMPTS} concurrent attempts on ${SEATS} seats: exactly ${SEATS} confirmed, p95 under 1 s`, async () => {
    const people = await Promise.all(Array.from({ length: ATTEMPTS }, () => makePerson(h.db, { email: `load-${randomUUID()}@demo.beam.be` })));
    const latencies: number[] = [];
    const results = await Promise.allSettled(
      people.map(async (p) => {
        const started = performance.now();
        try {
          return await inTx(h.db, customerActor(p.id), (tx, ctx) =>
            bookSeats(tx, ctx, { sessionId, personId: p.id, payWith: "free", clientKey: randomUUID(), source: "portal", by: "customer", sendEmail: false }),
          );
        } finally {
          latencies.push(performance.now() - started);
        }
      }),
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(SEATS);
    expect(failed.every((r) => (r.reason as { reason?: string }).reason === "session_full")).toBe(true);
    const confirmed = await h.db.select({ id: bookings.id }).from(bookings).where(eq(bookings.sessionId, sessionId));
    expect(confirmed).toHaveLength(SEATS);
    latencies.sort((a, b) => a - b);
    const p95 = latencies[Math.ceil(latencies.length * 0.95) - 1]!;
    expect(p95).toBeLessThan(1_000);
  }, 120_000);
});
