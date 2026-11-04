import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { createTestDb, makeUser } from "@beam/db/testing";

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

const actions = await import("./templates");
const { createAuthSession, SESSION_COOKIE } = await import("@/lib/auth");
const { setAppDb } = await import("@/lib/ctx");
const { resetRuntime } = await import("@/lib/testing");
const { FULL_NAME, clearSchedule, makeTemplate, staffSession } = await import("./booking-p2.fixtures");

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

const forbidden = { ok: false, error: { code: "forbidden", message: "forbidden: settings.write" } };
const unauthorized = { ok: false, error: { code: "unauthorized" } };

async function asCustomer() {
  const user = await makeUser(h.db, { audience: "customer" });
  const { token } = await createAuthSession(h.db, { userId: user.id, audience: "customer", roleKey: null, now: new Date() });
  jar.set(SESSION_COOKIE, token);
}

/** Every template and exception action with a valid input (booking spec 4.2: `settings.write`). */
async function calls(): Promise<Array<[string, () => Promise<unknown>]>> {
  const t = await makeTemplate(h.db);
  const create = { kind: "day", name: FULL_NAME, weekdays: [2], startTimes: ["09:00"], durationMinutes: 120, capacitySeats: 12, creditKind: "day", creditCost: 1, isMemberOnly: false, activeFromOn: "2027-01-01" };
  const exception = { onDate: "2027-03-02", kind: "closed", name: FULL_NAME };
  return [
    ["createTemplates", () => actions.createTemplates(create)],
    ["updateTemplate", () => actions.updateTemplate({ id: t.id, expectedVersion: 1, capacitySeats: 10 })],
    ["setTemplateActive", () => actions.setTemplateActive({ id: t.id, isActive: false })],
    ["upsertException", () => actions.upsertException(exception)],
    ["deleteException", () => actions.deleteException({ id: randomUUID() })],
  ];
}

describe("booking actions, area templates: permissions (booking spec 4.2, 7)", () => {
  it("every action needs a staff session", async () => {
    for (const [name, call] of await calls()) expect(await call(), name).toMatchObject(unauthorized);
    await asCustomer();
    for (const [name, call] of await calls()) expect(await call(), name).toMatchObject(unauthorized);
  });

  it("every action denies a staff user without settings.write (bookings.* is not enough)", async () => {
    await staffSession(h.db, jar, ["bookings.read", "bookings.write", "bookings.override", "waitlist.manage"]);
    for (const [name, call] of await calls()) expect(await call(), name).toMatchObject(forbidden);
  });

  it("settings.write is enough for every action", async () => {
    await staffSession(h.db, jar, ["settings.write"]);
    const results = await calls();
    for (const [name, call] of results) {
      const res = (await call()) as { ok: boolean; error?: { code: string } };
      // deleteException of an unknown id passes the permission check and answers not_found.
      if (name === "deleteException") expect(res, name).toMatchObject({ ok: false, error: { code: "not_found" } });
      else expect(res, name).toMatchObject({ ok: true });
    }
  });
});
