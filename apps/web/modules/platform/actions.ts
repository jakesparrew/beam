"use server";
/**
 * Platform's Server Actions (platform spec 4.2). platform-P6: sign-in for both audiences, MFA,
 * invitations and password resets, own account, sessions, job retry and discard. platform-P8:
 * staff users, roles, settings, AI switch, flags, webhook replay, go-live gate, incidents,
 * rekey, image upload, support register, pentests and monthly reports. Every action goes
 * through `action()`; the Zod inputs stay unexported ("use server" files export functions only).
 */
import { z } from "zod";
import QRCode from "qrcode";
import { LOCALES, URL_SEGMENT } from "@beam/core/i18n";
import { NotImplementedError } from "@beam/core/errors";
import {
  canConfirmSecurity,
  GO_LIVE_CONFIRM_ROLES,
  GO_LIVE_ITEMS,
  localDateKey,
  nextPentestDueOn,
  RECOVERY_CODES_LOW,
  slaDueAt,
  SUPPORT_SEVERITIES,
  wallClock,
  type SupportCalendar,
} from "@beam/core/platform";
import {
  authSessions,
  authVerificationTokens,
  featureFlags,
  jobs,
  monthlyReports,
  roles,
  ROLE_KEYS,
  securityIncidents,
  supportRequests,
  users,
  webhookEvents,
  type MonthlyReportData,
  type RoleKey,
} from "@beam/db/schema";
import { sendTransactional } from "@/modules/email/api";
import { setPersonTester } from "@/modules/crm/api";
import { isDpiaApproved } from "@/modules/ops/api";
import { FLAGS } from "@/registry/flags.generated";
import { PERMISSIONS } from "@/registry/permissions.generated";
import type { FlagKey, SettingKey } from "@/registry/types.generated";
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
  signedInKey,
  storeTotpCounter,
  unusedCodeCount,
  useStoredRecoveryCode,
  writeMfaSecrets,
  type SessionInfo,
} from "@/lib/auth";
import { MAGIC_LINK_MINUTES } from "@/lib/auth-config";
import { AppError, ConflictError, NotFoundError, and, eq, inArray, ne, sql, writeDurably, type Ctx } from "@/lib/ctx";
import { writeAuditRow } from "@/lib/audit";
import { notifySlack } from "@/lib/alerts";
import { clearFlagCache } from "@/lib/flags";
import { MAX_FILE_BYTES, IMAGE_MIMES, storeFile } from "@/lib/files";
import { getSetting, getSettingWithVersion, setSetting } from "@/lib/settings";
import { rowsOf, sensitiveKey, setCurrentKeyVersion } from "@/lib/sensitive";
import { checkPasswordPolicy, dummyHash, hashPassword, needsRehash, verifyPassword } from "@/lib/password";
import { checkRateLimits } from "@/lib/rate-limit";
import { generateTotpSecret, totpUri, verifyTotp as checkTotp } from "@/lib/totp";
import { searchAudit } from "./queries";

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
      // PL-7: the same argon2 work as a real account, so timing does not reveal the account.
      await verifyPassword(input.password, await dummyHash());
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
    // PL-6: a step-up check counts failures like the login, so a stolen cookie cannot brute-force it.
    await assertNotLocked(ctx, session.user.id);
    const secrets = await readMfaSecrets(ctx.tx, session.user.id);
    const counter = secrets.totpSecret ? checkTotp(secrets.totpSecret, input.code, ctx.now, { afterCounter: await lastTotpCounter(ctx.tx, session.user.id) }) : null;
    if (counter === null) {
      await failLogin(ctx, { id: session.user.id, audience: "staff" }, "totp");
      throw new AppError("validation", "invalid_code", { code: "invalid_code" });
    }
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
      // PL-7, PL-13: the same argon2 work as a real account, so timing does not reveal the account.
      await verifyPassword(input.password, await dummyHash());
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
    await ctx.recordEvent({ kind: "platform.signed_in", personId: user.personId!, data: { method: "password" }, dedupeKey: signedInKey(user.id, ctx.now) });
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
    // PL-6: wrong current passwords count toward the lockout, so a hijacked session cannot brute-force it.
    await assertNotLocked(ctx, user.id);
    if (user.passwordHash && !(await verifyPassword(input.currentPassword ?? "", user.passwordHash))) {
      await failLogin(ctx, { id: user.id, audience: user.audience }, "password");
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

// ---------------------------------------------------------------------------
// platform-P8: shared helpers
// ---------------------------------------------------------------------------

const Uuid = z.string().uuid();
const RoleKeyInput = z.enum(ROLE_KEYS);
const INVITE_HOURS = 72;
const ADMIN_ROLES = GO_LIVE_CONFIRM_ROLES as readonly RoleKey[];

function staffOf(ctx: Ctx): Extract<Ctx["actor"], { kind: "staff" }> {
  if (ctx.actor.kind !== "staff") throw new AppError("unauthorized");
  return ctx.actor;
}

/** Role-bound operations (PL-16, PL-55, PL-77, PL-85, PL-89, `startRekey`). */
function requireRole(ctx: Ctx, allowed: readonly RoleKey[]): void {
  if (!allowed.includes(staffOf(ctx).roleKey)) throw new AppError("forbidden", `forbidden: role ${allowed.join("|")}`);
}

async function staffUser(ctx: Ctx, userId: string) {
  const [row] = await ctx.tx.select().from(users).where(and(eq(users.id, userId), eq(users.audience, "staff")));
  if (!row) throw new NotFoundError();
  return row;
}

/** PL-16: nobody may disable, demote or delete the last active owner. */
async function assertNotLastOwner(ctx: Ctx, userId: string): Promise<void> {
  const others = rowsOf<{ n: number }>(
    await ctx.tx.execute(sql`select count(*)::int as n from users where audience = 'staff' and role_key = 'owner' and status = 'active' and id <> ${userId}`),
  );
  if ((others[0]?.n ?? 0) === 0) throw new ConflictError("last_owner");
}

async function sendInvite(ctx: Ctx, user: { id: string; email: string; locale: (typeof LOCALES)[number]; name: string | null }): Promise<void> {
  const identifier = `staff-invite:${user.id}`;
  await ctx.tx.delete(authVerificationTokens).where(eq(authVerificationTokens.identifier, identifier));
  const { token, hashed } = await createVerificationToken(ctx.tx, identifier, minutes(INVITE_HOURS * 60), ctx.now);
  await sendTransactional(ctx, {
    template: "platform.staff_invite",
    to: user.email,
    locale: user.locale,
    data: { url: appUrl(`/admin/invite/${token}`), name: user.name ?? "", expiresHours: INVITE_HOURS },
    key: `staff_invite:${hashed}`,
  });
}

// ---------------------------------------------------------------------------
// Staff users (PL-9, PL-10, PL-16)
// ---------------------------------------------------------------------------

export const inviteStaffUser = action(
  {
    name: "users.invite",
    audience: "staff",
    permission: "users.manage",
    input: z.object({ email: Email, name: z.string().trim().min(1).max(120), roleKey: RoleKeyInput, locale: LocaleInput }),
    audit: false,
  },
  async (ctx, input): Promise<{ userId: string }> => {
    if (input.roleKey === "owner") requireRole(ctx, ["owner"]);
    if (input.roleKey === "external_partner") throw new AppError("validation", "partner_needs_person", { roleKey: "partner_needs_person" });
    if (await findUserByEmail(ctx, input.email)) throw new ConflictError("email_taken");
    const [user] = await ctx.tx
      .insert(users)
      .values({ audience: "staff", email: input.email, name: input.name, locale: input.locale, roleKey: input.roleKey, isTester: false, createdByUserId: staffOf(ctx).userId })
      .returning({ id: users.id });
    await ctx.audit({ action: "users.invite", entityType: "users", entityId: user!.id, newValue: { email: input.email, role_key: input.roleKey, locale: input.locale } });
    await sendInvite(ctx, { id: user!.id, email: input.email, locale: input.locale, name: input.name });
    return { userId: user!.id };
  },
);

export const resendInvite = action(
  { name: "users.resend_invite", audience: "staff", permission: "users.manage", input: z.object({ userId: Uuid }), audit: { entityType: "users", entityId: (i) => i.userId } },
  async (ctx, input): Promise<Record<string, never>> => {
    const user = await staffUser(ctx, input.userId);
    if (user.passwordHash || user.status !== "active") throw new ConflictError("invite_already_accepted");
    await sendInvite(ctx, user);
    return {};
  },
);

export const updateStaffUser = action(
  {
    name: "users.update",
    audience: "staff",
    permission: "users.manage",
    input: z.object({
      userId: Uuid,
      name: z.string().trim().min(1).max(120).optional(),
      locale: LocaleInput.optional(),
      roleKey: RoleKeyInput.optional(),
      isTester: z.boolean().optional(),
    }),
    audit: false,
  },
  async (ctx, input): Promise<Record<string, never>> => {
    const user = await staffUser(ctx, input.userId);
    const roleChange = input.roleKey !== undefined && input.roleKey !== user.roleKey;
    if (roleChange) {
      if (input.roleKey === "owner" || user.roleKey === "owner") requireRole(ctx, ["owner"]);
      if (input.roleKey === "external_partner" && !user.personId) throw new AppError("validation", "partner_needs_person", { roleKey: "partner_needs_person" });
      if (user.roleKey === "owner") await assertNotLastOwner(ctx, user.id);
    }
    const rest: Partial<typeof users.$inferInsert> = {};
    if (input.name !== undefined && input.name !== user.name) rest.name = input.name;
    if (input.locale !== undefined && input.locale !== user.locale) rest.locale = input.locale;
    if (input.isTester !== undefined && input.isTester !== user.isTester) rest.isTester = input.isTester;
    if (Object.keys(rest).length === 0 && !roleChange) return {};
    await ctx.tx.update(users).set(roleChange ? { ...rest, roleKey: input.roleKey } : rest).where(eq(users.id, user.id));
    if (Object.keys(rest).length) {
      await ctx.audit({ action: "users.update", entityType: "users", entityId: user.id, oldValue: { name: user.name, locale: user.locale, is_tester: user.isTester }, newValue: rest });
    }
    if (roleChange) {
      // PL-9: a role change deletes every other session of that user.
      const own = actionSession(ctx);
      await deleteUserSessions(ctx.tx, user.id, own?.user.id === user.id ? own.sessionToken : undefined);
      await ctx.audit({ action: "users.role_change", entityType: "users", entityId: user.id, oldValue: { role_key: user.roleKey }, newValue: { role_key: input.roleKey } });
    }
    return {};
  },
);

export const setUserStatus = action(
  { name: "users.set_status", audience: "staff", permission: "users.manage", input: z.object({ userId: Uuid, status: z.enum(["active", "disabled"]) }), audit: false },
  async (ctx, input): Promise<Record<string, never>> => {
    const user = await staffUser(ctx, input.userId);
    if (user.status === input.status) return {};
    if (user.roleKey === "owner") requireRole(ctx, ["owner"]);
    if (input.status === "disabled") {
      if (user.roleKey === "owner") await assertNotLastOwner(ctx, user.id);
      if (user.id === staffOf(ctx).userId) throw new ConflictError("cannot_disable_self");
    }
    await ctx.tx.update(users).set({ status: input.status }).where(eq(users.id, user.id));
    if (input.status === "disabled") await deleteUserSessions(ctx.tx, user.id);
    await ctx.audit({
      action: input.status === "disabled" ? "users.disable" : "users.enable",
      entityType: "users",
      entityId: user.id,
      oldValue: { status: user.status },
      newValue: { status: input.status },
    });
    return {};
  },
);

export const resetUserMfa = action(
  { name: "users.reset_mfa", audience: "staff", permission: "users.manage", input: z.object({ userId: Uuid, reason: z.string().trim().min(5).max(500) }), audit: false },
  async (ctx, input): Promise<Record<string, never>> => {
    const user = await staffUser(ctx, input.userId);
    if (user.roleKey === "owner" && user.id !== staffOf(ctx).userId) requireRole(ctx, ["owner"]);
    await ctx.tx.update(users).set({ totpSecretEnc: null, recoveryCodesEnc: null, secretKeyVersion: null, mfaEnrolledAt: null }).where(eq(users.id, user.id));
    await deleteUserSessions(ctx.tx, user.id);
    await ctx.audit({ action: "users.reset_mfa", entityType: "users", entityId: user.id, newValue: { reason: input.reason } });
    await notifySecurityChange(ctx, { userId: user.id, email: user.email, locale: user.locale, change: "mfa_reset", auditAction: "users.reset_mfa" });
    return {};
  },
);

export const unlockUser = action(
  { name: "users.unlock", audience: "staff", permission: "users.manage", input: z.object({ userId: Uuid }), audit: { entityType: "users", entityId: (i) => i.userId } },
  async (ctx, input): Promise<Record<string, never>> => {
    const user = await staffUser(ctx, input.userId);
    await ctx.tx.update(users).set({ failedLogins: 0, lockedUntil: null }).where(eq(users.id, user.id));
    return {};
  },
);

export const setCustomerTester = action(
  {
    name: "users.set_tester",
    audience: "staff",
    permission: "flags.manage",
    input: z.object({ personId: Uuid, isTester: z.boolean() }),
    audit: { entityType: "persons", entityId: (i) => i.personId, personId: (i) => i.personId },
  },
  async (ctx, input): Promise<Record<string, never>> => {
    await setPersonTester(ctx.tx, ctx, input);
    clearFlagCache();
    return {};
  },
);

// ---------------------------------------------------------------------------
// Roles (PL-16, PL-18)
// ---------------------------------------------------------------------------

export const updateRolePermissions = action(
  {
    name: "roles.update_permissions",
    audience: "staff",
    permission: "users.manage",
    input: z.object({ roleKey: RoleKeyInput, permissions: z.array(z.string().max(100)).max(500) }),
    audit: false,
  },
  async (ctx, input): Promise<Record<string, never>> => {
    if (input.roleKey === "owner") throw new ConflictError("owner_role_read_only");
    const known = new Set<string>(PERMISSIONS);
    const unknown = input.permissions.filter((p) => !known.has(p));
    if (unknown.length) throw new AppError("validation", "unknown_permission", { permissions: unknown.join(",") });
    const [role] = await ctx.tx.select({ permissions: roles.permissions }).from(roles).where(eq(roles.key, input.roleKey));
    if (!role) throw new NotFoundError();
    const next = [...new Set(input.permissions)].sort();
    if (next.includes("persons.sensitive_read") && !role.permissions.includes("persons.sensitive_read")) requireRole(ctx, ["owner"]);
    await ctx.tx.update(roles).set({ permissions: next, updatedByUserId: staffOf(ctx).userId }).where(eq(roles.key, input.roleKey));
    await ctx.audit({ action: "roles.update_permissions", entityType: "roles", entityId: input.roleKey, oldValue: { permissions: role.permissions }, newValue: { permissions: next } });
    return {};
  },
);

// ---------------------------------------------------------------------------
// Settings (PL-41), AI sensitive processing (PL-55), flags (PL-43)
// ---------------------------------------------------------------------------

/** Fields of `settings.ai` that only `setAiSensitiveProcessing` changes. */
const AI_SENSITIVE_FIELDS = ["sensitive_enabled", "purpose", "dpia_reference", "enabled_by_user_id", "enabled_at"] as const;
/** Keys with their own screen and rules; the generic editor refuses them. */
const DEDICATED_KEYS: readonly string[] = ["go_live_gate", "last_tick_at", "automation_cursor"];

export const updateSetting = action(
  {
    name: "settings.update",
    audience: "staff",
    permission: "settings.write",
    input: z.object({ key: z.string().regex(/^[a-z_]+$/).max(64), value: z.unknown(), expectedVersion: z.number().int().min(0) }),
    audit: false,
  },
  async (ctx, input): Promise<{ version: number }> => {
    if (DEDICATED_KEYS.includes(input.key)) throw new ConflictError("dedicated_screen");
    let value = input.value;
    if (input.key === "ai" || input.key === "security") {
      const current = (await getSetting(ctx.tx, input.key as SettingKey)) as Record<string, unknown>;
      const next = { ...(value as Record<string, unknown>) };
      // The sensitive switch (PL-55) and the key version (PL-70) have their own actions.
      const locked = input.key === "ai" ? AI_SENSITIVE_FIELDS : (["current_key_version", "last_pentest_on", "next_pentest_due_on"] as const);
      for (const f of locked) next[f] = current[f];
      value = next;
    }
    return setSetting(ctx, input.key as SettingKey, value as never, input.expectedVersion);
  },
);

export const setAiSensitiveProcessing = action(
  {
    name: "ai.set_sensitive",
    audience: "staff",
    input: z.object({ enabled: z.boolean(), purpose: z.string().trim().min(20).max(1000).optional(), dpiaReference: z.string().trim().min(3).max(200).optional() }),
    audit: false,
  },
  async (ctx, input): Promise<Record<string, never>> => {
    const { value, version } = await getSettingWithVersion(ctx.tx, "ai");
    const current = value as Record<string, unknown>;
    if (input.enabled) {
      requireRole(ctx, ["owner"]);
      if (!input.purpose) throw new AppError("validation", "purpose_required", { purpose: "too_short" });
      if (!input.dpiaReference) throw new AppError("validation", "dpia_reference_required", { dpiaReference: "required" });
      const approved = await isDpiaApproved(ctx.tx, "sensitive_assessment_processing").catch((e: unknown) => {
        if (e instanceof NotImplementedError) return false;
        throw e;
      });
      if (!approved) throw new ConflictError("dpia_not_approved");
      const next = { ...current, sensitive_enabled: true, purpose: input.purpose, dpia_reference: input.dpiaReference, enabled_by_user_id: staffOf(ctx).userId, enabled_at: ctx.now.toISOString() };
      await setSetting(ctx, "ai", next as never, version);
      await ctx.audit({ action: "ai.sensitive_enabled", entityType: "settings", entityId: "ai", newValue: { purpose: input.purpose, dpia_reference: input.dpiaReference } });
    } else {
      requireRole(ctx, ADMIN_ROLES);
      if (!current.sensitive_enabled) return {};
      await setSetting(ctx, "ai", { ...current, sensitive_enabled: false } as never, version);
      await ctx.audit({ action: "ai.sensitive_disabled", entityType: "settings", entityId: "ai", oldValue: { purpose: current.purpose, dpia_reference: current.dpia_reference } });
    }
    return {};
  },
);

export const updateFlag = action(
  {
    name: "flags.update",
    audience: "staff",
    permission: "flags.manage",
    input: z.object({ key: z.string().max(80), state: z.enum(["off", "testers", "on"]), userIds: z.array(Uuid).max(500), personIds: z.array(Uuid).max(5000) }),
    audit: false,
  },
  async (ctx, input): Promise<Record<string, never>> => {
    const def = (FLAGS as Record<string, { description?: string } | undefined>)[input.key];
    if (!def) throw new AppError("validation", "unknown_flag", { key: "unknown" });
    const key = input.key as FlagKey;
    const [old] = await ctx.tx.select().from(featureFlags).where(eq(featureFlags.key, key));
    const values = { state: input.state, userIds: [...new Set(input.userIds)], personIds: [...new Set(input.personIds)], updatedByUserId: staffOf(ctx).userId };
    await ctx.tx
      .insert(featureFlags)
      .values({ key, description: def.description ?? "", ...values })
      .onConflictDoUpdate({ target: featureFlags.key, set: { ...values, updatedAt: sql`now()` } });
    clearFlagCache();
    await ctx.audit({
      action: "flags.update",
      entityType: "feature_flags",
      entityId: key,
      oldValue: old ? { state: old.state, user_ids: old.userIds, person_ids: old.personIds } : { state: "off", user_ids: [], person_ids: [] },
      newValue: { state: values.state, user_ids: values.userIds, person_ids: values.personIds },
    });
    return {};
  },
);

// ---------------------------------------------------------------------------
// Webhook replay (PL-40)
// ---------------------------------------------------------------------------

export const replayWebhookEvent = action(
  { name: "webhooks.replay", audience: "staff", permission: "system.jobs", input: z.object({ webhookEventId: Uuid }), audit: false },
  async (ctx, input): Promise<{ jobId: string }> => {
    const [event] = await ctx.tx
      .select({ id: webhookEvents.id, provider: webhookEvents.provider, externalEventId: webhookEvents.externalEventId })
      .from(webhookEvents)
      .where(eq(webhookEvents.id, input.webhookEventId));
    if (!event) throw new NotFoundError();
    // Replays are counted from their audit rows (jobs are pruned, audit rows stay).
    const [{ n } = { n: 0 }] = rowsOf<{ n: number }>(
      await ctx.tx.execute(sql`select count(*)::int as n from audit_log where action = 'webhooks.replay' and entity_type = 'webhook_events' and entity_id = ${event.id}`),
    );
    const replay = n + 1;
    const key = `webhook:${event.provider}:${event.externalEventId}:replay:${replay}`;
    const { id } = await ctx.enqueue({ kind: "webhook.process", payload: { webhookEventId: event.id }, key, lane: "fast", priority: 2 });
    await ctx.audit({ action: "webhooks.replay", entityType: "webhook_events", entityId: event.id, newValue: { replay, job_id: id, key } });
    return { jobId: id };
  },
);

// ---------------------------------------------------------------------------
// Go-live gate (PL-77, PL-85)
// ---------------------------------------------------------------------------

const brusselsToday = (now: Date) => localDateKey(wallClock(now));

async function openCriticalOrHighIncidents(ctx: Ctx): Promise<number> {
  const [row] = rowsOf<{ n: number }>(
    await ctx.tx.execute(sql`select count(*)::int as n from security_incidents where status <> 'resolved' and severity in ('critical','high')`),
  );
  return row?.n ?? 0;
}

export const confirmGoLiveItem = action(
  {
    name: "go_live.confirm",
    audience: "staff",
    permission: "settings.write",
    input: z.object({ item: z.enum(GO_LIVE_ITEMS), confirmed: z.boolean(), note: z.string().trim().min(3).max(1000) }),
    audit: false,
  },
  async (ctx, input): Promise<Record<string, never>> => {
    requireRole(ctx, ADMIN_ROLES);
    if (input.item === "security_confirmed" && input.confirmed) {
      const security = (await getSetting(ctx.tx, "security")) as { last_pentest_on: string | null };
      const verdict = canConfirmSecurity({ lastPentestOn: security.last_pentest_on, today: brusselsToday(ctx.now), openCriticalOrHighIncidents: await openCriticalOrHighIncidents(ctx) });
      if (!verdict.ok) throw new ConflictError(verdict.reason ?? "security_not_confirmable");
    }
    const { value, version } = await getSettingWithVersion(ctx.tx, "go_live_gate");
    const gate = value;
    const old = gate.items[input.item] ?? null;
    const item = input.confirmed
      ? { confirmed_by_user_id: staffOf(ctx).userId, confirmed_at: ctx.now.toISOString(), note: input.note }
      : { confirmed_by_user_id: null, confirmed_at: null, note: input.note };
    await setSetting(ctx, "go_live_gate", { items: { ...gate.items, [input.item]: item } }, version);
    await ctx.audit({ action: "go_live.confirm", entityType: "go_live_gate", entityId: input.item, oldValue: old, newValue: item });
    return {};
  },
);

// ---------------------------------------------------------------------------
// Security incidents (PL-73, PL-73a)
// ---------------------------------------------------------------------------

const IncidentText = z.string().max(10_000);
const IncidentFields = z.object({
  title: z.string().trim().min(3).max(200),
  severity: z.enum(["critical", "high", "normal"]),
  discoveredAt: z.coerce.date(),
  beamNotifiedAt: z.coerce.date().nullable().optional(),
  systemsAffected: IncidentText.default(""),
  dataAffected: IncidentText.default(""),
  risk: IncidentText.default(""),
  actions: IncidentText.default(""),
  notifications: IncidentText.default(""),
  resolution: IncidentText.default(""),
});
type IncidentStatus = (typeof securityIncidents.$inferSelect)["status"];
const INCIDENT_TRANSITIONS: Record<IncidentStatus, readonly IncidentStatus[]> = { open: ["contained", "resolved"], contained: ["resolved"], resolved: ["open"] };

async function incidentSlack(ctx: Ctx, incident: { id: string; title: string; severity: "critical" | "high" | "normal" }): Promise<void> {
  if (incident.severity === "normal") return;
  await notifySlack(ctx, { fingerprint: `incident:${incident.id}`, severity: incident.severity, text: `Security incident (${incident.severity}): ${incident.title}. ${appUrl(`/admin/system/incidents/${incident.id}`)}` });
}

export const createIncident = action(
  { name: "incidents.create", audience: "staff", permission: "system.jobs", input: IncidentFields, audit: false },
  async (ctx, input): Promise<{ incidentId: string }> => {
    const [row] = await ctx.tx
      .insert(securityIncidents)
      .values({ ...input, beamNotifiedAt: input.beamNotifiedAt ?? null, createdByUserId: staffOf(ctx).userId })
      .returning({ id: securityIncidents.id });
    await ctx.audit({ action: "incidents.create", entityType: "security_incidents", entityId: row!.id, newValue: { title: input.title, severity: input.severity } });
    await incidentSlack(ctx, { id: row!.id, title: input.title, severity: input.severity });
    return { incidentId: row!.id };
  },
);

export const updateIncident = action(
  {
    name: "incidents.update",
    audience: "staff",
    permission: "system.jobs",
    input: IncidentFields.partial().extend({ id: Uuid, status: z.enum(["open", "contained", "resolved"]).optional(), note: z.string().trim().min(3).max(2000).optional() }),
    audit: false,
  },
  async (ctx, input): Promise<{ incidentId: string }> => {
    const [old] = await ctx.tx.select().from(securityIncidents).where(eq(securityIncidents.id, input.id)).for("update");
    if (!old) throw new NotFoundError();
    const { id, status, note, beamNotifiedAt, ...fields } = input;
    const patch: Partial<typeof securityIncidents.$inferInsert> = { ...fields };
    if (beamNotifiedAt !== undefined) {
      // PL-73a: set once, never cleared.
      if (old.beamNotifiedAt && (!beamNotifiedAt || beamNotifiedAt.getTime() !== old.beamNotifiedAt.getTime())) throw new ConflictError("beam_notified_at_fixed");
      if (!old.beamNotifiedAt && beamNotifiedAt) patch.beamNotifiedAt = beamNotifiedAt;
    }
    if (status && status !== old.status) {
      if (!INCIDENT_TRANSITIONS[old.status].includes(status)) throw new ConflictError(`invalid_transition: ${old.status} -> ${status}`);
      patch.status = status;
      if (status === "resolved") patch.resolvedAt = ctx.now;
      if (old.status === "resolved" && status === "open") {
        if (!note) throw new AppError("validation", "reopen_note_required", { note: "required" });
        patch.resolvedAt = null;
      }
    }
    if (note) patch.actions = `${patch.actions ?? old.actions}${(patch.actions ?? old.actions) ? "\n" : ""}[${ctx.now.toISOString()}] ${note}`;
    await ctx.tx.update(securityIncidents).set(patch).where(eq(securityIncidents.id, id));
    await ctx.audit({
      action: "incidents.update",
      entityType: "security_incidents",
      entityId: id,
      oldValue: { status: old.status, severity: old.severity },
      newValue: { ...patch, resolvedAt: patch.resolvedAt === undefined ? undefined : (patch.resolvedAt?.toISOString() ?? null) },
    });
    const severity = patch.severity ?? old.severity;
    if (patch.severity && patch.severity !== old.severity) await incidentSlack(ctx, { id, title: patch.title ?? old.title, severity });
    return { incidentId: id };
  },
);

// ---------------------------------------------------------------------------
// Re-encryption (PL-70)
// ---------------------------------------------------------------------------

export const startRekey = action(
  { name: "security.rekey", audience: "staff", input: z.object({ toVersion: z.number().int().min(2) }), audit: false },
  async (ctx, input): Promise<{ jobId: string }> => {
    requireRole(ctx, ["owner"]);
    const { value, version } = await getSettingWithVersion(ctx.tx, "security");
    const security = value as Record<string, unknown> & { current_key_version: number };
    if (input.toVersion !== security.current_key_version + 1) throw new ConflictError("wrong_key_version");
    if (!sensitiveKey(input.toVersion)) throw new AppError("validation", "missing_key", { toVersion: `SENSITIVE_DATA_KEY_V${input.toVersion}` });
    // New writes use the new key at once; rows still on the old version stay readable (edge 19).
    await setSetting(ctx, "security", { ...security, current_key_version: input.toVersion } as never, version);
    setCurrentKeyVersion(input.toVersion);
    const { id } = await ctx.enqueue({
      kind: "security.rekey",
      payload: { toVersion: input.toVersion, table: "person_sensitive_fields" },
      key: `rekey:${input.toVersion}:person_sensitive_fields:start`,
      lane: "bulk",
      priority: 9,
    });
    await ctx.audit({ action: "security.rekey_started", entityType: "settings", entityId: "security", oldValue: { key_version: security.current_key_version }, newValue: { key_version: input.toVersion, job_id: id } });
    return { jobId: id };
  },
);

// ---------------------------------------------------------------------------
// Image upload (site and email editors)
// ---------------------------------------------------------------------------

export const uploadImage = action(
  { name: "files.upload_image", audience: "staff", input: z.instanceof(FormData), audit: false },
  async (ctx, form): Promise<{ fileId: string; url: string }> => {
    const actor = staffOf(ctx);
    if (!actorHasPermissionAny(actor, ["site.edit", "email.write"])) throw new AppError("forbidden", "forbidden: site.edit|email.write");
    const file = form.get("file");
    if (!(file instanceof Blob)) throw new AppError("validation", "file_required", { file: "required" });
    if (file.size > MAX_FILE_BYTES) throw new AppError("validation", "file_too_large", { file: "too_large" });
    if (!(IMAGE_MIMES as readonly string[]).includes(file.type)) throw new AppError("validation", "image_type_not_allowed", { file: "type_not_allowed" });
    const name = (file as Blob & { name?: string }).name ?? "image";
    const { fileId, sha256 } = await storeFile(ctx, { kind: "image", name, mime: file.type, bytes: new Uint8Array(await file.arrayBuffer()), isPublic: true });
    await ctx.audit({ action: "files.upload_image", entityType: "files", entityId: fileId, newValue: { name, mime: file.type, size_bytes: file.size, sha256 } });
    return { fileId, url: `/api/public/files/${fileId}` };
  },
);

function actorHasPermissionAny(actor: Extract<Ctx["actor"], { kind: "staff" }>, permissions: readonly string[]): boolean {
  const held = actor.permissions as ReadonlySet<string>;
  return held.has("*") || permissions.some((p) => held.has(p));
}

// ---------------------------------------------------------------------------
// Support register (PL-86 to PL-88)
// ---------------------------------------------------------------------------

const SupportSeverity = z.enum(SUPPORT_SEVERITIES);
type SupportStatus = (typeof supportRequests.$inferSelect)["status"];
const SUPPORT_TRANSITIONS: Record<SupportStatus, readonly SupportStatus[]> = { open: ["responded", "resolved"], responded: ["resolved"], resolved: ["closed", "open"], closed: [] };
const SLACK_SEVERITY = { critical: "critical", high: "high", normal: "normal", improvement: "normal" } as const;

/** `SUP-<year>-<4 digits>`, the max of the year plus one, under a table lock (no gaps from races). */
async function nextSupportReference(ctx: Ctx, receivedAt: Date): Promise<string> {
  await ctx.tx.execute(sql`lock table support_requests in share row exclusive mode`);
  const year = wallClock(receivedAt).year;
  const prefix = `SUP-${year}-`;
  const [row] = rowsOf<{ n: number | null }>(
    await ctx.tx.execute(sql`select max(substring(reference from ${prefix.length + 1}::int)::int) as n from support_requests where reference like ${`${prefix}%`}`),
  );
  return `${prefix}${String((row?.n ?? 0) + 1).padStart(4, "0")}`;
}

async function insertSupportRequest(
  ctx: Ctx,
  input: { title: string; description: string; severity: (typeof SUPPORT_SEVERITIES)[number]; channel: (typeof supportRequests.$inferInsert)["channel"]; receivedAt: Date; reportedByUserId: string | null; pageUrl?: string | null; requestId?: string | null },
): Promise<{ id: string; reference: string }> {
  const calendar = (await getSetting(ctx.tx, "support")) as unknown as SupportCalendar;
  const reference = await nextSupportReference(ctx, input.receivedAt);
  const [row] = await ctx.tx
    .insert(supportRequests)
    .values({ ...input, reference, responseDueAt: slaDueAt(input.severity, input.receivedAt, calendar) })
    .returning({ id: supportRequests.id });
  return { id: row!.id, reference };
}

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
  async (ctx, input): Promise<{ reference: string }> => {
    const { id, reference } = await insertSupportRequest(ctx, {
      title: input.title,
      description: input.description,
      severity: input.severity,
      channel: "in_app",
      receivedAt: ctx.now,
      reportedByUserId: staffOf(ctx).userId,
      pageUrl: input.pageUrl || null,
      requestId: ctx.requestId,
    });
    await ctx.audit({ action: "support.report", entityType: "support_requests", entityId: id, newValue: { reference, severity: input.severity, page_url: input.pageUrl } });
    await notifySlack(ctx, {
      fingerprint: `support:${reference}`,
      severity: SLACK_SEVERITY[input.severity],
      text: `Support request ${reference} (${input.severity}): ${input.title}. ${appUrl("/admin/system/support")}`,
    });
    return { reference };
  },
);

