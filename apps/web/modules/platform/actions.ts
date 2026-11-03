"use server";
/**
 * Platform's Server Actions owned by platform-P6 (platform spec 4.2): sign-in for both
 * audiences, MFA, invitations and password resets, own account, sessions, job retry and
 * discard, and the `reportProblem` stub that platform-P8 implements. Every action goes
 * through `action()`; the Zod inputs stay unexported ("use server" files export functions only).
 */
import { z } from "zod";
import QRCode from "qrcode";
import { LOCALES, URL_SEGMENT } from "@beam/core/i18n";
import { NotImplementedError } from "@beam/core/errors";
import { RECOVERY_CODES_LOW } from "@beam/core/platform";
import { authSessions, jobs, users } from "@beam/db/schema";
import { sendTransactional } from "@/modules/email/api";
import { action, actionSession } from "@/lib/action";
import {
  appUrl,
  clearSessionCookie,
  consumeVerificationToken,
  createAuthSession,
  createVerificationToken,
  deleteSessionByToken,
  deleteUserSessions,
  invalidCredentials,
  isLocked,
  lastTotpCounter,
  newRecoveryCodes,
  notifySecurityChange,
  readMfaSecrets,
  readSessionToken,
  recordFailedLogin,
  recordSuccessfulLogin,
  requestMeta,
  safeReturnTo,
  setSessionCookie,
  storeTotpCounter,
  unusedCodeCount,
  useStoredRecoveryCode,
  writeMfaSecrets,
  type SessionInfo,
} from "@/lib/auth";
import { MAGIC_LINK_MINUTES } from "@/lib/auth-config";
import { AppError, ConflictError, NotFoundError, eq, sql, writeDurably, type Ctx } from "@/lib/ctx";
import { writeAuditRow } from "@/lib/audit";
import { rowsOf } from "@/lib/sensitive";
import { checkPasswordPolicy, hashPassword, needsRehash, verifyPassword } from "@/lib/password";
import { checkRateLimits } from "@/lib/rate-limit";
import { generateTotpSecret, totpUri, verifyTotp as checkTotp } from "@/lib/totp";

const Email = z.string().trim().toLowerCase().email().max(254);
const LocaleInput = z.enum(LOCALES);
const Password = z.string().min(1).max(256);
const ReturnTo = z.string().max(500).optional();

const minutes = (n: number) => n * 60_000;

/** The session of a `staff_pending_mfa` action (the audience guarantees a staff session). */
function pendingSession(ctx: Ctx): SessionInfo {
  const session = actionSession(ctx);
  if (!session || session.audience !== "staff") throw new AppError("unauthorized");
  return session;
}

/** Audit as the signed-in staff user (the actor of a pending-MFA action is not staff yet). */
async function auditAsUser(ctx: Ctx, session: SessionInfo, action: string, newValue?: unknown): Promise<void> {
  await writeAuditRow(
    ctx.tx,
    { actor: { kind: "staff", id: session.user.id, roleKey: session.user.roleKey ?? undefined }, requestId: ctx.requestId, ip: ctx.ip },
    { action, entityType: "users", entityId: session.user.id, newValue },
  );
}

async function findUserByEmail(ctx: Ctx, email: string) {
  const [row] = await ctx.tx.select().from(users).where(sql`lower(${users.email}) = ${email}`);
  return row ?? null;
}

async function failLogin(ctx: Ctx, user: { id: string; audience: "staff" | "customer" }, reason: "password" | "totp" | "recovery_code"): Promise<void> {
  await writeDurably(ctx, async (db) => {
    await recordFailedLogin(db, { userId: user.id, audience: user.audience, now: ctx.now, requestId: ctx.requestId, ip: ctx.ip, reason });
  });
}

async function lockedError(ctx: Ctx, userId: string): Promise<AppError> {
  const [row] = await ctx.tx.select({ lockedUntil: users.lockedUntil }).from(users).where(eq(users.id, userId));
  return new AppError("unauthorized", "locked", { locked_until: (row?.lockedUntil ?? ctx.now).toISOString() });
}

