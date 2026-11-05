import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { roles, sessions } from "@beam/db/schema";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";

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
vi.mock("@/modules/site/api", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getCurrentLegalVersion: vi.fn().mockResolvedValue(null),
  hasAcceptedCurrentTerms: vi.fn().mockResolvedValue(true),
  recordTermsAcceptance: vi.fn(),
}));

const { cancelWebinarSession, upsertWebinarSession } = await import("./webinar");
const { bookSession, createManualBooking } = await import("../actions/bookings");
const { joinWaitlist } = await import("../actions/waitlist");
const { createAuthSession, SESSION_COOKIE } = await import("@/lib/auth");
const { eq, setAppDb } = await import("@/lib/ctx");
const { resetRuntime } = await import("@/lib/testing");
const { inTx, setBookingRules } = await import("../server/booking-p3a.fixtures");

const HOUR = 3_600_000;
const system = { kind: "system", jobId: "" } as const;
const TITLE = { "nl-BE": "Webinar slaap", "fr-BE": "Webinaire sommeil", en: "Sleep webinar" };
let h: DbHandle;

const upsert = (input: Parameters<typeof upsertWebinarSession>[2]) => inTx(h.db, system, (tx, ctx) => upsertWebinarSession(tx, ctx, input));
const cancel = (input: Parameters<typeof cancelWebinarSession>[2]) => inTx(h.db, system, (tx, ctx) => cancelWebinarSession(tx, ctx, input));
const read = async (id: string) => (await h.db.select().from(sessions).where(eq(sessions.id, id)))[0]!;
const times = (daysAhead: number) => {
  // Fractional offsets from a pinned base keep the times clear of midnight and DST edges.
  const startsAt = new Date(Date.now() + (daysAhead + 0.25) * 24 * HOUR);
  return { startsAt, endsAt: new Date(startsAt.getTime() + HOUR) };
};

beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
  await setBookingRules(h.db);
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(() => jar.clear());

describe("upsertWebinarSession (R64)", () => {
  it("creates the webinar's session once, then updates title and times", async () => {
    const webinarId = randomUUID();
    const first = await upsert({ webinarId, title: TITLE, ...times(10) });
    expect(first.created).toBe(true);
    expect(await read(first.sessionId)).toMatchObject({
      kind: "event",
      eventCategory: "webinar",
      capacitySeats: 0,
      creditKind: null,
      productId: null,
      status: "open",
      webinarId,
      publishedAt: expect.any(Date),
      title: TITLE,
    });

    const again = await upsert({ webinarId, title: TITLE, ...times(10) });
    expect(again).toEqual({ sessionId: first.sessionId, created: false });

    const moved = times(12);
    const title = { ...TITLE, en: "Sleep better webinar" };
    const updated = await upsert({ webinarId, sessionId: first.sessionId, title, ...moved });
    expect(updated).toEqual({ sessionId: first.sessionId, created: false });
    expect(await read(first.sessionId)).toMatchObject({ title, startsAt: moved.startsAt, endsAt: moved.endsAt });
    expect(await h.db.select({ id: sessions.id }).from(sessions).where(eq(sessions.webinarId, webinarId))).toHaveLength(1);
  });

  it("refuses a sessionId that is not the webinar's session with webinar_session_mismatch", async () => {
    const a = await upsert({ webinarId: randomUUID(), title: TITLE, ...times(5) });
    const webinarId = randomUUID();
    const b = await upsert({ webinarId, title: TITLE, ...times(6) });
    await expect(upsert({ webinarId, sessionId: a.sessionId, title: TITLE, ...times(6) })).rejects.toMatchObject({ code: "conflict", reason: "webinar_session_mismatch" });
    // A new webinar that claims another webinar's session is refused too.
    await expect(upsert({ webinarId: randomUUID(), sessionId: b.sessionId, title: TITLE, ...times(6) })).rejects.toMatchObject({ reason: "webinar_session_mismatch" });
    // An unknown stored id is ignored on create.
    expect((await upsert({ webinarId: randomUUID(), sessionId: randomUUID(), title: TITLE, ...times(7) })).created).toBe(true);
  });

  it("keeps webinar_id unique (one session per webinar)", async () => {
    const webinarId = randomUUID();
    await upsert({ webinarId, title: TITLE, ...times(3) });
    const t = times(3);
    await expect(
      h.db.insert(sessions).values({ kind: "event", eventCategory: "webinar", title: TITLE, startsAt: t.startsAt, endsAt: t.endsAt, capacitySeats: 0, webinarId }),
    ).rejects.toThrow();
  });

  it("refuses reversed times and an empty title as validation", async () => {
    const t = times(4);
    await expect(upsert({ webinarId: randomUUID(), title: TITLE, startsAt: t.endsAt, endsAt: t.startsAt })).rejects.toMatchObject({ code: "validation" });
    await expect(upsert({ webinarId: randomUUID(), title: {}, ...t })).rejects.toMatchObject({ code: "validation" });
  });
});

describe("cancelWebinarSession (R64, D50)", () => {
  it("cancels by webinarId, is idempotent and returns false for an unknown webinar", async () => {
    const webinarId = randomUUID();
    const { sessionId } = await upsert({ webinarId, title: TITLE, ...times(8) });
    expect(await cancel({ webinarId, reason: "speaker ill" })).toEqual({ cancelled: true });
    const row = await read(sessionId);
    expect(row).toMatchObject({ status: "cancelled", cancelReason: "speaker ill", cancelledAt: expect.any(Date) });
    expect(await cancel({ webinarId, reason: "again" })).toEqual({ cancelled: true });
    expect(await read(sessionId)).toMatchObject({ cancelReason: "speaker ill", cancelledAt: row.cancelledAt });
    expect(await cancel({ webinarId: randomUUID(), reason: "none" })).toEqual({ cancelled: false });
  });
});

describe("booking actions refuse a webinar session (R64)", () => {
  it("bookSession, joinWaitlist and createManualBooking answer conflict webinar_session", async () => {
    const { sessionId } = await upsert({ webinarId: randomUUID(), title: TITLE, ...times(9) });
    const refused = { ok: false, error: { code: "conflict", message: "webinar_session" } };

    const customer = await makeUser(h.db, { audience: "customer" });
    const c = await createAuthSession(h.db, { userId: customer.id, audience: "customer", roleKey: null, now: new Date() });
    jar.set(SESSION_COOKIE, c.token);
    expect(await bookSession({ sessionId, payWith: "free", clientKey: randomUUID() })).toMatchObject(refused);
    expect(await joinWaitlist({ sessionId })).toMatchObject(refused);

    const staff = await makeUser(h.db, { roleKey: "reception" });
    await h.db.update(roles).set({ permissions: ["bookings.read", "bookings.write", "bookings.override"] }).where(eq(roles.key, "reception"));
    const s = await createAuthSession(h.db, { userId: staff.id, audience: "staff", roleKey: "reception", now: new Date(), mfaAt: new Date() });
    jar.set(SESSION_COOKIE, s.token);
    const person = await makePerson(h.db);
    expect(await createManualBooking({ sessionId, personId: person.id, payWith: "free", reason: "test", clientKey: randomUUID() })).toMatchObject(refused);
  });
});