export const logSupportRequest = action(
  {
    name: "support.create",
    audience: "staff",
    permission: "system.jobs",
    input: z.object({
      title: z.string().trim().min(3).max(200),
      description: z.string().max(5000).default(""),
      severity: SupportSeverity,
      channel: z.enum(["email", "slack", "whatsapp", "phone"]),
      receivedAt: z.coerce.date(),
      reportedByUserId: Uuid.optional(),
    }),
    audit: false,
  },
  async (ctx, input): Promise<{ reference: string }> => {
    if (input.receivedAt.getTime() > ctx.now.getTime() + 60_000) throw new AppError("validation", "received_in_future", { receivedAt: "in_future" });
    const { id, reference } = await insertSupportRequest(ctx, { ...input, reportedByUserId: input.reportedByUserId ?? null });
    await ctx.audit({ action: "support.create", entityType: "support_requests", entityId: id, newValue: { reference, severity: input.severity, channel: input.channel, received_at: input.receivedAt.toISOString() } });
    return { reference };
  },
);

export const updateSupportRequest = action(
  {
    name: "support.update",
    audience: "staff",
    permission: "system.jobs",
    input: z.object({
      id: Uuid,
      status: z.enum(["open", "responded", "resolved", "closed"]).optional(),
      note: z.string().trim().min(3).max(2000).optional(),
      assigneeUserId: Uuid.nullable().optional(),
      incidentId: Uuid.nullable().optional(),
    }),
    audit: false,
  },
  async (ctx, input): Promise<Record<string, never>> => {
    const [old] = await ctx.tx.select().from(supportRequests).where(eq(supportRequests.id, input.id)).for("update");
    if (!old) throw new NotFoundError();
    const patch: Partial<typeof supportRequests.$inferInsert> = {};
    if (input.status && input.status !== old.status) {
      if (!SUPPORT_TRANSITIONS[old.status].includes(input.status)) throw new ConflictError(`invalid_transition: ${old.status} -> ${input.status}`);
      if (input.status === "responded") {
        if (!input.note) throw new AppError("validation", "response_note_required", { note: "required" });
        patch.firstResponseAt = old.firstResponseAt ?? ctx.now;
      }
      if (input.status === "resolved") patch.resolvedAt = ctx.now;
      if (input.status === "open") patch.resolvedAt = null;
      patch.status = input.status;
    }
    if (input.note) patch.description = `${old.description}${old.description ? "\n" : ""}[${ctx.now.toISOString()}] ${input.note}`;
    if (input.assigneeUserId !== undefined) patch.assigneeUserId = input.assigneeUserId;
    if (input.incidentId !== undefined) patch.incidentId = input.incidentId;
    if (Object.keys(patch).length === 0) return {};
    await ctx.tx.update(supportRequests).set(patch).where(eq(supportRequests.id, old.id));
    await ctx.audit({
      action: "support.update",
      entityType: "support_requests",
      entityId: old.id,
      oldValue: { status: old.status, assignee_user_id: old.assigneeUserId, incident_id: old.incidentId },
      newValue: { status: patch.status ?? old.status, assignee_user_id: patch.assigneeUserId ?? old.assigneeUserId, incident_id: patch.incidentId ?? old.incidentId, note: input.note ?? null },
    });
    return {};
  },
);