// ---------------------------------------------------------------------------
// Staff sign-in (PL-3 to PL-7, DR-11)
// ---------------------------------------------------------------------------

export const staffSignIn = action(
  {
    name: "auth.staff_sign_in",
    audience: "public",
    input: z.object({ email: Email, password: Password }),
    audit: false,
    rateLimit: (i, { ip }) => ({ route: "login", ip, email: i.email }),
  },
  async (ctx, input): Promise<{ next: "/admin/mfa/verify" | "/admin/mfa/setup" }> => {
    const user = await findUserByEmail(ctx, input.email);
    if (!user || user.audience !== "staff" || user.status !== "active") {
      await verifyPassword(input.password, null);
      throw invalidCredentials();
    }
    const ok = await verifyPassword(input.password, user.passwordHash);
    if (!ok) {
      await failLogin(ctx, { id: user.id, audience: "staff" }, "password");
      throw invalidCredentials();
    }
    // PL-7: the locked state is shown only after a correct password.
    if (isLocked(user, ctx.now)) throw await lockedError(ctx, user.id);
    if (user.passwordHash && needsRehash(user.passwordHash)) {
      await ctx.tx.update(users).set({ passwordHash: await hashPassword(input.password) }).where(eq(users.id, user.id));
    }
    const meta = await requestMeta();
    const { token, expires } = await createAuthSession(ctx.tx, { userId: user.id, audience: "staff", roleKey: user.roleKey, now: ctx.now, ip: ctx.ip, userAgent: meta.userAgent });
    await setSessionCookie(token, expires);
    return { next: user.mfaEnrolledAt ? "/admin/mfa/verify" : "/admin/mfa/setup" };
  },
);

/** Shared second step: marks the session MFA-complete, resets counters and audits the login. */
async function completeStaffLogin(ctx: Ctx, session: SessionInfo): Promise<void> {
  await ctx.tx.update(authSessions).set({ mfaAt: ctx.now }).where(eq(authSessions.id, session.sessionId));
  await recordSuccessfulLogin(ctx.tx, session.user.id, ctx.now);
  await auditAsUser(ctx, session, "auth.staff_login");
}

async function assertNotLocked(ctx: Ctx, userId: string): Promise<void> {
  const [row] = await ctx.tx.select({ lockedUntil: users.lockedUntil }).from(users).where(eq(users.id, userId));
  if (row && isLocked(row, ctx.now)) throw await lockedError(ctx, userId);
}

export const verifyTotp = action(
  { name: "auth.verify_totp", audience: "staff_pending_mfa", input: z.object({ code: z.string().trim().regex(/^\d{6}$/), returnTo: ReturnTo }), audit: false },
  async (ctx, input): Promise<{ next: string }> => {
    const session = pendingSession(ctx);
    await assertNotLocked(ctx, session.user.id);
    const { totpSecret } = await readMfaSecrets(ctx.tx, session.user.id);
    if (!totpSecret || !session.user.mfaEnrolledAt) throw new AppError("conflict", "mfa_not_enrolled");
    const counter = checkTotp(totpSecret, input.code, ctx.now, { afterCounter: await lastTotpCounter(ctx.tx, session.user.id) });
    if (counter === null) {
      await failLogin(ctx, { id: session.user.id, audience: "staff" }, "totp");
      throw new AppError("validation", "invalid_code", { code: "invalid_code" });
    }
    await storeTotpCounter(ctx.tx, session.user.id, counter);
    await completeStaffLogin(ctx, session);
    return { next: safeReturnTo(input.returnTo, "/admin") };
  },
);

