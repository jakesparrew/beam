import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { activityEvents, auditLog, authSessions, roles, users } from "@beam/db/schema";

process.env.SENSITIVE_DATA_KEY_V1 = randomBytes(32).toString("base64");
process.env.AUTH_SECRET = "test-auth-secret";

const jar = new Map<string, string>();
const hdrs = { ip: "198.51.100.1" };
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": hdrs.ip, "user-agent": "vitest" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));
const sent: { template: string; to?: string; key: string; data: Record<string, unknown> }[] = [];
vi.mock("@/modules/email/api", () => ({
  sendTransactional: (_ctx: unknown, input: { template: string; to?: string; key: string; data: Record<string, unknown> }) => {
    sent.push(input);
    return Promise.resolve({ emailMessageId: "m", jobId: "j" });
  },
}));
const crm = { calls: [] as { email: string; locale: string; acquisition?: Record<string, unknown> }[] };
vi.mock("@/modules/crm/api", () => ({
  findOrCreatePersonByEmail: async (tx: never, _ctx: unknown, input: { email: string; locale: string; acquisition?: Record<string, unknown> }) => {
    crm.calls.push(input);
    const { makePerson: make } = await import("@beam/db/testing");
    const person = await make(tx, { email: input.email, locale: input.locale as "nl-BE" });
    return { personId: person.id, created: true };
  },
}));
const referral: { code: string | null } = { code: null };
vi.mock("@/modules/site/api", () => ({ readReferralCode: (): string | null => referral.code }));

const auth = await import("./auth");
const actions = await import("@/modules/platform/actions");
const { hashPassword } = await import("./password");
const { generateTotp, generateTotpSecret } = await import("./totp");
const { eq, setAppDb, and } = await import("./ctx");
const { resetRuntime } = await import("./testing");

let handle: DbHandle;
const PASSWORD = "Velvet-Lantern-Orbit-93!";
let ipCounter = 0;
const freshIp = () => (hdrs.ip = `198.51.100.${(++ipCounter % 250) + 1}`);

async function staffUser(opts: { roleKey?: "owner" | "reception" | "technical_admin"; mfa?: boolean } = {}) {
  const user = await makeUser(handle.db, { roleKey: opts.roleKey ?? "technical_admin", passwordHash: await hashPassword(PASSWORD), mfaEnrolledAt: null });
  const secret = generateTotpSecret();
  const { codes, stored } = await auth.newRecoveryCodes();
  if (opts.mfa !== false) await auth.writeMfaSecrets(handle.db, user.id, { totpSecret: secret, codes: stored }, { mfaEnrolledAt: new Date() });
  return { user, secret, codes };
}

async function rowOf(id: string) {
  const [row] = await handle.db.select().from(users).where(eq(users.id, id));
  return row!;
}

beforeAll(async () => {
  handle = await createTestDb();
  setAppDb(handle.db);
  await handle.db.insert(roles).values({ key: "owner", name: { en: "Owner" }, permissions: ["*"] }).onConflictDoNothing();
});
afterAll(async () => {
  resetRuntime();
  await handle.close();
});
beforeEach(() => {
  jar.clear();
  sent.length = 0;
  crm.calls.length = 0;
  referral.code = null;
  freshIp();
});

