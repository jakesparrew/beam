/**
 * Sessions, guards and the sign-in building blocks (PL-3 to PL-14, runbook DR-11).
 *
 * A session is an `auth_sessions` row named by the `SESSION_COOKIE` (32 random bytes,
 * base64url). Staff sessions carry `mfa_at` after the TOTP step; until then only
 * `/admin/mfa/*` renders and staff actions answer `unauthorized`. Permissions are read with the
 * session in one query per request, without cache (PL-17). `proxy.ts` only checks that the
 * cookie exists; the layouts call `requireStaff()` / `requireCustomer()`.
 */
import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { redirect, notFound } from "next/navigation";
import type { Db, DbOrTx } from "@beam/db";
import { authSessions, authVerificationTokens, users, type RoleKey } from "@beam/db/schema";
import { URL_SEGMENT, type Locale } from "@beam/core/i18n";
import { findRecoveryCode, generateRecoveryCodes, hashRecoveryCode, localDateKey, wallClock } from "@beam/core/platform";
import { findOrCreatePersonByEmail } from "@/modules/crm/api";
import { readReferralCode } from "@/modules/site/api";
import { sendTransactional } from "@/modules/email/api";
import type { Permission } from "../registry/types.generated";
import { SESSION_COOKIE, SESSION_COOKIE_SECURE } from "./auth-config";
import { actorHasPermission, AppError, createCtx, ctxState, eq, getAppDb, sql, type Actor, type Ctx } from "./ctx";
import { writeAuditRow } from "./audit";
import { getSetting } from "./settings";
import { decryptSensitive, encryptSensitive, loadCurrentKeyVersion, rowsOf, sensitiveAad } from "./sensitive";
import { recordEvent as writeEvent } from "./events";
import { scheduleJobs } from "./action";

export { SESSION_COOKIE };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Audience = "staff" | "customer";

export type SessionUser = {
  id: string;
  audience: Audience;
  email: string;
  name: string | null;
  locale: Locale;
  roleKey: RoleKey | null;
  personId: string | null;
  isTester: boolean;
  mfaEnrolledAt: Date | null;
  hasPassword: boolean;
};

export type SessionInfo = {
  sessionId: string;
  sessionToken: string;
  audience: Audience;
  mfaAt: Date | null;
  expiresAt: Date;
  absoluteExpiresAt: Date;
  user: SessionUser;
  /** The role's permission strings (`['*']` for the owner); empty for customers. */
  permissions: ReadonlySet<Permission>;
};

// ---------------------------------------------------------------------------
// Session policy (PL-8)
// ---------------------------------------------------------------------------