export const useRecoveryCode = action(
  { name: "auth.use_recovery_code", audience: "staff_pending_mfa", input: z.object({ code: z.string().trim().min(10).max(20), returnTo: ReturnTo }), audit: false },
  async (ctx, input): Promise<{ next: string; codesLeft: number; lowOnCodes: boolean }> => {
    const session = pendingSession(ctx);
    await assertNotLocked(ctx, session.user.id);
    const secrets = await readMfaSecrets(ctx.tx, session.user.id);
    const updated = await useStoredRecoveryCode(input.code, secrets.codes, ctx.now);
    if (!updated) {
      await failLogin(ctx, { id: session.user.id, audience: "staff" }, "recovery_code");
      throw new AppError("validation", "invalid_code", { code: "invalid_code" });
    }
    await writeMfaSecrets(ctx.tx, session.user.id, { ...secrets, codes: updated });
    const left = unusedCodeCount(updated);
    await auditAsUser(ctx, session, "auth.recovery_code_used", { codes_left: left });
    await completeStaffLogin(ctx, session);
    return { next: safeReturnTo(input.returnTo, "/admin"), codesLeft: left, lowOnCodes: left <= RECOVERY_CODES_LOW };
  },
);

export const startMfaEnrolment = action(
  { name: "auth.start_mfa", audience: "staff_pending_mfa", input: z.object({}), audit: false },
  async (ctx): Promise<{ otpauthUri: string; qrSvg: string }> => {
    const session = pendingSession(ctx);
    if (session.user.mfaEnrolledAt) throw new AppError("conflict", "mfa_already_enrolled");
    const secrets = await readMfaSecrets(ctx.tx, session.user.id);
    const secret = secrets.totpSecret ?? generateTotpSecret();
    if (!secrets.totpSecret) await writeMfaSecrets(ctx.tx, session.user.id, { totpSecret: secret, codes: [] });
    const otpauthUri = totpUri(secret, session.user.email);
    return { otpauthUri, qrSvg: await QRCode.toString(otpauthUri, { type: "svg", margin: 1, width: 220 }) };
  },
);

export const confirmMfaEnrolment = action(
  { name: "auth.confirm_mfa", audience: "staff_pending_mfa", input: z.object({ code: z.string().trim().regex(/^\d{6}$/) }), audit: false },
  async (ctx, input): Promise<{ recoveryCodes: string[] }> => {
    const session = pendingSession(ctx);
    if (session.user.mfaEnrolledAt) throw new AppError("conflict", "mfa_already_enrolled");
    await assertNotLocked(ctx, session.user.id);
    const { totpSecret } = await readMfaSecrets(ctx.tx, session.user.id);
    if (!totpSecret) throw new AppError("conflict", "mfa_not_started");
    const counter = checkTotp(totpSecret, input.code, ctx.now);
    if (counter === null) {
      await failLogin(ctx, { id: session.user.id, audience: "staff" }, "totp");
      throw new AppError("validation", "invalid_code", { code: "invalid_code" });
    }
    const { codes, stored } = await newRecoveryCodes();
    await writeMfaSecrets(ctx.tx, session.user.id, { totpSecret, codes: stored }, { mfaEnrolledAt: ctx.now });
    await storeTotpCounter(ctx.tx, session.user.id, counter);
    await auditAsUser(ctx, session, "auth.mfa_enrolled");
    await completeStaffLogin(ctx, session);
    return { recoveryCodes: codes };
  },
);

export const regenerateRecoveryCodes = action(
  { name: "auth.regenerate_recovery_codes", audience: "staff", input: z.object({ code: z.string().trim().regex(/^\d{6}$/) }), audit: false },
  async (ctx, input): Promise<{ recoveryCodes: string[] }> => {
    const session = pendingSession(ctx);
    const secrets = await readMfaSecrets(ctx.tx, session.user.id);
    const counter = secrets.totpSecret ? checkTotp(secrets.totpSecret, input.code, ctx.now, { afterCounter: await lastTotpCounter(ctx.tx, session.user.id) }) : null;
    if (counter === null) throw new AppError("validation", "invalid_code", { code: "invalid_code" });
    await storeTotpCounter(ctx.tx, session.user.id, counter);
    const { codes, stored } = await newRecoveryCodes();
    await writeMfaSecrets(ctx.tx, session.user.id, { ...secrets, codes: stored });
    await ctx.audit({ action: "auth.recovery_codes_regenerated", entityType: "users", entityId: session.user.id });
    await notifySecurityChange(ctx, { userId: session.user.id, email: session.user.email, locale: session.user.locale, change: "recovery_codes_regenerated", auditAction: "auth.recovery_codes_regenerated" });
    return { recoveryCodes: codes };
  },
);

