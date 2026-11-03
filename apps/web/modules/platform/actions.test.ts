import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makeUser } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { auditLog, authSessions, authVerificationTokens, jobs, users } from "@beam/db/schema";

process.env.SENSITIVE_DATA_KEY_V1 ??= randomBytes(32).toString("base64");
process.env.AUTH_SECRET = "actions-test-secret";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.20" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));
const sent: { template: string; to?: string; key: string; data: Record<string, unknown> }[] = [];
vi.mock("@/modules/email/api", () => ({
  sendTransactional: (_ctx: unknown, input: { template: string; to?: string; key: string; data: Record<string, unknown> }) => {
    sent.push(input);
    return Promise.resolve({ emailMessageId: "m", jobId: "j" });
  },
}));

const actions = await import("./actions");
const auth = await import("@/lib/auth");
const { and, eq, setAppDb } = await import("@/lib/ctx");
const { verifyPassword } = await import("@/lib/password");
const { resetRuntime } = await import("@/lib/testing");

let handle: DbHandle;
const NEW_PASSWORD = "Copper-Meadow-Lantern-47?";

async function signInOwner() {
  const user = await makeUser(handle.db, { roleKey: "owner" });
  const { token } = await auth.createAuthSession(handle.db, { userId: user.id, audience: "staff", roleKey: "owner", now: new Date(), mfaAt: new Date() });
  jar.set(auth.SESSION_COOKIE, token);
  return user;
}

async function job(status: "dead" | "succeeded", result: unknown = null) {
  const [row] = await handle.db
    .insert(jobs)
    .values({ kind: "jobs.prune", payload: {}, idempotencyKey: `actions:${randomUUID()}`, status, attempts: 6, maxAttempts: 6, lastError: "boom", result, finishedAt: new Date() })
    .returning();
  return row!;
}

beforeAll(async () => {
  handle = await createTestDb();
  setAppDb(handle.db);
});
afterAll(async () => {
  resetRuntime();
  await handle.close();
});
beforeEach(() => {
  jar.clear();
  sent.length = 0;
});