// ---------------------------------------------------------------------------
// Audit export (`audit.export`)
// ---------------------------------------------------------------------------

const csvCell = (v: unknown) => {
  const text = v === null || v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v);
  return /[",\n\r;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
const OptionalText = z.string().trim().max(200).optional();
const OptionalDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional();

/** The filtered audit rows as CSV (at most 5,000 rows), audited with the filters used. */
export const exportAuditCsv = action(
  {
    name: "audit.export",
    audience: "staff",
    permission: "system.jobs",
    input: z.object({ actorId: OptionalText, action: OptionalText, entityType: OptionalText, entityId: OptionalText, personId: OptionalText, from: OptionalDay, to: OptionalDay }),
    audit: false,
  },
  async (ctx, input): Promise<{ csv: string; filename: string; rows: number }> => {
    const filters = Object.fromEntries(Object.entries(input).filter(([, v]) => v)) as typeof input;
    const { from, to, ...rest } = filters;
    const { rows } = await searchAudit(ctx.tx, {
      ...rest,
      ...(from ? { from: new Date(`${from}T00:00:00Z`) } : {}),
      ...(to ? { to: new Date(new Date(`${to}T00:00:00Z`).getTime() + 86_400_000) } : {}),
      limit: 5000,
    });
    const header = ["created_at", "actor_kind", "actor_id", "action", "entity_type", "entity_id", "person_id", "old_value", "new_value", "request_id"];
    const lines = rows.map((r) =>
      [r.createdAt.toISOString(), r.actor.kind, (r.actor as { id?: string | null }).id ?? "", r.action, r.entityType, r.entityId, r.personId, r.oldValue, r.newValue, r.requestId].map(csvCell).join(","),
    );
    await ctx.audit({ action: "audit.export", entityType: "audit_log", newValue: { filters, rows: rows.length } });
    return { csv: [header.join(","), ...lines].join("\r\n"), filename: `audit-${ctx.now.toISOString().slice(0, 10)}.csv`, rows: rows.length };
  },
);

// ---------------------------------------------------------------------------
// Pentests (PL-85)
// ---------------------------------------------------------------------------

export const recordPentest = action(
  {
    name: "security.record_pentest",
    audience: "staff",
    input: z.object({ testedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), summary: z.string().trim().min(10).max(2000), criticalOrHighFindings: z.number().int().min(0).max(1000) }),
    audit: false,
  },
  async (ctx, input): Promise<{ incidentId: string | null }> => {
    requireRole(ctx, ADMIN_ROLES);
    if (input.testedOn > brusselsToday(ctx.now)) throw new AppError("validation", "tested_in_future", { testedOn: "in_future" });
    const { value, version } = await getSettingWithVersion(ctx.tx, "security");
    const next = { ...(value as Record<string, unknown>), last_pentest_on: input.testedOn, next_pentest_due_on: nextPentestDueOn(input.testedOn) };
    await setSetting(ctx, "security", next as never, version);
    let incidentId: string | null = null;
    if (input.criticalOrHighFindings > 0) {
      // A critical or high finding opens an incident (PL-85); its fields are completed on the incident screen.
      const [row] = await ctx.tx
        .insert(securityIncidents)
        .values({
          title: `Pentest ${input.testedOn}: ${input.criticalOrHighFindings} critical or high finding(s)`,
          severity: "high",
          discoveredAt: ctx.now,
          systemsAffected: "",
          risk: input.summary,
          createdByUserId: staffOf(ctx).userId,
        })
        .returning({ id: securityIncidents.id });
      incidentId = row!.id;
      await incidentSlack(ctx, { id: incidentId, title: `Pentest ${input.testedOn} findings`, severity: "high" });
    }
    await ctx.audit({
      action: "security.record_pentest",
      entityType: "settings",
      entityId: "security",
      newValue: { tested_on: input.testedOn, next_due_on: next.next_pentest_due_on, critical_or_high_findings: input.criticalOrHighFindings, incident_id: incidentId },
    });
    return { incidentId };
  },
);