// ---------------------------------------------------------------------------
// Customer sign-in (PL-11 to PL-13)
// ---------------------------------------------------------------------------

/**
 * PL-11: always answers `{ sent: true }`. Within the limit of 5 per address per hour it
 * creates the verification token (hashed as Auth.js stores it) and sends `platform.magic_link`
 * through `email.sendTransactional` (a job). The link opens the confirmation page, whose
 * button submits to the Auth.js Email callback. Staff addresses get nothing (PL-12).
 */
export const requestMagicLink = action(
  { name: "auth.request_magic_link", audience: "public", input: z.object({ email: Email, locale: LocaleInput, returnTo: ReturnTo }), audit: false },
  async (ctx, input): Promise<{ sent: true }> => {
    const verdict = await checkRateLimits(ctx.tx, { route: "magic_link", email: input.email }, ctx.now);
    if (!verdict.ok) return { sent: true };
    const existing = await findUserByEmail(ctx, input.email);
    if (existing && (existing.audience === "staff" || existing.status !== "active")) return { sent: true };
    const seg = URL_SEGMENT[input.locale];
    const { token, hashed } = await createVerificationToken(ctx.tx, input.email, minutes(MAGIC_LINK_MINUTES), ctx.now);
    const callbackUrl = safeReturnTo(input.returnTo, `/${seg}/account`);
    const params = new URLSearchParams({ token, email: input.email, callbackUrl });
    await sendTransactional(ctx, {
      template: "platform.magic_link",
      to: input.email,
      ...(existing?.personId ? { personId: existing.personId } : {}),
      locale: existing?.locale ?? input.locale,
      data: { url: appUrl(`/${seg}/account/login/verify?${params.toString()}`), expiresMinutes: MAGIC_LINK_MINUTES },
      key: `magic_link:${hashed}`,
    });
    return { sent: true };
  },
);

export const customerPasswordSignIn = action(
  {
    name: "auth.customer_password_sign_in",
    audience: "public",
    input: z.object({ email: Email, password: Password, locale: LocaleInput, returnTo: ReturnTo }),
    audit: false,
    rateLimit: (i, { ip }) => ({ route: "login", ip, email: i.email }),
  },
  async (ctx, input): Promise<{ next: string }> => {
    const user = await findUserByEmail(ctx, input.email);
    if (!user || user.audience !== "customer" || user.status !== "active" || !user.passwordHash) {
      await verifyPassword(input.password, null);
      throw invalidCredentials();
    }
    if (!(await verifyPassword(input.password, user.passwordHash))) {
      await failLogin(ctx, { id: user.id, audience: "customer" }, "password");
      throw invalidCredentials();
    }
    if (isLocked(user, ctx.now)) throw await lockedError(ctx, user.id);
    if (needsRehash(user.passwordHash)) {
      await ctx.tx.update(users).set({ passwordHash: await hashPassword(input.password) }).where(eq(users.id, user.id));
    }
    const meta = await requestMeta();
    const { token, expires } = await createAuthSession(ctx.tx, { userId: user.id, audience: "customer", roleKey: null, now: ctx.now, ip: ctx.ip, userAgent: meta.userAgent });
    await recordSuccessfulLogin(ctx.tx, user.id, ctx.now);
    const day = ctx.now.toISOString().slice(0, 10);
    await ctx.recordEvent({ kind: "platform.signed_in", personId: user.personId!, data: { method: "password" }, dedupeKey: `signed_in:${user.id}:${day}` });
    await setSessionCookie(token, expires);
    return { next: safeReturnTo(input.returnTo, `/${URL_SEGMENT[input.locale]}/account`) };
  },
);