describe("retryJob and discardJob", () => {
  it("puts a dead job back to pending with 3 more attempts and clears on_dead_at (PL-29a)", async () => {
    await signInOwner();
    const dead = await job("dead", { on_dead_at: "2026-11-03T10:00:00Z", note: "kept" });
    expect(await actions.retryJob({ jobId: dead.id })).toEqual({ ok: true, data: {} });
    const [row] = await handle.db.select().from(jobs).where(eq(jobs.id, dead.id));
    expect(row).toMatchObject({ status: "pending", maxAttempts: 9, result: { note: "kept" } });
    expect(await handle.db.select().from(auditLog).where(and(eq(auditLog.action, "jobs.retry"), eq(auditLog.entityId, dead.id)))).toHaveLength(1);
  });

  it("refuses jobs that are not dead and unknown ids", async () => {
    await signInOwner();
    const done = await job("succeeded");
    expect(await actions.retryJob({ jobId: done.id })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(await actions.discardJob({ jobId: done.id, reason: "cleanup" })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(await actions.retryJob({ jobId: randomUUID() })).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("deletes a dead job and audits kind, key and last error", async () => {
    await signInOwner();
    const dead = await job("dead");
    expect(await actions.discardJob({ jobId: dead.id, reason: "duplicate import" })).toEqual({ ok: true, data: {} });
    expect(await handle.db.select().from(jobs).where(eq(jobs.id, dead.id))).toHaveLength(0);
    const [row] = await handle.db.select().from(auditLog).where(and(eq(auditLog.action, "jobs.discard"), eq(auditLog.entityId, dead.id)));
    expect(row).toMatchObject({ oldValue: { kind: "jobs.prune", key: dead.idempotencyKey, last_error: "boom" }, newValue: { reason: "duplicate import" } });
  });
});

describe("invitations and password resets (PL-10)", () => {
  it("accepts an invite once, sets the password and opens an MFA-pending session", async () => {
    const user = await makeUser(handle.db, { roleKey: "sales", mfaEnrolledAt: null });
    const { token } = await auth.createVerificationToken(handle.db, `staff-invite:${user.id}`, 72 * 3600_000, new Date());
    expect(await actions.acceptInvite({ token, password: NEW_PASSWORD })).toEqual({ ok: true, data: { next: "/admin/mfa/setup" } });
    const [row] = await handle.db.select().from(users).where(eq(users.id, user.id));
    expect(await verifyPassword(NEW_PASSWORD, row!.passwordHash)).toBe(true);
    const session = await auth.loadSession(handle.db, jar.get(auth.SESSION_COOKIE)!);
    expect(session).toMatchObject({ audience: "staff", mfaAt: null });
    jar.clear();
    expect(await actions.acceptInvite({ token, password: NEW_PASSWORD })).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("refuses an expired invite and a weak password", async () => {
    const user = await makeUser(handle.db, { roleKey: "sales" });
    const expired = await auth.createVerificationToken(handle.db, `staff-invite:${user.id}`, -1000, new Date());
    expect(await actions.acceptInvite({ token: expired.token, password: NEW_PASSWORD })).toMatchObject({ ok: false, error: { code: "not_found" } });
    const fresh = await auth.createVerificationToken(handle.db, `staff-invite:${user.id}`, 3600_000, new Date());
    expect(await actions.acceptInvite({ token: fresh.token, password: "short" })).toMatchObject({ ok: false, error: { code: "validation", message: "password_policy" } });
  });

  it("always answers sent, emails a 1-hour reset link, and resets once while deleting sessions", async () => {
    const user = await makeUser(handle.db, { roleKey: "finance" });
    await auth.createAuthSession(handle.db, { userId: user.id, audience: "staff", roleKey: "finance", now: new Date(), mfaAt: new Date() });
    expect(await actions.requestPasswordReset({ email: "nobody@example.com", audience: "staff" })).toEqual({ ok: true, data: { sent: true } });
    expect(sent).toHaveLength(0);
    expect(await actions.requestPasswordReset({ email: user.email, audience: "staff" })).toEqual({ ok: true, data: { sent: true } });
    expect(sent[0]).toMatchObject({ template: "platform.password_reset", to: user.email, data: { expiresMinutes: 60 } });
    const token = new URL(sent[0]!.data.url as string).pathname.split("/").pop()!;
    const [stored] = await handle.db.select().from(authVerificationTokens).where(eq(authVerificationTokens.identifier, `password-reset:${user.id}`));
    expect(stored!.expires.getTime() - Date.now()).toBeGreaterThan(59 * 60_000);

    expect(await actions.resetPassword({ token, password: NEW_PASSWORD })).toEqual({ ok: true, data: { next: "/admin/login" } });
    expect(await handle.db.select().from(authSessions).where(eq(authSessions.userId, user.id))).toHaveLength(0);
    expect(sent.at(-1)).toMatchObject({ template: "platform.mfa_changed", data: { change: "password_reset" } });
    expect(await actions.resetPassword({ token, password: NEW_PASSWORD })).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
});

describe("own profile and the support stub", () => {
  it("updates the own name and locale with one audit row", async () => {
    const user = await signInOwner();
    expect(await actions.updateMyProfile({ name: "New Name", locale: "fr-BE" })).toEqual({ ok: true, data: {} });
    const [row] = await handle.db.select().from(users).where(eq(users.id, user.id));
    expect(row).toMatchObject({ name: "New Name", locale: "fr-BE" });
    expect(await handle.db.select().from(auditLog).where(and(eq(auditLog.action, "users.update_self"), eq(auditLog.entityId, user.id)))).toHaveLength(1);
  });

  it("keeps reportProblem's final signature until platform-P8 implements it", async () => {
    await signInOwner();
    expect(await actions.reportProblem({ title: "x", description: "", severity: "normal", pageUrl: "/admin" })).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(await actions.reportProblem({ title: "Checkout fails", description: "", severity: "high", pageUrl: "/admin" })).toMatchObject({ ok: false, error: { code: "internal" } });
  });
});