export type SessionPolicy = {
  staff_idle_hours: number;
  staff_idle_hours_by_role: Record<string, number>;
  staff_absolute_days: number;
  customer_session_days: number;
  lockout_threshold: number;
  lockout_minutes: number;
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** `last_seen_at` and the idle expiry move at most once per 5 minutes (PL-8). */
export const SESSION_TOUCH_MS = 5 * 60_000;

export async function sessionPolicy(tx: DbOrTx): Promise<SessionPolicy> {
  return (await getSetting(tx, "security")) as SessionPolicy;
}

/** Idle timeout: reception 4 h (shared desk device), other staff 12 h, customers 90 days. */
export function idleMs(policy: SessionPolicy, audience: Audience, roleKey: RoleKey | null): number {
  if (audience === "customer") return policy.customer_session_days * DAY;
  const hours = (roleKey && policy.staff_idle_hours_by_role[roleKey]) || policy.staff_idle_hours;
  return hours * HOUR;
}

export function absoluteMs(policy: SessionPolicy, audience: Audience): number {
  return audience === "customer" ? policy.customer_session_days * DAY : policy.staff_absolute_days * DAY;
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** How Auth.js stores verification tokens: sha256 hex of token + AUTH_SECRET. */
export function hashVerificationToken(token: string, secret: string = process.env.AUTH_SECRET ?? ""): string {
  return createHash("sha256").update(`${token}${secret}`).digest("hex");
}

/** Creates a verification token row and returns the raw token for the link. */
export async function createVerificationToken(tx: DbOrTx, identifier: string, ttlMs: number, now: Date): Promise<{ token: string; hashed: string }> {
  const token = randomBytes(32).toString("base64url");
  const hashed = hashVerificationToken(token);
  await tx.insert(authVerificationTokens).values({ identifier, token: hashed, expires: new Date(now.getTime() + ttlMs) });
  return { token, hashed };
}

/** Consumes a token whose identifier starts with `prefix` (single use). Returns the identifier, or null. */
export async function consumeVerificationToken(tx: DbOrTx, prefix: string, token: string, now: Date): Promise<string | null> {
  const rows = rowsOf<{ identifier: string; expires_at: string | Date }>(
    await tx.execute(sql`delete from auth_verification_tokens where token = ${hashVerificationToken(token)}
      and identifier like ${`${prefix}%`} returning identifier, expires_at`),
  );
  const row = rows[0];
  if (!row || new Date(row.expires_at).getTime() < now.getTime()) return null;
  return row.identifier;
}

/**
 * A same-origin path for `returnTo`, else `fallback`: it must start with one `/`, contain no
 * backslash or control character (browsers drop tab, CR and LF, so `/\t/evil.com` would become
 * `//evil.com`), and resolve to the same origin.
 */
export function safeReturnTo(value: string | null | undefined, fallback: string): string {
  // eslint-disable-next-line no-control-regex
  if (!value || !value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(value)) return fallback;
  try {
    const url = new URL(value, "http://x.invalid");
    if (url.origin !== "http://x.invalid") return fallback;
    return url.pathname + url.search + url.hash;
  } catch {
    return fallback;
  }
}

export function appUrl(path: string): string {
  return `${(process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "")}${path}`;
}

// ---------------------------------------------------------------------------
// Session rows
// ---------------------------------------------------------------------------

export async function createAuthSession(
  tx: DbOrTx,
  input: { userId: string; audience: Audience; roleKey: RoleKey | null; now: Date; ip?: string | null; userAgent?: string | null; mfaAt?: Date | null; token?: string },
): Promise<{ token: string; expires: Date }> {
  const policy = await sessionPolicy(tx);
  const token = input.token ?? newSessionToken();
  const absolute = new Date(input.now.getTime() + absoluteMs(policy, input.audience));
  const idle = new Date(Math.min(input.now.getTime() + idleMs(policy, input.audience, input.roleKey), absolute.getTime()));
  await tx.insert(authSessions).values({
    sessionToken: token,
    userId: input.userId,
    audience: input.audience,
    expires: idle,
    absoluteExpiresAt: absolute,
    mfaAt: input.mfaAt ?? null,
    lastSeenAt: input.now,
    ip: input.ip ?? null,
    userAgent: input.userAgent ? input.userAgent.slice(0, 300) : null,
    createdAt: input.now,
  });
  return { token, expires: idle };
}

/** The dedupe key of `platform.signed_in` (spec 4.7): `signin:<user_id>:<Brussels YYYY-MM-DD>`. */
export function signedInKey(userId: string, now: Date): string {
  return `signin:${userId}:${localDateKey(wallClock(now))}`;
}

/** The Auth.js adapter's `createSession` (magic link): a customer session with both expiries, and `platform.signed_in`. */
export async function insertCustomerSession(
  db: DbOrTx,
  input: { sessionToken: string; userId: string; ip?: string | null; userAgent?: string | null; now?: Date },
): Promise<{ sessionToken: string; userId: string; expires: Date }> {
  const now = input.now ?? new Date();
  const { expires } = await createAuthSession(db, { ...input, token: input.sessionToken, audience: "customer", roleKey: null, now });
  const [user] = await db
    .update(users)
    .set({ lastLoginAt: now, failedLogins: 0, lockedUntil: null })
    .where(eq(users.id, input.userId))
    .returning({ personId: users.personId });
  if (user?.personId) {
    // Spec 4.7: one platform.signed_in per user per Brussels day.
    await writeEvent(db, { kind: "customer", id: input.userId }, {
      kind: "platform.signed_in",
      personId: user.personId,
      data: { method: "magic_link" },
      dedupeKey: signedInKey(input.userId, now),
      occurredAt: now,
    });
  }
  return { sessionToken: input.sessionToken, userId: input.userId, expires };
}

type SessionRow = {
  session_id: string;
  session_token: string;
  audience: Audience;
  expires_at: string | Date;
  absolute_expires_at: string | Date;
  mfa_at: string | Date | null;
  last_seen_at: string | Date;
  user_id: string;
  email: string;
  name: string | null;
  locale: Locale;
  role_key: RoleKey | null;
  person_id: string | null;
  is_tester: boolean;
  mfa_enrolled_at: string | Date | null;
  has_password: boolean;
  status: "active" | "disabled";
  permissions: string[] | null;
};

const toDate = (v: string | Date) => (v instanceof Date ? v : new Date(v));
const toDateOrNull = (v: string | Date | null) => (v === null ? null : toDate(v));

/**
 * Loads the session of `token` with its user and role permissions in one query (PL-17).
 * Expired sessions (idle or absolute, PL-8) and sessions of disabled users are deleted and
 * give `null`. A live session slides its idle expiry, at most once per 5 minutes.
 */
export async function loadSession(db: DbOrTx, token: string, now: Date = new Date()): Promise<SessionInfo | null> {
  const rows = rowsOf<SessionRow>(
    await db.execute(sql`
      select s.id as session_id, s.session_token, s.audience, s.expires_at, s.absolute_expires_at, s.mfa_at, s.last_seen_at,
             u.id as user_id, u.email, u.name, u.locale, u.role_key, u.person_id, u.is_tester, u.mfa_enrolled_at,
             (u.password_hash is not null) as has_password, u.status, r.permissions
      from auth_sessions s
      join users u on u.id = s.user_id
      left join roles r on r.key = u.role_key
      where s.session_token = ${token}`),
  );
  const row = rows[0];
  if (!row) return null;
  const expires = toDate(row.expires_at);
  const absolute = toDate(row.absolute_expires_at);
  if (expires <= now || absolute <= now || row.status !== "active" || row.audience !== (row.role_key ? "staff" : "customer")) {
    await db.delete(authSessions).where(eq(authSessions.id, row.session_id));
    return null;
  }
  let expiresAt = expires;
  if (now.getTime() - toDate(row.last_seen_at).getTime() >= SESSION_TOUCH_MS) {
    const policy = await sessionPolicy(db);
    expiresAt = new Date(Math.min(now.getTime() + idleMs(policy, row.audience, row.role_key), absolute.getTime()));
    await db.update(authSessions).set({ lastSeenAt: now, expires: expiresAt }).where(eq(authSessions.id, row.session_id));
  }
  return {
    sessionId: row.session_id,
    sessionToken: row.session_token,
    audience: row.audience,
    mfaAt: toDateOrNull(row.mfa_at),
    expiresAt,
    absoluteExpiresAt: absolute,
    permissions: new Set((row.permissions ?? []) as Permission[]),
    user: {
      id: row.user_id,
      audience: row.audience,
      email: row.email,
      name: row.name,
      locale: row.locale,
      roleKey: row.role_key,
      personId: row.person_id,
      isTester: row.is_tester,
      mfaEnrolledAt: toDateOrNull(row.mfa_enrolled_at),
      hasPassword: row.has_password,
    },
  };
}

/** The actor of a session: staff only after the TOTP step (PL-3), customers always. */
export function actorFromSession(session: SessionInfo | null): Actor | null {
  if (!session) return null;
  if (session.audience === "customer") {
    return session.user.personId ? { kind: "customer", userId: session.user.id, personId: session.user.personId } : null;
  }
  if (!session.mfaAt || !session.user.roleKey) return null;
  return { kind: "staff", userId: session.user.id, roleKey: session.user.roleKey, permissions: session.permissions, mfaAt: session.mfaAt };
}

export async function deleteSessionByToken(tx: DbOrTx, token: string): Promise<number> {
  return (await tx.delete(authSessions).where(eq(authSessions.sessionToken, token)).returning({ id: authSessions.id })).length;
}

/** PL-9: deletes every session of a user, or every other one when `exceptToken` is given. */
export async function deleteUserSessions(tx: DbOrTx, userId: string, exceptToken?: string): Promise<number> {
  const rows = rowsOf<{ id: string }>(
    await tx.execute(
      exceptToken
        ? sql`delete from auth_sessions where user_id = ${userId} and session_token <> ${exceptToken} returning id`
        : sql`delete from auth_sessions where user_id = ${userId} returning id`,
    ),
  );
  return rows.length;
}

// ---------------------------------------------------------------------------
// The request: cookie and headers (next/headers; mocked in tests)
// ---------------------------------------------------------------------------

export async function readSessionToken(): Promise<string | null> {
  try {
    return (await cookies()).get(SESSION_COOKIE)?.value ?? null;
  } catch {
    return null;
  }
}

export async function setSessionCookie(token: string, expires: Date): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: SESSION_COOKIE_SECURE, path: "/", expires });
}