// ---------------------------------------------------------------------------
// Monthly SLA reports (PL-89)
// ---------------------------------------------------------------------------

async function draftReport(ctx: Ctx, id: string) {
  const [row] = await ctx.tx.select().from(monthlyReports).where(eq(monthlyReports.id, id)).for("update");
  if (!row) throw new NotFoundError();
  if (row.status === "sent") throw new ConflictError("report_sent");
  return row;
}

export const updateMonthlyReport = action(
  {
    name: "reports.monthly_update",
    audience: "staff",
    input: z.object({ id: Uuid, notes: z.string().max(10_000).optional(), uptimePct: z.number().min(0).max(100).optional() }),
    audit: false,
  },
  async (ctx, input): Promise<Record<string, never>> => {
    requireRole(ctx, ADMIN_ROLES);
    const row = await draftReport(ctx, input.id);
    const patch: Partial<typeof monthlyReports.$inferInsert> = {};
    if (input.notes !== undefined) patch.notes = input.notes;
    if (input.uptimePct !== undefined) {
      const data: MonthlyReportData = { ...row.data, uptime_pct: input.uptimePct, uptime_source: "manual" };
      patch.data = data;
    }
    if (Object.keys(patch).length === 0) return {};
    await ctx.tx.update(monthlyReports).set(patch).where(eq(monthlyReports.id, row.id));
    await ctx.audit({ action: "reports.monthly_update", entityType: "monthly_reports", entityId: row.id, oldValue: { uptime_pct: row.data.uptime_pct }, newValue: { notes_changed: input.notes !== undefined, uptime_pct: input.uptimePct ?? row.data.uptime_pct } });
    return {};
  },
);