describe("staff password step (PL-6, PL-7)", () => {
  it("answers one generic message for unknown email, wrong password and disabled users", async () => {
    const { user } = await staffUser();
    const disabled = (await staffUser()).user;
    await handle.db.update(users).set({ status: "disabled" }).where(eq(users.id, disabled.id));
    const generic = { ok: false, error: { code: "unauthorized", message: "invalid_credentials" } };
    expect(await actions.staffSignIn({ email: "nobody@example.com", password: PASSWORD })).toEqual(generic);
    expect(await actions.staffSignIn({ email: user.email, password: "Wrong-Password-123!" })).toEqual(generic);
    expect(await actions.staffSignIn({ email: disabled.email, password: PASSWORD })).toEqual(generic);
    expect(jar.size).toBe(0);
  });

  it("locks after 10 failures, shows the lock only after a correct password, and resets on login", async () => {
    const { user, secret } = await staffUser();
    for (let i = 0; i < 10; i++) {
      freshIp();
      expect((await actions.staffSignIn({ email: user.email, password: "Wrong-Password-123!" })).ok).toBe(false);
    }
    const locked = await rowOf(user.id);
    expect(locked.failedLogins).toBe(10);
    expect(locked.lockedUntil!.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
    expect(await handle.db.select().from(auditLog).where(and(eq(auditLog.action, "auth.locked"), eq(auditLog.entityId, user.id)))).toHaveLength(1);
    expect(await handle.db.select().from(auditLog).where(and(eq(auditLog.action, "auth.login_failed"), eq(auditLog.entityId, user.id)))).toHaveLength(10);

    freshIp();
    const wrongWhileLocked = await actions.staffSignIn({ email: user.email, password: "Wrong-Password-123!" });
    expect(wrongWhileLocked).toMatchObject({ ok: false, error: { message: "invalid_credentials" } });
    freshIp();
    const rightWhileLocked = await actions.staffSignIn({ email: user.email, password: PASSWORD });
    expect(rightWhileLocked).toMatchObject({ ok: false, error: { code: "unauthorized", message: "locked" } });
    expect(jar.size).toBe(0);

    await handle.db.update(users).set({ lockedUntil: new Date(Date.now() - 1000) }).where(eq(users.id, user.id));
    freshIp();
    expect(await actions.staffSignIn({ email: user.email, password: PASSWORD })).toEqual({ ok: true, data: { next: "/admin/mfa/verify" } });
    expect(jar.get(auth.SESSION_COOKIE)).toBeTruthy();
    expect(await actions.verifyTotp({ code: generateTotp(secret) })).toEqual({ ok: true, data: { next: "/admin" } });
    const after = await rowOf(user.id);
    expect(after.failedLogins).toBe(0);
    expect(after.lockedUntil).toBeNull();
    expect(after.lastLoginAt).not.toBeNull();
  });

  it("rehashes a password made with weaker parameters (PL-2)", async () => {
    const { hash } = await import("@node-rs/argon2");
    const { user } = await staffUser();
    await handle.db.update(users).set({ passwordHash: await hash(PASSWORD, { memoryCost: 4096, timeCost: 1, parallelism: 1 }) }).where(eq(users.id, user.id));
    expect((await actions.staffSignIn({ email: user.email, password: PASSWORD })).ok).toBe(true);
    expect((await rowOf(user.id)).passwordHash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  });

  it("sends a user without MFA to the setup page", async () => {
    const { user } = await staffUser({ mfa: false });
    expect(await actions.staffSignIn({ email: user.email, password: PASSWORD })).toEqual({ ok: true, data: { next: "/admin/mfa/setup" } });
  });
});

describe("MFA step (PL-3, PL-5)", () => {
  it("keeps an MFA-pending session out of staff actions until the TOTP step", async () => {
    const { user, secret } = await staffUser({ roleKey: "owner" });
    await actions.staffSignIn({ email: user.email, password: PASSWORD });
    const session = await auth.loadSession(handle.db, jar.get(auth.SESSION_COOKIE)!);
    expect(session?.mfaAt).toBeNull();
    expect(auth.actorFromSession(session)).toBeNull();
    expect(await actions.revokeAllSessions({ userId: user.id })).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    expect(await actions.verifyTotp({ code: "000000" === generateTotp(secret) ? "111111" : "000000" })).toMatchObject({ ok: false, error: { code: "validation" } });
    expect((await rowOf(user.id)).failedLogins).toBe(1);
    expect((await actions.verifyTotp({ code: generateTotp(secret), returnTo: "/admin/system/jobs" })).ok).toBe(true);
    expect(await actions.verifyTotp({ code: generateTotp(secret) })).toMatchObject({ ok: false, error: { code: "validation" } });
    expect((await actions.revokeAllSessions({ userId: randomUuid() })).ok).toBe(true);
    expect(await handle.db.select().from(auditLog).where(and(eq(auditLog.action, "auth.staff_login"), eq(auditLog.entityId, user.id)))).toHaveLength(1);
  });

  it("accepts a recovery code once", async () => {
    const { user, codes } = await staffUser();
    await actions.staffSignIn({ email: user.email, password: PASSWORD });
    const first = await actions.useRecoveryCode({ code: codes[0]! });
    expect(first).toMatchObject({ ok: true, data: { next: "/admin", codesLeft: 9, lowOnCodes: false } });
    expect(await handle.db.select().from(auditLog).where(and(eq(auditLog.action, "auth.recovery_code_used"), eq(auditLog.entityId, user.id)))).toHaveLength(1);
    jar.clear();
    await actions.staffSignIn({ email: user.email, password: PASSWORD });
    expect(await actions.useRecoveryCode({ code: codes[0]! })).toMatchObject({ ok: false, error: { code: "validation" } });
    expect((await actions.useRecoveryCode({ code: codes[1]!.toUpperCase() })).ok).toBe(true);
  });

  it("enrols MFA with one valid code and returns 10 recovery codes (PL-4)", async () => {
    const { user } = await staffUser({ mfa: false });
    await actions.staffSignIn({ email: user.email, password: PASSWORD });
    const started = await actions.startMfaEnrolment({});
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.data.qrSvg).toContain("<svg");
    const secret = new URL(started.data.otpauthUri).searchParams.get("secret")!;
    const confirmed = await actions.confirmMfaEnrolment({ code: generateTotp(secret) });
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.data.recoveryCodes).toHaveLength(10);
    expect(confirmed.data.recoveryCodes[0]).toMatch(/^[0-9a-z]{5}-[0-9a-z]{5}$/);
    expect((await rowOf(user.id)).mfaEnrolledAt).not.toBeNull();
    const session = await auth.loadSession(handle.db, jar.get(auth.SESSION_COOKIE)!);
    expect(session?.mfaAt).not.toBeNull();
  });
});