export async function clearSessionCookie(): Promise<void> {
  try {
    (await cookies()).delete(SESSION_COOKIE);
  } catch {
    // Outside a Server Action or route handler cookies are read-only; the row is gone anyway.
  }
}

export type RequestMeta = { ip: string | null; userAgent: string | null; pathname: string | null; locale: Locale | null };

export async function requestMeta(): Promise<RequestMeta> {
  try {
    const h = await headers();
    const locale = h.get("x-beam-locale");
    return {
      ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || null,
      userAgent: h.get("user-agent"),
      pathname: h.get("x-pathname"),
      locale: locale === "nl-BE" || locale === "fr-BE" || locale === "en" ? locale : null,
    };
  } catch {
    return { ip: null, userAgent: null, pathname: null, locale: null };
  }
}

// ---------------------------------------------------------------------------
// Guards (platform spec 4.1)
// ---------------------------------------------------------------------------

/** The current session (one query per request, PL-17), or null. */
export const getSession = cache(async (): Promise<SessionInfo | null> => {
  const token = await readSessionToken();
  if (!token) return null;
  return loadSession(await getAppDb(), token);
});

export function hasPermission(actor: Actor, permission: Permission): boolean {
  return actorHasPermission(actor, permission);
}

async function currentPath(fallback: string): Promise<string> {
  return safeReturnTo((await requestMeta()).pathname, fallback);
}

