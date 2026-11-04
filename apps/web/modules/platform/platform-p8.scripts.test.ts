import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, ensureRole, makeUser } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { auditLog, authSessions, users } from "@beam/db/schema";

process.env.SENSITIVE_DATA_KEY_V1 ??= randomBytes(32).toString("base64");
process.env.AUTH_SECRET = "platform-p8-scripts-test-secret";

vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve({ get: () => undefined, set: () => undefined, delete: () => undefined }),
  headers: () => Promise.resolve(new Headers()),
}));
vi.mock("next/server", () => ({ after: () => undefined }));
const sent: { template: string; to?: string; key: string }[] = [];
vi.mock("@/modules/email/api", () => ({
  sendTransactional: (_ctx: unknown, input: { template: string; to?: string; key: string }) => {
    sent.push(input);
    return Promise.resolve({ emailMessageId: "m", jobId: "j" });
  },
}));

const recordBackupScript = await import("@/scripts/record-backup");
const resetMfaScript = await import("@/scripts/admin-reset-mfa");
const auth = await import("@/lib/auth");
const { eq, setAppDb } = await import("@/lib/ctx");
const { getSetting } = await import("@/lib/settings");
const { resetRuntime } = await import("@/lib/testing");

let handle: DbHandle;

beforeAll(async () => {
  handle = await createTestDb();
  setAppDb(handle.db);
  await ensureRole(handle.db, "owner");
});
afterAll(async () => {
  resetRuntime();
  await handle.close();
});

describe("record-backup.ts (PL-78, PL-89)", () => {
  it("parses its arguments and refuses anything else", () => {
    expect(recordBackupScript.parseArgs(["--kind", "backup", "--ok", "true", "--note", "run 42"])).toEqual({ kind: "backup", ok: true, note: "run 42" });
    expect(recordBackupScript.parseArgs(["--kind", "restore_drill", "--ok", "false"])).toEqual({ kind: "restore_drill", ok: false });
    expect(() => recordBackupScript.parseArgs(["--kind", "dump", "--ok", "true"])).toThrow(/usage/);
    expect(() => recordBackupScript.parseArgs(["--kind", "backup"])).toThrow(/usage/);
  });

  it("writes settings.security and the audit rows the monthly report counts", async () => {
    const at = new Date("2026-11-03T02:41:00Z");
    await recordBackupScript.recordBackup(handle.db, { kind: "backup", ok: true, note: "run 1", now: at });
    await recordBackupScript.recordBackup(handle.db, { kind: "restore_drill", ok: false, now: new Date("2026-11-03T06:00:00Z") });
    const security = (await getSetting(handle.db, "security")) as Record<string, unknown>;
    expect(security).toMatchObject({ last_backup_at: at.toISOString(), last_backup_ok: true, last_restore_drill_at: "2026-11-03T06:00:00.000Z", last_restore_drill_ok: false });
    const backups = await handle.db.select().from(auditLog).where(eq(auditLog.action, "backup.completed"));
    expect(backups).toHaveLength(1);
    expect(backups[0]!.newValue).toEqual({ ok: true, note: "run 1" });
    expect(backups[0]!.actor).toMatchObject({ kind: "job" });
    expect(await handle.db.select().from(auditLog).where(eq(auditLog.action, "restore_drill.completed"))).toHaveLength(1);
  });
});

describe("admin-reset-mfa.ts (edge case 10)", () => {
  it("requires an email and a reason", () => {
    expect(resetMfaScript.parseArgs(["--email", "Owner@Example.com", "--reason", "Lost phone"])).toEqual({ email: "owner@example.com", reason: "Lost phone" });
    expect(() => resetMfaScript.parseArgs(["--email", "owner@example.com", "--reason", "no"])).toThrow(/usage/);
  });

  it("clears MFA, unlocks, ends every session, audits with the system actor and sends the notice", async () => {
    const owner = await makeUser(handle.db, { roleKey: "owner" });
    await handle.db.update(users).set({ mfaEnrolledAt: new Date(), failedLogins: 10, lockedUntil: new Date(Date.now() + 600_000) }).where(eq(users.id, owner.id));
    await auth.createAuthSession(handle.db, { userId: owner.id, audience: "staff", roleKey: "owner", now: new Date(), mfaAt: new Date() });
    const result = await resetMfaScript.adminResetMfa(handle.db, { email: owner.email.toUpperCase(), reason: "Lost phone, confirmed by phone call" });
    expect(result).toEqual({ userId: owner.id, sessions: 1 });
    const [row] = await handle.db.select().from(users).where(eq(users.id, owner.id));
    expect(row).toMatchObject({ mfaEnrolledAt: null, totpSecretEnc: null, recoveryCodesEnc: null, failedLogins: 0, lockedUntil: null });
    expect(await handle.db.select().from(authSessions).where(eq(authSessions.userId, owner.id))).toHaveLength(0);
    const [audit] = await handle.db.select().from(auditLog).where(eq(auditLog.action, "users.reset_mfa"));
    expect(audit).toMatchObject({ entityId: owner.id, newValue: { reason: "Lost phone, confirmed by phone call", via: "admin-reset-mfa" } });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ template: "platform.mfa_changed", to: owner.email });
    expect(sent[0]!.key).toBe(`security_notice:${owner.id}:${audit!.id}`);
    expect(await resetMfaScript.adminResetMfa(handle.db, { email: "nobody@example.com", reason: "no such user" })).toBeNull();
  });
});
