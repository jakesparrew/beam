import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makeUser } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { authSessions, jobs, roles } from "@beam/db/schema";

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
vi.mock("@/modules/email/api", () => ({ sendTransactional: () => Promise.resolve({ emailMessageId: "m", jobId: "j" }) }));

const actions = await import("./actions");
const { createAuthSession, SESSION_COOKIE } = await import("@/lib/auth");
const { eq, setAppDb } = await import("@/lib/ctx");
const { resetRuntime } = await import("@/lib/testing");

let handle: DbHandle;

async function asStaff(permissions: string[]) {
  const user = await makeUser(handle.db, { roleKey: "sales" });
  await handle.db.update(roles).set({ permissions }).where(eq(roles.key, "sales"));
  const { token } = await createAuthSession(handle.db, { userId: user.id, audience: "staff", roleKey: "sales", now: new Date(), mfaAt: new Date() });
  jar.set(SESSION_COOKIE, token);
  return user;
}

async function asCustomer() {
  const user = await makeUser(handle.db, { audience: "customer" });
  const { token } = await createAuthSession(handle.db, { userId: user.id, audience: "customer", roleKey: null, now: new Date() });
  jar.set(SESSION_COOKIE, token);
  return user;
}

async function deadJob(): Promise<string> {
  const [row] = await handle.db
    .insert(jobs)
    .values({ kind: "jobs.prune", payload: {}, idempotencyKey: `perm:${randomUUID()}`, status: "dead", attempts: 6, lastError: "boom", finishedAt: new Date() })
    .returning({ id: jobs.id });
  return row!.id;
}

beforeAll(async () => {
  handle = await createTestDb();
  setAppDb(handle.db);
});
afterAll(async () => {
  resetRuntime();
  await handle.close();
});
beforeEach(() => jar.clear());

const forbidden = { ok: false, error: { code: "forbidden" } };
const unauthorized = { ok: false, error: { code: "unauthorized" } };

describe("platform action permissions (PL-15)", () => {
  it("retryJob and discardJob need system.jobs", async () => {
    const id = await deadJob();
    await asStaff(["persons.read"]);
    expect(await actions.retryJob({ jobId: id })).toMatchObject(forbidden);
    expect(await actions.discardJob({ jobId: id, reason: "not needed" })).toMatchObject(forbidden);
    await asStaff(["system.jobs"]);
    expect((await actions.retryJob({ jobId: id })).ok).toBe(true);
  });

  it("revokeAllSessions needs users.manage", async () => {
    const target = await makeUser(handle.db);
    await asStaff(["system.jobs"]);
    expect(await actions.revokeAllSessions({ userId: target.id })).toMatchObject(forbidden);
    await asStaff(["users.manage"]);
    expect((await actions.revokeAllSessions({ userId: target.id })).ok).toBe(true);
  });

  it("revokeSession of another user's session needs users.manage; one's own does not", async () => {
    const other = await makeUser(handle.db);
    await createAuthSession(handle.db, { userId: other.id, audience: "staff", roleKey: "technical_admin", now: new Date(), mfaAt: new Date() });
    const [otherSession] = await handle.db.select({ id: authSessions.id }).from(authSessions).where(eq(authSessions.userId, other.id));
    const me = await asStaff([]);
    expect(await actions.revokeSession({ sessionId: otherSession!.id })).toMatchObject(forbidden);
    const mine = await createAuthSession(handle.db, { userId: me.id, audience: "staff", roleKey: "sales", now: new Date(), mfaAt: new Date() });
    const [mySession] = await handle.db.select({ id: authSessions.id }).from(authSessions).where(eq(authSessions.sessionToken, mine.token));
    expect((await actions.revokeSession({ sessionId: mySession!.id })).ok).toBe(true);
  });

  it("staff actions refuse customers and anonymous callers", async () => {
    for (const setup of [() => Promise.resolve(undefined), asCustomer]) {
      jar.clear();
      await setup();
      expect(await actions.updateMyProfile({ name: "X", locale: "en" })).toMatchObject(unauthorized);
      expect(await actions.regenerateRecoveryCodes({ code: "123456" })).toMatchObject(unauthorized);
      expect(await actions.retryJob({ jobId: randomUUID() })).toMatchObject(unauthorized);
      expect(await actions.reportProblem({ title: "Broken", description: "", severity: "normal", pageUrl: "/admin" })).toMatchObject(unauthorized);
    }
  });

  it("MFA actions refuse customers; signed-in actions refuse anonymous callers", async () => {
    await asCustomer();
    expect(await actions.verifyTotp({ code: "123456" })).toMatchObject(unauthorized);
    expect(await actions.startMfaEnrolment({})).toMatchObject(unauthorized);
    expect(await actions.confirmMfaEnrolment({ code: "123456" })).toMatchObject(unauthorized);
    expect(await actions.useRecoveryCode({ code: "abcde-fghjk" })).toMatchObject(unauthorized);
    jar.clear();
    expect(await actions.changeMyPassword({ newPassword: "Velvet-Lantern-Orbit-93!" })).toMatchObject(unauthorized);
    expect(await actions.revokeMyOtherSessions({})).toMatchObject(unauthorized);
    expect(await actions.revokeSession({ sessionId: randomUUID() })).toMatchObject(unauthorized);
  });
});