/**
 * For `(admin)` layouts and pages: a staff actor after MFA, else a redirect to the login,
 * MFA setup or MFA verify page. A missing permission renders 404.
 */
export async function requireStaff(opts: { permission?: Permission } = {}): Promise<Extract<Actor, { kind: "staff" }>> {
  const session = await getSession();
  if (!session || session.audience !== "staff") {
    redirect(`/admin/login?returnTo=${encodeURIComponent(await currentPath("/admin"))}` as never);
  }
  if (!session.user.mfaEnrolledAt) redirect("/admin/mfa/setup");
  if (!session.mfaAt) redirect(`/admin/mfa/verify?returnTo=${encodeURIComponent(await currentPath("/admin"))}` as never);
  const actor = actorFromSession(session) as Extract<Actor, { kind: "staff" }>;
  if (opts.permission && !hasPermission(actor, opts.permission)) notFound();
  return actor;
}

/** For `(portal)` layouts and pages: a customer actor, else a redirect to the portal login. */
export async function requireCustomer(locale: Locale): Promise<Extract<Actor, { kind: "customer" }>> {
  const session = await getSession();
  const actor = actorFromSession(session);
  if (!actor || actor.kind !== "customer") {
    const seg = URL_SEGMENT[locale];
    redirect(`/${seg}/account/login?returnTo=${encodeURIComponent(await currentPath(`/${seg}/account`))}` as never);
  }
  return actor;
}

export async function requirePermission(permission: Permission): Promise<void> {
  await requireStaff({ permission });
}

// ---------------------------------------------------------------------------
// Lockout (PL-6, PL-7)
// ---------------------------------------------------------------------------

/** The one message for unknown email, wrong password, disabled and locked accounts (PL-7). */
export const INVALID_CREDENTIALS = "invalid_credentials";

export function invalidCredentials(): AppError {
  return new AppError("unauthorized", INVALID_CREDENTIALS);
}

export function isLocked(user: { lockedUntil: Date | null }, now: Date): boolean {
  return !!user.lockedUntil && user.lockedUntil.getTime() > now.getTime();
}

/**
 * Counts one failed password or TOTP attempt. At the threshold (10) the account locks for
 * 15 minutes and audit `auth.locked` is written. Staff failures write `auth.login_failed`.
 * Callers run it through `writeDurably`, so it survives the rollback of the failed action.
 */