// ---------------------------------------------------------------------------
// Invitations and password resets (PL-10)
// ---------------------------------------------------------------------------

async function assertPolicy(password: string, audience: "staff" | "customer", email: string): Promise<void> {
  const policy = await checkPasswordPolicy(password, { audience, email });
  if (!policy.ok) throw new AppError("validation", "password_policy", { password: policy.reasons.join(",") });
}

export const acceptInvite = action(
  { name: "auth.accept_invite", audience: "public", input: z.object({ token: z.string().min(20).max(200), password: Password }), audit: false },
  async (ctx, input): Promise<{ next: "/admin/mfa/setup" }> => {
    const identifier = await consumeVerificationToken(ctx.tx, "staff-invite:", input.token, ctx.now);
    const userId = identifier?.slice("staff-invite:".length);
    const [user] = userId ? await ctx.tx.select().from(users).where(eq(users.id, userId)) : [];
    if (!user || user.audience !== "staff" || user.status !== "active") throw new NotFoundError("invite_invalid");
    await assertPolicy(input.password, "staff", user.email);
    await ctx.tx.update(users).set({ passwordHash: await hashPassword(input.password), passwordChangedAt: ctx.now, emailVerified: ctx.now }).where(eq(users.id, user.id));
    await writeAuditRow(ctx.tx, { actor: { kind: "staff", id: user.id, roleKey: user.roleKey ?? undefined }, requestId: ctx.requestId, ip: ctx.ip }, { action: "users.invite_accepted", entityType: "users", entityId: user.id });
    const meta = await requestMeta();
    const { token, expires } = await createAuthSession(ctx.tx, { userId: user.id, audience: "staff", roleKey: user.roleKey, now: ctx.now, ip: ctx.ip, userAgent: meta.userAgent });
    await setSessionCookie(token, expires);
    return { next: "/admin/mfa/setup" };
  },
);

/** Always `{ sent: true }`. Staff get a 1-hour reset link; customers get a link to their security page. */
export const requestPasswordReset = action(
  { name: "auth.request_password_reset", audience: "public", input: z.object({ email: Email, audience: z.enum(["staff", "customer"]), locale: LocaleInput.optional() }), audit: false },
  async (ctx, input): Promise<{ sent: true }> => {
    const verdict = await checkRateLimits(ctx.tx, { route: "magic_link", email: input.email }, ctx.now);
    if (!verdict.ok) return { sent: true };
    const user = await findUserByEmail(ctx, input.email);
    if (!user || user.audience !== input.audience || user.status !== "active") return { sent: true };
    const identifier = `password-reset:${user.id}`;
    await ctx.tx.execute(sql`delete from auth_verification_tokens where identifier = ${identifier}`);
    const { token, hashed } = await createVerificationToken(ctx.tx, identifier, minutes(60), ctx.now);
    const url = input.audience === "staff" ? appUrl(`/admin/reset-password/${token}`) : appUrl(`/${URL_SEGMENT[user.locale]}/account/security`);
    await sendTransactional(ctx, {
      template: "platform.password_reset",
      to: user.email,
      locale: user.locale,
      data: { url, expiresMinutes: 60 },
      key: `password_reset:${hashed}`,
    });
    return { sent: true };
  },
);

