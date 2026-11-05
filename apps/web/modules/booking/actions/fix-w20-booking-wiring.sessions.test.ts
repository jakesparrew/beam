import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { sessions, ticketTypes } from "@beam/db/schema";
import { createTestDb, makeProduct, makeSession } from "@beam/db/testing";

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
  await staffSession(h.db, jar, ["bookings.read", "bookings.write", "bookings.override"]);
});

const DAY = 86_400_000;

describe("publishSession and ticket types (R50, booking-P8 request)", () => {
  it("refuses an event whose active ticket type lacks a locale, and publishes once it is complete", async () => {
    const s = await makeSession(h.db, { kind: "event", eventCategory: "lecture", title: FULL_NAME, description: null, creditKind: null, creditCost: 0, startsAt: new Date(Date.now() + 10 * DAY), publishedAt: null });
    const product = await makeProduct(h.db, { kind: "ticket", priceCents: 1500 });
    const [tt] = await h.db.insert(ticketTypes).values({ sessionId: s.id, productId: product.id, name: { "nl-BE": "Standaard", en: "Standard" } }).returning();

    expect(await actions.publishSession({ id: s.id })).toMatchObject({ ok: false, error: { code: "validation", fields: { [`ticketTypes.${tt!.id}.name.fr-BE`]: "missing" } } });
    expect((await h.db.select().from(sessions).where(eq(sessions.id, s.id)))[0]!.publishedAt).toBeNull();

    await h.db.update(ticketTypes).set({ name: { "nl-BE": "Standaard", "fr-BE": "Standard", en: "Standard" } }).where(eq(ticketTypes.id, tt!.id));
    expect(await actions.publishSession({ id: s.id })).toMatchObject({ ok: true });
    expect((await h.db.select().from(sessions).where(eq(sessions.id, s.id)))[0]!.publishedAt).not.toBeNull();
  });

  it("an inactive ticket type with a missing locale does not block publication", async () => {
    const s = await makeSession(h.db, { kind: "event", eventCategory: "concert", title: FULL_NAME, description: null, creditKind: null, creditCost: 0, startsAt: new Date(Date.now() + 11 * DAY), publishedAt: null });
    const product = await makeProduct(h.db, { kind: "ticket", priceCents: 900 });
    await h.db.insert(ticketTypes).values({ sessionId: s.id, productId: product.id, name: { en: "Old" }, isActive: false });
    expect(await actions.publishSession({ id: s.id })).toMatchObject({ ok: true });
  });
});