export async function recordFailedLogin(
  db: DbOrTx,
  input: { userId: string; audience: Audience; now: Date; requestId: string; ip: string | null; reason: "password" | "totp" | "recovery_code" },
): Promise<{ failedLogins: number; lockedUntil: Date | null }> {
  const policy = await sessionPolicy(db);
  // A lock that has expired starts a fresh count (PL-6: the account locks at 10 failures, not at
  // every failure after the first lock). Failures during a lock still count toward its audit.
  const now = input.now.toISOString();
  const rows = rowsOf<{ failed_logins: number; locked_until: string | Date | null }>(
    await db.execute(sql`update users set
        failed_logins = case when locked_until is not null and locked_until <= ${now}::timestamptz then 1 else failed_logins + 1 end,
        locked_until = case when locked_until <= ${now}::timestamptz then null else locked_until end,
        updated_at = now()
      where id = ${input.userId}
      returning failed_logins, locked_until`),
  );
  const failed = Number(rows[0]?.failed_logins ?? 0);
  let lockedUntil = rows[0]?.locked_until ? toDate(rows[0].locked_until) : null;
  const meta = { actor: { kind: "system" as const, id: null }, requestId: input.requestId, ip: input.ip };
  if (input.audience === "staff") {
    await writeAuditRow(db, meta, { action: "auth.login_failed", entityType: "users", entityId: input.userId, newValue: { reason: input.reason, failed_logins: failed } });
  }
  if (failed >= policy.lockout_threshold && !(lockedUntil && lockedUntil > input.now)) {
    lockedUntil = new Date(input.now.getTime() + policy.lockout_minutes * 60_000);
    await db.update(users).set({ lockedUntil }).where(eq(users.id, input.userId));
    await writeAuditRow(db, meta, { action: "auth.locked", entityType: "users", entityId: input.userId, newValue: { locked_until: lockedUntil, failed_logins: failed } });
  }
  return { failedLogins: failed, lockedUntil };
}

/** A complete login: counters reset (PL-6), `last_login_at` set. */
export async function recordSuccessfulLogin(tx: DbOrTx, userId: string, now: Date): Promise<void> {
  await tx.update(users).set({ failedLogins: 0, lockedUntil: null, lastLoginAt: now }).where(eq(users.id, userId));
}

// ---------------------------------------------------------------------------
// TOTP secret and recovery codes (encrypted on the user row)
// ---------------------------------------------------------------------------

export type StoredCode = { hash: string; used_at: string | null };

export type MfaSecrets = { totpSecret: string | null; codes: StoredCode[] };

export async function readMfaSecrets(tx: DbOrTx, userId: string): Promise<MfaSecrets> {
  const [row] = await tx
    .select({ totp: users.totpSecretEnc, codes: users.recoveryCodesEnc, version: users.secretKeyVersion })
    .from(users)
    .where(eq(users.id, userId));
  if (!row || row.version === null) return { totpSecret: null, codes: [] };
  const totpSecret = row.totp ? decryptSensitive(row.totp, row.version, sensitiveAad.totpSecret(userId)) : null;
  const codes = row.codes ? (JSON.parse(decryptSensitive(row.codes, row.version, sensitiveAad.recoveryCodes(userId))) as StoredCode[]) : [];
  return { totpSecret, codes };
}

/**
 * Writes both secret columns with the current key version (they share `secret_key_version`),
 * read from `settings.security.current_key_version` in `tx` (PL-69).
 */
export async function writeMfaSecrets(tx: DbOrTx, userId: string, secrets: MfaSecrets, extra: Partial<typeof users.$inferInsert> = {}): Promise<void> {
  const version = await loadCurrentKeyVersion(tx);
  const totp = secrets.totpSecret ? encryptSensitive(secrets.totpSecret, sensitiveAad.totpSecret(userId), version) : null;
  const codes = encryptSensitive(JSON.stringify(secrets.codes), sensitiveAad.recoveryCodes(userId), version);
  await tx
    .update(users)
    .set({ totpSecretEnc: totp?.valueEnc ?? null, recoveryCodesEnc: codes.valueEnc, secretKeyVersion: codes.keyVersion, ...extra })
    .where(eq(users.id, userId));
}

/** Ten new codes; only their sha256 hashes are stored (PL-4). */
export async function newRecoveryCodes(): Promise<{ codes: string[]; stored: StoredCode[] }> {
  const codes = generateRecoveryCodes();
  return { codes, stored: await Promise.all(codes.map(async (c) => ({ hash: await hashRecoveryCode(c), used_at: null }))) };
}

/** Marks a matching unused code as used (PL-5). Returns the stored list after use, or null. */
export async function useStoredRecoveryCode(input: string, codes: StoredCode[], now: Date): Promise<StoredCode[] | null> {
  const unused = codes.filter((c) => !c.used_at);
  const index = await findRecoveryCode(input, unused.map((c) => c.hash));
  if (index < 0) return null;
  const hash = unused[index]!.hash;
  return codes.map((c) => (c.hash === hash ? { ...c, used_at: now.toISOString() } : c));
}

export const unusedCodeCount = (codes: StoredCode[]) => codes.filter((c) => !c.used_at).length;

