/**
 * `pnpm admin:reset-mfa --email <staff email> --reason <text>` (platform spec edge case 10,
 * `docs/runbooks/access.md`).
 *
 * The break-glass path when the only owner has lost the TOTP device and every recovery code, so
 * nobody can run `resetUserMfa` in the back-office. Sidestream runs it with `DATABASE_URL_UNPOOLED`.
 * It clears the user's TOTP secret and recovery codes, deletes every session (PL-9), writes audit
 * `users.reset_mfa` with actor `system` and the reason, and queues the `platform.mfa_changed`
 * security notice to the user. The next sign-in goes through `/admin/mfa/setup`.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Db, Tx } from "@beam/db";
import { users } from "@beam/db/schema";
import { deleteUserSessions, notifySecurityChange } from "@/lib/auth";
import { and, createCtx, eq, flushDurableWrites, flushIntegrationLog, sql, type Ctx } from "@/lib/ctx";

export type ResetMfaInput = { email: string; reason: string; now?: Date };

export function parseArgs(argv: readonly string[]): ResetMfaInput {
  const get = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const email = get("email")?.trim().toLowerCase();
  const reason = get("reason")?.trim();
  if (!email || !email.includes("@") || !reason || reason.length < 5) {
    throw new Error('usage: admin-reset-mfa.ts --email <staff email> --reason "<at least 5 characters>"');
  }
  return { email, reason };
}

/** Resets MFA of one active staff user; returns the user id, or null when no such user exists. */
export async function adminResetMfa(db: Db, input: ResetMfaInput): Promise<{ userId: string; sessions: number } | null> {
  const now = input.now ?? new Date();
  const requestId = `admin-reset-mfa:${now.toISOString()}`;
  let ctx: Ctx | undefined;
  const result = await db.transaction(async (tx: Tx) => {
    const [user] = await tx
      .select({ id: users.id, email: users.email, locale: users.locale })
      .from(users)
      .where(and(sql`lower(${users.email}) = ${input.email.trim().toLowerCase()}`, eq(users.audience, "staff")));
    if (!user) return null;
    ctx = createCtx({ tx, actor: { kind: "system", jobId: requestId }, requestId, now });
    await tx.update(users).set({ totpSecretEnc: null, recoveryCodesEnc: null, secretKeyVersion: null, mfaEnrolledAt: null, failedLogins: 0, lockedUntil: null }).where(eq(users.id, user.id));
    const sessions = await deleteUserSessions(tx, user.id);
    await ctx.audit({ action: "users.reset_mfa", entityType: "users", entityId: user.id, newValue: { reason: input.reason, via: "admin-reset-mfa" } });
    await notifySecurityChange(ctx, { userId: user.id, email: user.email, locale: user.locale, change: "mfa_reset", auditAction: "users.reset_mfa" });
    return { userId: user.id, sessions };
  });
  if (ctx) {
    await flushDurableWrites(db, ctx);
    await flushIntegrationLog(db, ctx);
  }
  return result;
}

async function main(argv: string[]): Promise<number> {
  const { config } = await import("dotenv");
  config({ path: ["../../.env.local", "../../.env", ".env.local"], quiet: true });
  if (process.env.DATABASE_URL_UNPOOLED) process.env.DATABASE_URL = process.env.DATABASE_URL_UNPOOLED;
  let input: ResetMfaInput;
  try {
    input = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return 2;
  }
  const { getDbHandle } = await import("@beam/db");
  const handle = await getDbHandle();
  try {
    const result = await adminResetMfa(handle.db, input);
    if (!result) {
      console.error("admin-reset-mfa: no staff user with this email");
      return 1;
    }
    console.log(`admin-reset-mfa: MFA reset for user ${result.userId}; ${result.sessions} sessions ended`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return 1;
  } finally {
    await handle.close();
  }
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) {
  void main(process.argv.slice(2)).then((code) => process.exit(code));
}
