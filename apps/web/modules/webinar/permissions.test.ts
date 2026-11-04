/**
 * webinar action permissions (webinar spec section 7; webinar-P2): every staff action of P2 needs
 * `webinars.host`. Staff without it get `forbidden` before anything is written (sales and
 * customer service have `persons.read` and `reports.read` but not `webinars.host`); a customer
 * is `unauthorized`; with `webinars.host` the calls reach their handlers. Default holders follow
 * the architecture role table. Later packages add their own actions here.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { roles, webinars } from "@beam/db/schema";
import { createTestDb, makeUser } from "@beam/db/testing";
import { permissions } from "./permissions";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.46" })),
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
const text = { "nl-BE": "Tekst", "fr-BE": "Texte", en: "Text" };
const options = [
  { key: "a", label: text },
  { key: "b", label: text },
];

type Call = [label: string, run: () => Promise<unknown>];
const calls: Call[] = [
  ["createWebinar", () => actions.createWebinar({ slug: `perm-${id().slice(0, 8)}`, mode: "live", title: text, locales: ["nl-BE"], spokenLocale: "nl-BE", plannedDurationMinutes: 60, ownerUserId: id() })],
  ["updateWebinar", () => actions.updateWebinar({ webinarId: id(), version: 1, plannedDurationMinutes: 45 })],
  ["publishWebinar", () => actions.publishWebinar({ webinarId: id(), version: 1 })],
  ["cancelWebinar", () => actions.cancelWebinar({ webinarId: id(), reason: "Speaker ill", notify: true })],
  ["archiveWebinar", () => actions.archiveWebinar({ webinarId: id() })],
  ["duplicateWebinar", () => actions.duplicateWebinar({ webinarId: id(), startsAt: [new Date(Date.now() + 86_400_000).toISOString()] })],
  ["setWebinarVideo", () => actions.setWebinarVideo({ webinarId: id(), field: "recording_video_id", videoId: "dQw4w9WgXcQ" })],
  ["upsertPoll", () => actions.upsertPoll({ webinarId: id(), key: "q1", question: text, options })],
  ["deletePoll", () => actions.deletePoll({ pollId: id() })],
  ["upsertCta", () => actions.upsertCta({ webinarId: id(), key: "c1", label: text, url: "https://beam.example.com/book" })],
  ["deleteCta", () => actions.deleteCta({ ctaId: id() })],
  ["upsertPresenter", () => actions.upsertPresenter({ webinarId: id(), email: "presenter@example.com", displayName: "Guest" })],
  ["removePresenter", () => actions.removePresenter({ presenterId: id() })],
  ["forceLiveState", () => actions.forceLiveState({ webinarId: id(), to: "live" })],
];

describe("webinar declares its permission", () => {
  it("has webinars.host", () => {
    expect(permissions).toContain("webinars.host");
  });
});

describe("P2 actions", () => {
  it.each(calls)("%s is forbidden without webinars.host (customer service: persons.read, reports.read)", async (_label, run) => {
    await staffSession(["persons.read", "reports.read", "bookings.read"]);
    expect(await run()).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });

  it.each(calls)("%s is unauthorized for a customer", async (_label, run) => {
    const user = await makeUser(h.db, { audience: "customer" });
    const { token } = await createAuthSession(h.db, { userId: user.id, audience: "customer", roleKey: null, now: new Date() });
    jar.set(SESSION_COOKIE, token);
    expect(await run()).toMatchObject({ ok: false, error: { code: "unauthorized" } });
  });

  it("nothing was written by the refused calls", async () => {
    const rows = await h.db.select().from(webinars);
    expect(rows.filter((r) => r.slug.startsWith("perm-"))).toEqual([]);
  });

  it("with webinars.host the same calls reach their handlers", async () => {
    await staffSession(["webinars.host"]);
    for (const [label, run] of calls) {
      const res = (await run()) as { ok: boolean; error?: { code: string } };
      expect([label, res.ok ? "ok" : res.error!.code]).not.toEqual([label, "forbidden"]);
    }
  });

  it("creates a draft with webinars.host and audits it as webinar.created", async () => {
    const user = await staffSession(["webinars.host"]);
    const res = await actions.createWebinar({
      slug: `ok-${id().slice(0, 8)}`,
      mode: "on_demand",
      title: text,
      locales: ["nl-BE", "fr-BE", "en"],
      spokenLocale: "nl-BE",
      plannedDurationMinutes: 30,
      ownerUserId: user.id,
    });
    expect(res).toMatchObject({ ok: true });
    const webinarId = (res as { ok: true; data: { webinarId: string } }).data.webinarId;
    const { auditLog } = await import("@beam/db/schema");
    const audits = await h.db.select().from(auditLog).where(eq(auditLog.entityId, webinarId));
    expect(audits.map((a) => a.action)).toEqual(["webinar.created"]);
  });
});