/** The last TOTP step a user used, so the same code is refused again (kept in `rate_limits`). */
export async function lastTotpCounter(tx: DbOrTx, userId: string): Promise<number | null> {
  const rows = rowsOf<{ c: string | number | null }>(
    await tx.execute(sql`select floor(extract(epoch from window_start) / 30)::bigint as c from rate_limits where key = ${`totp_used:${userId}`}`),
  );
  const c = rows[0]?.c;
  return c === undefined || c === null ? null : Number(c);
}

export async function storeTotpCounter(tx: DbOrTx, userId: string, counter: number): Promise<void> {
  const at = new Date(counter * 30_000).toISOString();
  const expires = new Date(counter * 30_000 + 10 * 60_000).toISOString();
  await tx.execute(sql`insert into rate_limits (key, window_start, count, expires_at)
    values (${`totp_used:${userId}`}, ${at}::timestamptz, 1, ${expires}::timestamptz)
    on conflict (key) do update set window_start = excluded.window_start, expires_at = excluded.expires_at`);
}

// ---------------------------------------------------------------------------
// Customer sign-up (PL-12) and security notices (PL-9)
// ---------------------------------------------------------------------------

/**
 * Called by the Auth.js adapter when a verified email has no `users` row: creates (or finds)
 * the person through crm, the customer user and the event `platform.account_created`.
 * An email that belongs to a staff user is refused (`conflict`, `staff_email`).
 */
export async function createCustomerAccount(
  db: Db,
  input: { email: string; locale: Locale; cookies: { get(name: string): { value: string } | undefined }; searchParams?: URLSearchParams },
): Promise<{ userId: string; personId: string; email: string; created: boolean }> {
  const email = input.email.trim().toLowerCase();
  const referralCode = readReferralCode(input.cookies, input.searchParams);
  let enqueued: string[] = [];
  const result = await db.transaction(async (tx) => {
    const ctx = createCtx({ tx, actor: { kind: "public" }, locale: input.locale });
    const [existing] = await tx.select().from(users).where(sql`lower(${users.email}) = ${email}`);
    if (existing?.audience === "staff") throw new AppError("conflict", "staff_email");
    if (existing) return { userId: existing.id, personId: existing.personId!, email, created: false };
    const { personId } = await findOrCreatePersonByEmail(tx, ctx, {
      email,
      locale: input.locale,
      acquisition: { source: "website", medium: "portal_signup", ...(referralCode ? { referral_code: referralCode } : {}) },
    });
    const [byPerson] = await tx.select().from(users).where(sql`${users.personId} = ${personId} and ${users.audience} = 'customer'`);
    if (byPerson) return { userId: byPerson.id, personId, email: byPerson.email, created: false };
    const [user] = await tx
      .insert(users)
      .values({ audience: "customer", email, personId, locale: input.locale, emailVerified: ctx.now })
      .returning({ id: users.id });
    await ctx.recordEvent({ kind: "platform.account_created", personId, data: { user_id: user!.id, method: "magic_link" }, dedupeKey: `account:${user!.id}` });
    enqueued = ctxState(ctx).enqueuedIds;
    return { userId: user!.id, personId, email, created: true };
  });
  scheduleJobs(enqueued);
  return result;
}

export type SecurityChange = "password_changed" | "password_reset" | "mfa_reset" | "recovery_codes_regenerated";

/**
 * PL-9: a staff password change, reset, MFA reset or recovery-code regeneration emails
 * `platform.mfa_changed` to the user, keyed `security_notice:<user_id>:<audit_log_id>` (the
 * audit row of `auditAction` that this request just wrote).
 */
export async function notifySecurityChange(
  ctx: Ctx,
  input: { userId: string; email: string; locale: Locale; change: SecurityChange; auditAction: string },
): Promise<void> {
  const rows = rowsOf<{ id: string }>(
    await ctx.tx.execute(sql`select id from audit_log where request_id = ${ctx.requestId} and action = ${input.auditAction}
      and entity_id = ${input.userId} order by created_at desc limit 1`),
  );
  const auditId = rows[0]?.id ?? ctx.requestId;
  await sendTransactional(ctx, {
    template: "platform.mfa_changed",
    to: input.email,
    locale: input.locale,
    // The props of MfaChangedProps (packages/email/src/templates/platform/mfa-changed.tsx).
    data: { change: input.change, occurredAt: ctx.now.toISOString(), url: appUrl("/admin/account") },
    key: `security_notice:${input.userId}:${auditId}`,
  });
}
