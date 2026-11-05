/**
 * Host console action permissions (webinar spec section 7; webinar-P5): `launchPoll`,
 * `closePoll`, `showCta`, `hideCta` and `moderate` need `webinars.host`. Staff without it get
 * `forbidden` before anything is written; a customer is `unauthorized`; with `webinars.host` the
 * calls reach their handlers (a missing poll is `not_found`, not `forbidden`).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { roles, webinarModerationActions } from "@beam/db/schema";
import { createTestDb, makeUser } from "@beam/db/testing";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.47" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));
vi.mock("next/cache", () => ({ revalidateTag: () => undefined, unstable_cache: (fn: (...a: unknown[]) => unknown) => fn }));

const actions = await import("./actions");
const { createAuthSession, SESSION_COOKIE } = await import("@/lib/auth");
const { eq, setAppDb } = await import("@/lib/ctx");
const { resetRuntime } = await import("@/lib/testing");

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
}, 120_000);
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(() => jar.clear());

async function staffSession(perms: string[]) {
  const user = await makeUser(h.db, { roleKey: "marketing" });
  await h.db.update(roles).set({ permissions: perms }).where(eq(roles.key, "marketing"));
  const { token } = await createAuthSession(h.db, { userId: user.id, audience: "staff", roleKey: "marketing", now: new Date(), mfaAt: new Date() });
  jar.set(SESSION_COOKIE, token);
  return user;
}

const id = () => randomUUID();
type Call = [label: string, run: () => Promise<unknown>];
const calls: Call[] = [
  ["launchPoll", () => actions.launchPoll({ pollId: id() })],
  ["closePoll", () => actions.closePoll({ pollId: id() })],
  ["showCta", () => actions.showCta({ ctaId: id() })],
  ["hideCta", () => actions.hideCta({ ctaId: id() })],
  ["moderate", () => actions.moderate({ webinarId: id(), action: "mute_viewer", registrationId: id() })],
];

describe("P5 host console actions", () => {
  it.each(calls)("%s is forbidden without webinars.host", async (_label, run) => {
    await staffSession(["persons.read", "reports.read"]);
    expect(await run()).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });

  it.each(calls)("%s is unauthorized for a customer", async (_label, run) => {
    const user = await makeUser(h.db, { audience: "customer" });
    const { token } = await createAuthSession(h.db, { userId: user.id, audience: "customer", roleKey: null, now: new Date() });
    jar.set(SESSION_COOKIE, token);
    expect(await run()).toMatchObject({ ok: false, error: { code: "unauthorized" } });
  });

  it("with webinars.host the calls reach their handlers", async () => {
    await staffSession(["webinars.host"]);
    for (const [label, run] of calls) {
      const res = (await run()) as { ok: boolean; error?: { code: string } };
      expect([label, res.ok ? "ok" : res.error!.code]).toEqual([label, "not_found"]);
    }
    expect(await h.db.select().from(webinarModerationActions)).toEqual([]);
  });

  it("a message action without interactionId is a validation error", async () => {
    await staffSession(["webinars.host"]);
    expect(await actions.moderate({ webinarId: id(), action: "hide_message", registrationId: id() })).toMatchObject({ ok: false, error: { code: "validation" } });
  });
});
