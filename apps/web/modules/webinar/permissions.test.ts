/**
 * webinar action permissions (webinar spec section 7; webinar-P2): every staff action of P2 needs
 * `webinars.host`. Staff without it get `forbidden` before anything is written (sales and
 * customer service have `persons.read` and `reports.read` but not `webinars.host`); a customer
 * is `unauthorized`; with `webinars.host` the calls reach their handlers. Default holders follow
 * the architecture role table. webinar-P6 completes the file (section 7): the registration
 * actions of P3 need `webinars.host`, `registerPersonByStaff` and `revokeAccessLink` also
 * `persons.read`; `exportWebinarRegistrants` needs `persons.export` on top; `resendAccessLink`
 * works for a `customer_service` user (`persons.read` without `webinars.host`); the report query
 * refuses a user with neither `webinars.host` nor `reports.read`. The host console actions of P5
 * are in `webinar-p5.permissions.test.ts`.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { auditLog, files, roles, webinars } from "@beam/db/schema";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import { ForbiddenError } from "@beam/core/errors";
import { staffActor } from "@/lib/testing";
import { permissions } from "./permissions";
import { getWebinarReportFor } from "./queries";
import { makeRegistration, makeWebinar } from "./test/factories";

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

async function staffSession(perms: string[], roleKey: "marketing" | "customer_service" = "marketing") {
  const user = await makeUser(h.db, { roleKey });
  await h.db.update(roles).set({ permissions: perms }).where(eq(roles.key, roleKey));
  const { token } = await createAuthSession(h.db, { userId: user.id, audience: "staff", roleKey, now: new Date(), mfaAt: new Date() });
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

type Result = { ok: boolean; data?: unknown; error?: { code: string } };
const codeOf = (res: unknown) => ((res as Result).ok ? "ok" : (res as Result).error!.code);

describe("P3 registration actions (section 7)", () => {
  const p3: Call[] = [
    ["registerPersonByStaff", () => actions.registerPersonByStaff({ webinarId: id(), personId: id(), sendAccessEmail: false })],
    ["cancelRegistrationByStaff", () => actions.cancelRegistrationByStaff({ registrationId: id() })],
    ["revokeAccessLink", () => actions.revokeAccessLink({ registrationId: id() })],
  ];

  it.each(p3)("%s is forbidden without webinars.host", async (_label, run) => {
    await staffSession(["persons.read", "reports.read"]);
    expect(codeOf(await run())).toBe("forbidden");
  });

  it("registerPersonByStaff and revokeAccessLink refuse without persons.read (second check)", async () => {
    await staffSession(["webinars.host"]);
    const user = await makeUser(h.db);
    const w = await makeWebinar(h.db, { ownerUserId: user.id }, { published: true });
    const person = await makePerson(h.db);
    const r = await makeRegistration(h.db, { webinarId: w.id });
    expect(codeOf(await actions.registerPersonByStaff({ webinarId: w.id, personId: person.id, sendAccessEmail: false }))).toBe("forbidden");
    expect(codeOf(await actions.revokeAccessLink({ registrationId: r.id }))).toBe("forbidden");
    await staffSession(["webinars.host", "persons.read"]);
    expect(codeOf(await actions.registerPersonByStaff({ webinarId: w.id, personId: person.id, sendAccessEmail: false }))).toBe("ok");
  });

  it("resendAccessLink works for a customer_service user (persons.read, no webinars.host); without persons.read it is forbidden", async () => {
    const user = await makeUser(h.db);
    const w = await makeWebinar(h.db, { ownerUserId: user.id }, { published: true });
    const r = await makeRegistration(h.db, { webinarId: w.id });
    await staffSession(["persons.read"], "customer_service");
    expect(codeOf(await actions.resendAccessLink({ registrationId: r.id }))).toBe("ok");
    await staffSession(["reports.read"], "customer_service");
    expect(codeOf(await actions.resendAccessLink({ registrationId: r.id }))).toBe("forbidden");
  });
});

describe("P6 registrant export and report (rule 41, section 7)", () => {
  it("exportWebinarRegistrants is forbidden without webinars.host, and without persons.export", async () => {
    const user = await makeUser(h.db);
    const w = await makeWebinar(h.db, { ownerUserId: user.id }, { published: true });
    await staffSession(["persons.read", "persons.export", "reports.read"]);
    expect(codeOf(await actions.exportWebinarRegistrants({ webinarId: w.id }))).toBe("forbidden");
    await staffSession(["webinars.host", "persons.read"]);
    expect(codeOf(await actions.exportWebinarRegistrants({ webinarId: w.id }))).toBe("forbidden");
    const audits = await h.db.select().from(auditLog).where(eq(auditLog.entityId, w.id));
    expect(audits.filter((a) => a.action === "webinar.registrants_exported")).toEqual([]);
  });

  it("with webinars.host and persons.export it stores a 7-day export file and audits the row count", async () => {
    const user = await makeUser(h.db);
    const w = await makeWebinar(h.db, { ownerUserId: user.id }, { published: true });
    const p = await makePerson(h.db);
    await makeRegistration(h.db, { webinarId: w.id, personId: p.id });
    await staffSession(["webinars.host", "persons.export"]);
    const res = (await actions.exportWebinarRegistrants({ webinarId: w.id })) as { ok: true; data: { fileId: string } };
    expect(res.ok).toBe(true);
    const [file] = await h.db.select().from(files).where(eq(files.id, res.data.fileId));
    expect(file).toMatchObject({ kind: "export", mime: "text/csv" });
    expect(file!.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    expect(Buffer.from(file!.bytes as Uint8Array).toString("utf8")).toContain(p.email!);
    const audits = await h.db.select().from(auditLog).where(eq(auditLog.entityId, w.id));
    const exported = audits.filter((a) => a.action === "webinar.registrants_exported");
    expect(exported).toHaveLength(1);
    expect(exported[0]!.newValue).toMatchObject({ rows: 1 });
    expect(JSON.stringify(exported[0])).not.toContain(p.email!);
  });

  it("an unknown webinar is not_found once both permissions are held", async () => {
    await staffSession(["webinars.host", "persons.export"]);
    expect(codeOf(await actions.exportWebinarRegistrants({ webinarId: id() }))).toBe("not_found");
  });

  it("the report query refuses a user with neither webinars.host nor reports.read", async () => {
    const user = await makeUser(h.db);
    const w = await makeWebinar(h.db, { ownerUserId: user.id }, { published: true });
    await expect(getWebinarReportFor(staffActor({ roleKey: "reception", permissions: ["persons.read", "bookings.read"] }), h.db, w.id, { periodDays: 30 })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getWebinarReportFor(null, h.db, w.id, { periodDays: 30 })).rejects.toBeInstanceOf(ForbiddenError);
    const sales = await getWebinarReportFor(staffActor({ roleKey: "sales", permissions: ["reports.read"] }), h.db, w.id, { periodDays: 30 });
    expect(sales.totals.registrations).toBe(0);
    const host = await getWebinarReportFor(staffActor({ roleKey: "marketing", permissions: ["webinars.host"] }), h.db, w.id, { periodDays: 14 });
    expect(host.periodDays).toBe(14);
  });
});