export const sendMonthlyReport = action(
  { name: "reports.monthly_send", audience: "staff", input: z.object({ id: Uuid }), audit: false },
  async (ctx, input): Promise<{ recipients: number }> => {
    requireRole(ctx, ADMIN_ROLES);
    const row = await draftReport(ctx, input.id);
    const support = (await getSetting(ctx.tx, "support")) as { report_recipients: string[] };
    const recipients = [...new Set(support.report_recipients.map((r) => r.toLowerCase()))];
    if (recipients.length === 0) throw new ConflictError("no_report_recipients");
    const known = recipients.length
      ? await ctx.tx.select({ email: users.email, locale: users.locale }).from(users).where(and(inArray(users.email, recipients), ne(users.audience, "customer")))
      : [];
    const localeOf = new Map(known.map((u) => [u.email, u.locale]));
    await ctx.tx.update(monthlyReports).set({ status: "sent", sentAt: ctx.now, sentByUserId: staffOf(ctx).userId }).where(eq(monthlyReports.id, row.id));
    for (const to of recipients) {
      await sendTransactional(ctx, {
        template: "platform.monthly_report",
        to,
        locale: localeOf.get(to) ?? "nl-BE",
        data: { monthOn: row.monthOn, notes: row.notes, ...row.data, url: appUrl(`/admin/system/reports/${row.id}`) },
        key: `monthly_report:${row.id}:${to}`,
      });
    }
    await ctx.audit({ action: "reports.monthly_send", entityType: "monthly_reports", entityId: row.id, newValue: { month_on: row.monthOn, recipients: recipients.length } });
    return { recipients: recipients.length };
  },
);