function randomUuid() {
  return crypto.randomUUID();
}

describe("session expiry (PL-8) and logout (PL-9)", () => {
  it("expires staff sessions after 12 idle hours, reception after 4, and 7 days absolute", async () => {
    const t0 = new Date("2026-11-03T08:00:00Z");
    const admin = (await staffUser()).user;
    const desk = (await staffUser({ roleKey: "reception" })).user;
    const a = await auth.createAuthSession(handle.db, { userId: admin.id, audience: "staff", roleKey: "technical_admin", now: t0, mfaAt: t0 });
    const r = await auth.createAuthSession(handle.db, { userId: desk.id, audience: "staff", roleKey: "reception", now: t0, mfaAt: t0 });
    expect(a.expires.getTime() - t0.getTime()).toBe(12 * 3600_000);
    expect(r.expires.getTime() - t0.getTime()).toBe(4 * 3600_000);
    const at = (h: number) => new Date(t0.getTime() + h * 3600_000);
    expect(await auth.loadSession(handle.db, r.token, at(3.9))).not.toBeNull();
    expect(await auth.loadSession(handle.db, r.token, at(8))).toBeNull();
    expect(await auth.loadSession(handle.db, a.token, at(11))).not.toBeNull();
    expect(await auth.loadSession(handle.db, a.token, at(22))).not.toBeNull();
    // Keep touching every 11 hours until the absolute 7-day limit ends it.
    let alive = true;
    for (let h = 33; h < 7 * 24 && alive; h += 11) alive = (await auth.loadSession(handle.db, a.token, at(h))) !== null;
    expect(alive).toBe(true);
    expect(await auth.loadSession(handle.db, a.token, at(7 * 24 + 1))).toBeNull();
    expect(await handle.db.select().from(authSessions).where(eq(authSessions.sessionToken, a.token))).toHaveLength(0);
  });

  it("gives customers 90 days", async () => {
    const t0 = new Date("2026-11-03T08:00:00Z");
    const customer = await makeUser(handle.db, { audience: "customer" });
    const s = await auth.createAuthSession(handle.db, { userId: customer.id, audience: "customer", roleKey: null, now: t0 });
    expect(s.expires.getTime() - t0.getTime()).toBe(90 * 24 * 3600_000);
    expect(await auth.loadSession(handle.db, s.token, new Date(t0.getTime() + 89 * 24 * 3600_000))).not.toBeNull();
    expect(await auth.loadSession(handle.db, s.token, new Date(t0.getTime() + 91 * 24 * 3600_000))).toBeNull();
  });

  it("deletes the session row on sign-out and on revoke", async () => {
    const { user, secret } = await staffUser({ roleKey: "owner" });
    await actions.staffSignIn({ email: user.email, password: PASSWORD });
    await actions.verifyTotp({ code: generateTotp(secret) });
    const other = await auth.createAuthSession(handle.db, { userId: user.id, audience: "staff", roleKey: "owner", now: new Date(), mfaAt: new Date() });
    const [otherRow] = await handle.db.select().from(authSessions).where(eq(authSessions.sessionToken, other.token));
    expect((await actions.revokeSession({ sessionId: otherRow!.id })).ok).toBe(true);
    expect(await handle.db.select().from(authSessions).where(eq(authSessions.sessionToken, other.token))).toHaveLength(0);
    const token = jar.get(auth.SESSION_COOKIE)!;
    expect(await actions.signOut({})).toEqual({ ok: true, data: { next: "/admin/login" } });
    expect(jar.has(auth.SESSION_COOKIE)).toBe(false);
    expect(await handle.db.select().from(authSessions).where(eq(authSessions.sessionToken, token))).toHaveLength(0);
  });

  it("deletes other sessions and emails platform.mfa_changed on a password change", async () => {
    const { user, secret } = await staffUser({ roleKey: "owner" });
    const other = await auth.createAuthSession(handle.db, { userId: user.id, audience: "staff", roleKey: "owner", now: new Date(), mfaAt: new Date() });
    await actions.staffSignIn({ email: user.email, password: PASSWORD });
    await actions.verifyTotp({ code: generateTotp(secret) });
    const result = await actions.changeMyPassword({ currentPassword: PASSWORD, newPassword: "Copper-Meadow-Lantern-47?" });
    expect(result).toEqual({ ok: true, data: {} });
    expect(await handle.db.select().from(authSessions).where(eq(authSessions.sessionToken, other.token))).toHaveLength(0);
    expect(await handle.db.select().from(authSessions).where(eq(authSessions.sessionToken, jar.get(auth.SESSION_COOKIE)!))).toHaveLength(1);
    const [row] = await handle.db.select().from(auditLog).where(and(eq(auditLog.action, "auth.password_changed"), eq(auditLog.entityId, user.id)));
    expect(sent).toEqual([expect.objectContaining({ template: "platform.mfa_changed", to: user.email, key: `security_notice:${user.id}:${row!.id}` })]);
  });

  it("emails platform.mfa_changed for an MFA reset (helper used by resetUserMfa)", async () => {
    const { user } = await staffUser();
    const { makeCtx } = await import("./testing");
    const ctx = makeCtx(handle.db, { kind: "system", jobId: "" });
    await ctx.audit({ action: "users.reset_mfa", entityType: "users", entityId: user.id });
    await auth.notifySecurityChange(ctx, { userId: user.id, email: user.email, locale: "nl-BE", change: "mfa_reset", auditAction: "users.reset_mfa" });
    expect(sent[0]).toMatchObject({ template: "platform.mfa_changed", data: { change: "mfa_reset" } });
    expect(sent[0]!.key).toMatch(new RegExp(`^security_notice:${user.id}:[0-9a-f-]{36}$`));
  });
});

