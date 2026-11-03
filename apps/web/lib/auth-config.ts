/**
 * Auth.js v5 configuration (runbook DR-11). Only the Email provider (customer magic links) and
 * database sessions. Staff password sign-in does not use the Credentials provider: platform's
 * `staffSignIn` action writes the `auth_sessions` row and sets `SESSION_COOKIE` itself.
 *
 * The magic link token is created by `requestMagicLink` (hashed like Auth.js does, so the
 * Email provider's callback can consume it), and the emailed link opens a confirmation page
 * whose button submits to `/api/auth/callback/email` (mail scanners do not submit forms).
 * The Drizzle adapter maps platform's tables; `createUser` and `createSession` are overridden
 * so a new customer gets a person (PL-12) and every session row has `audience` and
 * `absolute_expires_at`.
 */
import type { NextAuthConfig } from "next-auth";
import type { Adapter, AdapterSession, AdapterUser } from "next-auth/adapters";
import { DEFAULT_LOCALE, localeFromSegment, URL_SEGMENT, type Locale } from "@beam/core/i18n";

type Env = Readonly<Record<string, string | undefined>>;

/** `authjs.session-token`, with the `__Secure-` prefix when `APP_URL` is https. */
export function sessionCookieName(env: Env = process.env): string {
  return (env.APP_URL ?? "").startsWith("https://") ? "__Secure-authjs.session-token" : "authjs.session-token";
}

/** The session cookie shared by Auth.js (magic link) and platform's own sign-in actions. */
export const SESSION_COOKIE = sessionCookieName();

/** Whether the session cookie carries `Secure`. */
export const SESSION_COOKIE_SECURE = SESSION_COOKIE.startsWith("__Secure-");

/** The Auth.js id of the Email provider; its callback is `/api/auth/callback/email`. */
export const EMAIL_PROVIDER_ID = "email";

/** Magic links are valid 15 minutes (PL-11). */
export const MAGIC_LINK_MINUTES = 15;

/** The locale of a callback URL such as `/fr/account` (PL-12 uses the URL locale). */
export function localeOfPath(path: string | null | undefined): Locale {
  const seg = (path ?? "").replace(/^https?:\/\/[^/]+/, "").split("/")[1];
  return localeFromSegment(seg) ?? DEFAULT_LOCALE;
}

/** A cookie reader over a raw `Cookie` header (for `site.readReferralCode`). */
export function cookieReader(header: string | null): { get(name: string): { value: string } | undefined } {
  const map = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) map.set(part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim()));
  }
  return { get: (name) => (map.has(name) ? { value: map.get(name)! } : undefined) };
}

/** The Auth.js configuration for one request (lazy init, so the request's locale is known). */
export async function buildAuthConfig(request?: Request): Promise<NextAuthConfig> {
  // Loaded lazily: `proxy.ts` imports this file for `SESSION_COOKIE` and must stay free of database code.
  const [{ DrizzleAdapter }, { authAccounts, authSessions, authVerificationTokens, users }, { getAppDb }] = await Promise.all([
    import("@auth/drizzle-adapter"),
    import("@beam/db/schema"),
    import("./ctx"),
  ]);
  const db = await getAppDb();
  const url = request ? new URL(request.url) : null;
  const callbackUrl = url?.searchParams.get("callbackUrl") ?? null;
  const locale = localeOfPath(callbackUrl);
  const seg = URL_SEGMENT[locale];
  const base = DrizzleAdapter(db as never, {
    usersTable: users,
    accountsTable: authAccounts,
    sessionsTable: authSessions,
    verificationTokensTable: authVerificationTokens,
  } as never);

  const adapter: Adapter = {
    ...base,
    async createUser(user: AdapterUser): Promise<AdapterUser> {
      const { createCustomerAccount } = await import("./auth");
      const created = await createCustomerAccount(db, {
        email: user.email,
        locale,
        cookies: cookieReader(request?.headers.get("cookie") ?? null),
        searchParams: url?.searchParams,
      });
      return { id: created.userId, email: created.email, emailVerified: user.emailVerified ?? new Date(), name: null, image: null };
    },
    async createSession(session: { sessionToken: string; userId: string; expires: Date }): Promise<AdapterSession> {
      const { insertCustomerSession } = await import("./auth");
      const row = await insertCustomerSession(db, {
        sessionToken: session.sessionToken,
        userId: session.userId,
        ip: request?.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
        userAgent: request?.headers.get("user-agent") ?? null,
      });
      return { sessionToken: row.sessionToken, userId: row.userId, expires: row.expires };
    },
  };

  return {
    adapter,
    secret: process.env.AUTH_SECRET,
    trustHost: true,
    session: { strategy: "database", maxAge: 90 * 24 * 3600, updateAge: 300 },
    cookies: { sessionToken: { name: SESSION_COOKIE, options: { httpOnly: true, sameSite: "lax", path: "/", secure: SESSION_COOKIE_SECURE } } },
    pages: { signIn: `/${seg}/account/login`, verifyRequest: `/${seg}/account/login/check-email`, error: `/${seg}/account/login/error` },
    providers: [
      {
        id: EMAIL_PROVIDER_ID,
        type: "email",
        name: "Email",
        maxAge: MAGIC_LINK_MINUTES * 60,
        // Links are created and sent by `requestMagicLink` (a job, never a direct Resend call).
        sendVerificationRequest: () => Promise.resolve(),
        normalizeIdentifier: (identifier: string) => identifier.trim().toLowerCase(),
      },
    ],
    callbacks: {
      // PL-12 and PL-14: a staff email never becomes a customer session; disabled users cannot sign in.
      signIn({ user }) {
        const row = user as Partial<{ audience: string; status: string }>;
        if (row.audience === "staff") return `/${seg}/account/login/error?error=StaffEmail`;
        if (row.status === "disabled") return `/${seg}/account/login/error?error=AccessDenied`;
        return true;
      },
      redirect({ url: target, baseUrl }) {
        if (target.startsWith("/")) return `${baseUrl}${target}`;
        try {
          if (new URL(target).origin === baseUrl) return target;
        } catch {
          // fall through
        }
        return `${baseUrl}/${seg}/account`;
      },
    },
  };
}

