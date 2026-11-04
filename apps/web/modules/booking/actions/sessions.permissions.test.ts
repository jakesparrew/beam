import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { auditLog } from "@beam/db/schema";
import { createTestDb, makeSession, makeUser } from "@beam/db/testing";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.10" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));

const actions = await import("./sessions");
const { createAuthSession, SESSION_COOKIE } = await import("@/lib/auth");
const { eq, setAppDb } = await import("@/lib/ctx");
const { resetRuntime } = await import("@/lib/testing");
const { FULL_NAME, clearSchedule, staffSession } = await import("./booking-p2.fixtures");

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  jar.clear();
  await clearSchedule(h.db);
});

const unauthorized = { ok: false, error: { code: "unauthorized" } };
const forbidden = (p: string) => ({ ok: false, error: { code: "forbidden", message: `forbidden: ${p}` } });

type Call = [name: string, permission: "bookings.override" | "bookings.write", run: () => Promise<unknown>];

/** Every action of the area with a valid input, and the permission it needs (booking spec 4.2). */
async function calls(): Promise<Call[]> {
  const s = await makeSession(h.db, { startsAt: new Date(Date.now() + 3 * 86_400_000), publishedAt: null });
  const create = { kind: "day", title: FULL_NAME, startsAt: "2027-04-02T10:00", durationMinutes: 120, capacitySeats: 10, creditKind: "day", creditCost: 1, publish: false };
  return [
    ["createSession", "bookings.override", () => actions.createSession(create)],
    ["updateSession", "bookings.override", () => actions.updateSession({ id: s.id, expectedUpdatedAt: s.updatedAt.toISOString(), capacitySeats: 12 })],
    ["publishSession", "bookings.override", () => actions.publishSession({ id: s.id })],
    ["setSessionOpen", "bookings.write", () => actions.setSessionOpen({ id: s.id, open: false })],
    ["upsertHold", "bookings.write", () => actions.upsertHold({ sessionId: s.id, kind: "staff", quantity: 1 })],
    ["deleteHold", "bookings.write", async () => {
      const res = (await actions.upsertHold({ sessionId: s.id, kind: "blocked", quantity: 1 })) as { ok: boolean; data?: { id: string } };
      return actions.deleteHold({ id: res.data?.id ?? "00000000-0000-4000-8000-000000000000" });
    }],
  ];
}

describe("booking actions, area sessions: permissions (booking spec 4.2, 7)", () => {
  it("every action needs a staff session", async () => {
    for (const [name, , run] of await calls()) expect(await run(), name).toMatchObject(unauthorized);
    const user = await makeUser(h.db, { audience: "customer" });
    const { token } = await createAuthSession(h.db, { userId: user.id, audience: "customer", roleKey: null, now: new Date() });
    jar.set(SESSION_COOKIE, token);
    for (const [name, , run] of await calls()) expect(await run(), name).toMatchObject(unauthorized);
  });

  it("create, update and publish need bookings.override (bookings.write is not enough)", async () => {
    await staffSession(h.db, jar, ["bookings.read", "bookings.write", "settings.write"]);
    for (const [name, permission, run] of await calls()) {
      if (permission === "bookings.override") expect(await run(), name).toMatchObject(forbidden("bookings.override"));
    }
  });

  it("open/close and holds need bookings.write (bookings.read is not enough)", async () => {
    await staffSession(h.db, jar, ["bookings.read", "settings.write"]);
    for (const [name, permission, run] of await calls()) {
      if (permission === "bookings.write") {
        if (name === "deleteHold") {
          // The hold cannot even be created without bookings.write.
          expect(await actions.deleteHold({ id: "00000000-0000-4000-8000-000000000000" }), name).toMatchObject(forbidden("bookings.write"));
        } else expect(await run(), name).toMatchObject(forbidden("bookings.write"));
      }
    }
  });

  it("with its permission every action succeeds and is audited under its name", async () => {
    await staffSession(h.db, jar, ["bookings.write", "bookings.override"]);
    for (const [name, , run] of await calls()) expect(await run(), name).toMatchObject({ ok: true });
    for (const audited of ["booking.create_session", "booking.update_session", "booking.publish_session", "booking.set_session_open", "booking.upsert_hold", "booking.delete_hold"]) {
      expect((await h.db.select().from(auditLog).where(eq(auditLog.action, audited))).length, audited).toBeGreaterThan(0);
    }
  });
});