describe("customer magic links and sign-up (PL-11, PL-12)", () => {
  it("sends at most 5 links per address per hour and always answers sent", async () => {
    const email = `limit-${randomUuid()}@example.com`;
    for (let i = 0; i < 6; i++) expect(await actions.requestMagicLink({ email, locale: "fr-BE" })).toEqual({ ok: true, data: { sent: true } });
    expect(sent).toHaveLength(5);
    expect(sent[0]).toMatchObject({ template: "platform.magic_link", to: email, data: { expiresMinutes: 15 } });
    expect(sent[0]!.key).toMatch(/^magic_link:[0-9a-f]{64}$/);
    const url = new URL(sent[0]!.data.url as string);
    expect(url.pathname).toBe("/fr/account/login/verify");
    expect(url.searchParams.get("callbackUrl")).toBe("/fr/account");
    expect(auth.hashVerificationToken(url.searchParams.get("token")!)).toBe(sent[0]!.key.slice("magic_link:".length));
  });

  it("sends nothing to a staff address", async () => {
    const { user } = await staffUser();
    expect(await actions.requestMagicLink({ email: user.email, locale: "nl-BE" })).toEqual({ ok: true, data: { sent: true } });
    expect(sent).toHaveLength(0);
  });

  it("creates the person, the customer user and platform.account_created", async () => {
    const email = `new-${randomUuid()}@example.com`;
    const created = await auth.createCustomerAccount(handle.db, { email, locale: "en", cookies: { get: () => undefined } });
    expect(created.created).toBe(true);
    expect(crm.calls[0]).toEqual({ email, locale: "en", acquisition: { source: "website", medium: "portal_signup" } });
    const user = await rowOf(created.userId);
    expect(user).toMatchObject({ audience: "customer", email, personId: created.personId, locale: "en" });
    const events = await handle.db.select().from(activityEvents).where(eq(activityEvents.personId, created.personId));
    expect(events.map((e) => [e.kind, (e.data as { user_id: string }).user_id])).toEqual([["platform.account_created", created.userId]]);
    expect((await auth.createCustomerAccount(handle.db, { email, locale: "en", cookies: { get: () => undefined } })).created).toBe(false);
  });

  it("passes a referral code to crm when site reads one", async () => {
    referral.code = "LOTTE10";
    await auth.createCustomerAccount(handle.db, { email: `ref-${randomUuid()}@example.com`, locale: "nl-BE", cookies: { get: () => undefined } });
    expect(crm.calls[0]!.acquisition).toEqual({ source: "website", medium: "portal_signup", referral_code: "LOTTE10" });
  });

  it("refuses a staff email", async () => {
    const { user } = await staffUser();
    await expect(auth.createCustomerAccount(handle.db, { email: user.email, locale: "nl-BE", cookies: { get: () => undefined } })).rejects.toMatchObject({ code: "conflict", message: "staff_email" });
    expect(crm.calls).toHaveLength(0);
  });

  it("signs a customer in with a password and records platform.signed_in once per day", async () => {
    const person = await makePerson(handle.db);
    const customer = await makeUser(handle.db, { audience: "customer", personId: person.id, email: person.email!, passwordHash: await hashPassword(PASSWORD) });
    expect(await actions.customerPasswordSignIn({ email: customer.email, password: PASSWORD, locale: "nl-BE" })).toEqual({ ok: true, data: { next: "/nl/account" } });
    await actions.customerPasswordSignIn({ email: customer.email, password: PASSWORD, locale: "nl-BE" });
    const events = await handle.db.select().from(activityEvents).where(and(eq(activityEvents.personId, person.id), eq(activityEvents.kind, "platform.signed_in")));
    expect(events).toHaveLength(1);
    expect(events[0]!.dedupeKey).toBe(auth.signedInKey(customer.id, new Date()));
    expect(events[0]!.dedupeKey).toMatch(new RegExp(`^signin:${customer.id}:\\d{4}-\\d{2}-\\d{2}$`));
    expect(await actions.customerPasswordSignIn({ email: customer.email, password: "nope-nope-nope", locale: "nl-BE" })).toMatchObject({ ok: false, error: { message: "invalid_credentials" } });
  });
});