export const resetPassword = action(
  { name: "auth.reset_password", audience: "public", input: z.object({ token: z.string().min(20).max(200), password: Password }), audit: false },
  async (ctx, input): Promise<{ next: string }> => {
    const identifier = await consumeVerificationToken(ctx.tx, "password-reset:", input.token, ctx.now);
    const userId = identifier?.slice("password-reset:".length);
    const [user] = userId ? await ctx.tx.select().from(users).where(eq(users.id, userId)) : [];
    if (!user || user.status !== "active") throw new NotFoundError("reset_invalid");
    await assertPolicy(input.password, user.audience, user.email);
    await ctx.tx
      .update(users)
      .set({ passwordHash: await hashPassword(input.password), passwordChangedAt: ctx.now, failedLogins: 0, lockedUntil: null })
      .where(eq(users.id, user.id));
    await deleteUserSessions(ctx.tx, user.id);
    await writeAuditRow(ctx.tx, { actor: { kind: user.audience, id: user.id }, requestId: ctx.requestId, ip: ctx.ip }, { action: "auth.password_reset", entityType: "users", entityId: user.id });
    if (user.audience === "staff") {
      await notifySecurityChange(ctx, { userId: user.id, email: user.email, locale: user.locale, change: "password_reset", auditAction: "auth.password_reset" });
    }
    return { next: user.audience === "staff" ? "/admin/login" : `/${URL_SEGMENT[user.locale]}/account/login` };
  },
);

// ---------------------------------------------------------------------------
// Own account and sessions (PL-9)
// ---------------------------------------------------------------------------

export const changeMyPassword = action(
  { name: "auth.change_password", audience: "any_signed_in", input: z.object({ currentPassword: Password.optional(), newPassword: Password }), audit: false },
  async (ctx, input): Promise<Record<string, never>> => {
    const session = actionSession(ctx)!;
    const [user] = await ctx.tx.select().from(users).where(eq(users.id, session.user.id));
    if (!user) throw new AppError("unauthorized");
    if (user.passwordHash && !(await verifyPassword(input.currentPassword ?? "", user.passwordHash))) {
      throw new AppError("validation", "wrong_password", { currentPassword: "wrong_password" });
    }
    await assertPolicy(input.newPassword, user.audience, user.email);
    await ctx.tx.update(users).set({ passwordHash: await hashPassword(input.newPassword), passwordChangedAt: ctx.now }).where(eq(users.id, user.id));
    await deleteUserSessions(ctx.tx, user.id, session.sessionToken);
    if (user.audience === "staff") {
      await ctx.audit({ action: "auth.password_changed", entityType: "users", entityId: user.id });
      await notifySecurityChange(ctx, { userId: user.id, email: user.email, locale: user.locale, change: "password_changed", auditAction: "auth.password_changed" });
    } else if (user.personId) {
      await ctx.recordEvent({ kind: "platform.password_set", personId: user.personId, data: {} });
    }
    return {};
  },
);

/** Deletes the current session row and cookie (PL-9). A pending-MFA staff session may sign out too. */
export const signOut = action(
  { name: "auth.sign_out", audience: "public", input: z.object({}), audit: false },
  async (ctx): Promise<{ next: string }> => {
    const session = actionSession(ctx);
    const token = session?.sessionToken ?? (await readSessionToken());
    if (token) await deleteSessionByToken(ctx.tx, token);
    await clearSessionCookie();
    return { next: session?.audience === "customer" ? `/${URL_SEGMENT[session.user.locale]}/account/login` : "/admin/login" };
  },
);

export const updateMyProfile = action(
  { name: "users.update_self", audience: "staff", input: z.object({ name: z.string().trim().min(1).max(120), locale: LocaleInput }), audit: "users" },
  async (ctx, input): Promise<Record<string, never>> => {
    const session = actionSession(ctx)!;
    await ctx.tx.update(users).set({ name: input.name, locale: input.locale }).where(eq(users.id, session.user.id));
    await ctx.audit({ action: "users.update_self", entityType: "users", entityId: session.user.id, newValue: input });
    return {};
  },
);

/** Own sessions for everyone; another user's session needs `users.manage`. */
export const revokeSession = action(
  { name: "sessions.revoke", audience: "any_signed_in", input: z.object({ sessionId: z.string().uuid() }), audit: false },
  async (ctx, input): Promise<Record<string, never>> => {
    const session = actionSession(ctx)!;
    const [row] = await ctx.tx.select({ userId: authSessions.userId }).from(authSessions).where(eq(authSessions.id, input.sessionId));
    if (!row) throw new NotFoundError();
    if (row.userId !== session.user.id) ctx.require("users.manage");
    await ctx.tx.delete(authSessions).where(eq(authSessions.id, input.sessionId));
    if (ctx.actor.kind === "staff") await ctx.audit({ action: "auth.session_revoked", entityType: "users", entityId: row.userId, newValue: { session_id: input.sessionId } });
    return {};
  },
);