describe("returnTo (open redirect)", () => {
  it("refuses control characters, backslashes and anything that leaves the origin", () => {
    for (const bad of ["/\t/evil.com", "/\n/evil.com", "/\r/evil.com", "//evil.com", "/\\evil.com", "https://evil.com", "/\u0000x", "/\u007f/evil.com"]) {
      expect(auth.safeReturnTo(bad, "/admin")).toBe("/admin");
    }
    expect(auth.safeReturnTo("/admin/system/jobs?status=dead#top", "/admin")).toBe("/admin/system/jobs?status=dead#top");
    expect(auth.safeReturnTo(undefined, "/admin")).toBe("/admin");
  });

  it("does not hand a tab-smuggled returnTo to the client after the TOTP step", async () => {
    const { user, secret } = await staffUser();
    await actions.staffSignIn({ email: user.email, password: PASSWORD });
    expect(await actions.verifyTotp({ code: generateTotp(secret), returnTo: "/\t/evil.com" })).toEqual({ ok: true, data: { next: "/admin" } });
  });
});

describe("lockout after an expired lock (PL-6)", () => {
  it("restarts the count when a lock has expired, so one typo does not relock the account", async () => {
    const { user } = await staffUser();
    const wrong = async () => {
      freshIp();
      expect((await actions.staffSignIn({ email: user.email, password: "Wrong-Password-123!" })).ok).toBe(false);
    };
    for (let i = 0; i < 10; i++) await wrong();
    expect((await rowOf(user.id)).lockedUntil).not.toBeNull();
    await handle.db.update(users).set({ lockedUntil: new Date(Date.now() - 1000) }).where(eq(users.id, user.id));
    await wrong();
    const afterTypo = await rowOf(user.id);
    expect(afterTypo.failedLogins).toBe(1);
    expect(afterTypo.lockedUntil).toBeNull();
    for (let i = 0; i < 8; i++) await wrong();
    expect((await rowOf(user.id)).lockedUntil).toBeNull();
    await wrong();
    const relocked = await rowOf(user.id);
    expect(relocked.failedLogins).toBe(10);
    expect(relocked.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
  });
});

describe("MFA re-enrolment and step-up checks (PL-3, PL-5, PL-6, PL-9)", () => {
  it("refuses MFA re-enrolment from a password-only session of an enrolled user", async () => {
    const { user, secret } = await staffUser();
    await actions.staffSignIn({ email: user.email, password: PASSWORD });
    const conflict = { ok: false, error: { code: "conflict", message: "mfa_already_enrolled" } };
    const started = await actions.startMfaEnrolment({});
    expect(started).toMatchObject(conflict);
    expect(JSON.stringify(started)).not.toContain(secret);
    expect(await actions.confirmMfaEnrolment({ code: generateTotp(secret) })).toMatchObject(conflict);
    expect((await auth.readMfaSecrets(handle.db, user.id)).totpSecret).toBe(secret);
    const session = await auth.loadSession(handle.db, jar.get(auth.SESSION_COOKIE)!);
    expect(session?.mfaAt).toBeNull();
  });

  it("regenerates recovery codes only with a fresh TOTP, voids the old codes and emails platform.mfa_changed", async () => {
    const { user, secret, codes } = await staffUser();
    await actions.staffSignIn({ email: user.email, password: PASSWORD });
    expect((await actions.verifyTotp({ code: generateTotp(secret) })).ok).toBe(true);
    const nextStep = generateTotp(secret, new Date(Date.now() + 30_000));
    const wrongCode = nextStep === "000000" ? "111111" : "000000";
    expect(await actions.regenerateRecoveryCodes({ code: wrongCode })).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(sent).toHaveLength(0);
    // The current step was used by the login; the next step's code is fresh.
    const next = await actions.regenerateRecoveryCodes({ code: nextStep });
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect(next.data.recoveryCodes).toHaveLength(10);
    const audits = await handle.db.select().from(auditLog).where(and(eq(auditLog.action, "auth.recovery_codes_regenerated"), eq(auditLog.entityId, user.id)));
    expect(audits).toHaveLength(1);
    expect(sent).toEqual([
      expect.objectContaining({
        template: "platform.mfa_changed",
        data: expect.objectContaining({ change: "recovery_codes_regenerated" }),
        key: `security_notice:${user.id}:${audits[0]!.id}`,
      }),
    ]);
    jar.clear();
    await actions.staffSignIn({ email: user.email, password: PASSWORD });
    expect(await actions.useRecoveryCode({ code: codes[0]! })).toMatchObject({ ok: false, error: { code: "validation" } });
    expect((await actions.useRecoveryCode({ code: next.data.recoveryCodes[0]! })).ok).toBe(true);
  });

  it("counts wrong step-up codes and wrong current passwords toward the lockout", async () => {
    const { user, secret } = await staffUser({ roleKey: "owner" });
    await actions.staffSignIn({ email: user.email, password: PASSWORD });
    expect((await actions.verifyTotp({ code: generateTotp(secret) })).ok).toBe(true);
    const nextStep = generateTotp(secret, new Date(Date.now() + 30_000));
    expect((await actions.regenerateRecoveryCodes({ code: nextStep === "000000" ? "111111" : "000000" })).ok).toBe(false);
    expect((await rowOf(user.id)).failedLogins).toBe(1);
    expect(await actions.changeMyPassword({ currentPassword: "Not-The-Password-1!", newPassword: "Copper-Meadow-Lantern-47?" })).toMatchObject({
      ok: false,
      error: { code: "validation", message: "wrong_password" },
    });
    expect((await rowOf(user.id)).failedLogins).toBe(2);
    await handle.db.update(users).set({ lockedUntil: new Date(Date.now() + 15 * 60_000) }).where(eq(users.id, user.id));
    expect(await actions.changeMyPassword({ currentPassword: PASSWORD, newPassword: "Copper-Meadow-Lantern-47?" })).toMatchObject({ ok: false, error: { message: "locked" } });
    expect(await actions.regenerateRecoveryCodes({ code: nextStep })).toMatchObject({ ok: false, error: { message: "locked" } });
  });

  it("queues platform.mfa_changed with props that pass the template schema", async () => {
    const { templates } = await import("@beam/email/templates/platform");
    const template = templates.find((t) => t.name === "mfa_changed")!;
    const { user } = await staffUser();
    const { makeCtx } = await import("./testing");
    const ctx = makeCtx(handle.db, { kind: "system", jobId: "" });
    await ctx.audit({ action: "users.reset_mfa", entityType: "users", entityId: user.id });
    await auth.notifySecurityChange(ctx, { userId: user.id, email: user.email, locale: "nl-BE", change: "mfa_reset", auditAction: "users.reset_mfa" });
    expect(template.props.safeParse(sent[0]!.data).success).toBe(true);
  });

  it("encrypts MFA secrets with settings.security.current_key_version, read in the write's transaction (PL-69)", async () => {
    const { setCurrentKeyVersion } = await import("./sensitive");
    const { settings } = await import("@beam/db/schema");
    process.env.SENSITIVE_DATA_KEY_V2 = randomBytes(32).toString("base64");
    const { user } = await staffUser({ mfa: false });
    const [before] = await handle.db.select().from(settings).where(eq(settings.key, "security"));
    const value = { ...((before?.value as Record<string, unknown> | undefined) ?? {}), current_key_version: 2 };
    try {
      setCurrentKeyVersion(1); // an instance that never ran a tick
      await handle.db.insert(settings).values({ key: "security", value }).onConflictDoUpdate({ target: settings.key, set: { value } });
      await auth.writeMfaSecrets(handle.db, user.id, { totpSecret: generateTotpSecret(), codes: [] });
      expect((await rowOf(user.id)).secretKeyVersion).toBe(2);
    } finally {
      if (before) await handle.db.update(settings).set({ value: before.value }).where(eq(settings.key, "security"));
      else await handle.db.delete(settings).where(eq(settings.key, "security"));
      setCurrentKeyVersion(1);
      delete process.env.SENSITIVE_DATA_KEY_V2;
    }
  });
});

describe("magic-link sessions and the Auth.js callbacks (PL-11, PL-12, PL-14, spec 4.7)", () => {
  it("records platform.signed_in (magic_link) once per Brussels day", async () => {
    const person = await makePerson(handle.db);
    const customer = await makeUser(handle.db, { audience: "customer", personId: person.id, email: person.email! });
    // 23:30 UTC on 3 November is already 4 November in Brussels.
    await auth.insertCustomerSession(handle.db, { sessionToken: `t-${randomUuid()}`, userId: customer.id, now: new Date("2026-11-03T23:30:00Z") });
    await auth.insertCustomerSession(handle.db, { sessionToken: `t-${randomUuid()}`, userId: customer.id, now: new Date("2026-11-04T08:00:00Z") });
    const events = await handle.db.select().from(activityEvents).where(and(eq(activityEvents.personId, person.id), eq(activityEvents.kind, "platform.signed_in")));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ data: { method: "magic_link" }, dedupeKey: `signin:${customer.id}:2026-11-04` });
    expect(auth.signedInKey(customer.id, new Date("2026-11-03T22:59:00Z"))).toBe(`signin:${customer.id}:2026-11-03`);
  });

  it("records platform.account_created with the account: dedupe key", async () => {
    const created = await auth.createCustomerAccount(handle.db, { email: `key-${randomUuid()}@example.com`, locale: "en", cookies: { get: () => undefined } });
    const [event] = await handle.db.select().from(activityEvents).where(and(eq(activityEvents.personId, created.personId), eq(activityEvents.kind, "platform.account_created")));
    expect(event!.dedupeKey).toBe(`account:${created.userId}`);
  });

  it("consumes a magic-link token once and refuses staff and disabled users at the callback", async () => {
    const { buildAuthConfig } = await import("./auth-config");
    const cfg = await buildAuthConfig(new Request("http://localhost/api/auth/callback/email?callbackUrl=/fr/account"));
    const email = `link-${randomUuid()}@example.com`;
    const created = new Date();
    const { hashed } = await auth.createVerificationToken(handle.db, email, 15 * 60_000, created);
    const first = await cfg.adapter!.useVerificationToken!({ identifier: email, token: hashed });
    expect(first?.expires.getTime()).toBe(created.getTime() + 15 * 60_000);
    expect(await cfg.adapter!.useVerificationToken!({ identifier: email, token: hashed })).toBeNull();

    const signIn = cfg.callbacks!.signIn! as unknown as (p: { user: unknown }) => unknown;
    const staff = (await staffUser()).user;
    const disabled = await makeUser(handle.db, { audience: "customer", status: "disabled" });
    const active = await makeUser(handle.db, { audience: "customer" });
    expect(await signIn({ user: await rowOf(staff.id) })).toBe("/fr/account/login/error?error=StaffEmail");
    expect(await signIn({ user: await rowOf(disabled.id) })).toBe("/fr/account/login/error?error=AccessDenied");
    expect(await signIn({ user: await rowOf(active.id) })).toBe(true);
  });
});