export const revokeAllSessions = action(
  { name: "sessions.revoke_all", audience: "staff", permission: "users.manage", input: z.object({ userId: z.string().uuid() }), audit: false },
  async (ctx, input): Promise<{ count: number }> => {
    const count = await deleteUserSessions(ctx.tx, input.userId);
    await ctx.audit({ action: "auth.session_revoked", entityType: "users", entityId: input.userId, newValue: { all: true, count } });
    return { count };
  },
);

/** Sign out on all other devices (customer security page and staff account page). */
export const revokeMyOtherSessions = action(
  { name: "sessions.revoke_own", audience: "any_signed_in", input: z.object({}), audit: false },
  async (ctx): Promise<{ count: number }> => {
    const session = actionSession(ctx)!;
    const count = await deleteUserSessions(ctx.tx, session.user.id, session.sessionToken);
    if (ctx.actor.kind === "staff") await ctx.audit({ action: "auth.session_revoked", entityType: "users", entityId: session.user.id, newValue: { others: true, count } });
    return { count };
  },
);

// ---------------------------------------------------------------------------
// Jobs (PL-29a) and the support stub
// ---------------------------------------------------------------------------

export const retryJob = action(
  { name: "jobs.retry", audience: "staff", permission: "system.jobs", input: z.object({ jobId: z.string().uuid() }), audit: { entityType: "jobs", entityId: (i) => i.jobId } },
  async (ctx, input): Promise<Record<string, never>> => {
    const updated = rowsOf<{ id: string }>(
      await ctx.tx.execute(sql`
        update jobs set status = 'pending', run_at = now(), max_attempts = attempts + 3, locked_at = null, locked_by = null,
          result = case when result is null then null else result - 'on_dead_at' end, updated_at = now()
        where id = ${input.jobId} and status = 'dead' returning id`),
    );
    if (updated.length === 0) {
      const [exists] = await ctx.tx.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, input.jobId));
      throw exists ? new ConflictError("job_not_dead") : new NotFoundError();
    }
    return {};
  },
);

export const discardJob = action(
  { name: "jobs.discard", audience: "staff", permission: "system.jobs", input: z.object({ jobId: z.string().uuid(), reason: z.string().trim().min(3).max(500) }), audit: false },
  async (ctx, input): Promise<Record<string, never>> => {
    const [job] = await ctx.tx
      .select({ id: jobs.id, kind: jobs.kind, key: jobs.idempotencyKey, status: jobs.status, lastError: jobs.lastError })
      .from(jobs)
      .where(eq(jobs.id, input.jobId));
    if (!job) throw new NotFoundError();
    if (job.status !== "dead") throw new ConflictError("job_not_dead");
    await ctx.tx.delete(jobs).where(eq(jobs.id, input.jobId));
    await ctx.audit({ action: "jobs.discard", entityType: "jobs", entityId: job.id, oldValue: { kind: job.kind, key: job.key, last_error: job.lastError }, newValue: { reason: input.reason } });
    return {};
  },
);

/** PL-86. Final signature; platform-P8 implements the handler (support register and Slack). */
export const reportProblem = action(
  {
    name: "support.report",
    audience: "staff",
    input: z.object({
      title: z.string().trim().min(3).max(200),
      description: z.string().max(5000),
      severity: z.enum(["critical", "high", "normal", "improvement"]),
      pageUrl: z.string().max(2000),
    }),
    audit: false,
  },
  (): Promise<{ reference: string }> => Promise.reject(new NotImplementedError("platform.reportProblem")),
);
