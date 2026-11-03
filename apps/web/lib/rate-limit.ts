/**
 * Fixed-window rate limits in `rate_limits` (PL-68), on top of the Vercel WAF rules.
 * `rateLimit()` counts one hit atomically with one upsert; `checkRateLimits()` applies the
 * PL-68 buckets of a route; `rateLimitResponse()` is the 429 with `Retry-After`.
 * The heartbeat and state routes of webinars count per registration and are exempt from the
 * per-IP rule (a room of viewers behind one venue NAT).
 */
import { createHash } from "node:crypto";
import type { DbOrTx } from "@beam/db";
import { PER_IP_EXEMPT_PATHS, RATE_LIMITS, rateLimitKey, retryAfterSeconds, windowStart, type RateLimitRule } from "@beam/core/platform";
import { sql } from "./ctx";
import { rowsOf } from "./sensitive";

export type RateLimitSpec = { key: string; limit: number; windowSeconds: number };
export type RateLimitVerdict = { ok: boolean; retryAfterSeconds: number };

/** Counts one hit on `spec.key` and says whether it is within the limit. */
export async function rateLimit(tx: DbOrTx, spec: RateLimitSpec, now: Date = new Date()): Promise<RateLimitVerdict> {
  const start = windowStart(now, spec.windowSeconds);
  const expires = new Date(start.getTime() + spec.windowSeconds * 1000);
  const rows = rowsOf<{ count: number | string }>(
    await tx.execute(sql`
      insert into rate_limits (key, window_start, count, expires_at)
      values (${spec.key}, ${start.toISOString()}::timestamptz, 1, ${expires.toISOString()}::timestamptz)
      on conflict (key) do update set
        count = case when rate_limits.window_start < excluded.window_start then 1 else rate_limits.count + 1 end,
        window_start = greatest(rate_limits.window_start, excluded.window_start),
        expires_at = greatest(rate_limits.expires_at, excluded.expires_at)
      returning count`),
  );
  const count = Number(rows[0]?.count ?? 1);
  const ok = count <= spec.limit;
  return { ok, retryAfterSeconds: ok ? 0 : retryAfterSeconds(now, spec.windowSeconds) };
}

export const emailDigest = (email: string): string => createHash("sha256").update(email.trim().toLowerCase()).digest("hex");

export type RateLimitRequest =
  | { route: "login"; ip: string; email: string }
  | { route: "magic_link"; email: string }
  | { route: "forms"; ip: string }
  | { route: "webinar_heartbeat"; registrationId: string }
  | { route: "webinar_state"; registrationId: string }
  | { route: "api"; ip: string };

const spec = (key: string, rule: RateLimitRule): RateLimitSpec => ({ key, ...rule });

/** The buckets of PL-68 a request counts against. */
export function bucketsFor(req: RateLimitRequest): RateLimitSpec[] {
  switch (req.route) {
    case "login":
      return [spec(rateLimitKey.loginIp(req.ip), RATE_LIMITS.login_ip), spec(rateLimitKey.loginAccount(emailDigest(req.email)), RATE_LIMITS.login_account)];
    case "magic_link":
      return [spec(rateLimitKey.magicLink(emailDigest(req.email)), RATE_LIMITS.magic_link)];
    case "forms":
      return [spec(rateLimitKey.formsIp(req.ip), RATE_LIMITS.forms_ip)];
    case "webinar_heartbeat":
      return [spec(rateLimitKey.webinarHeartbeat(req.registrationId), RATE_LIMITS.webinar_heartbeat)];
    case "webinar_state":
      return [spec(rateLimitKey.webinarState(req.registrationId), RATE_LIMITS.webinar_state)];
    case "api":
      return [spec(rateLimitKey.apiIp(req.ip), RATE_LIMITS.api_ip)];
  }
}

/** Counts the request in every bucket; refused when any bucket is over its limit. */
export async function checkRateLimits(tx: DbOrTx, req: RateLimitRequest, now: Date = new Date()): Promise<RateLimitVerdict> {
  let verdict: RateLimitVerdict = { ok: true, retryAfterSeconds: 0 };
  for (const s of bucketsFor(req)) {
    const v = await rateLimit(tx, s, now);
    if (!v.ok) verdict = { ok: false, retryAfterSeconds: Math.max(verdict.retryAfterSeconds, v.retryAfterSeconds) };
  }
  return verdict;
}

/** The bucket request of an `/api/*` path (forms 20/min per IP, webinar per registration, else 60/min per IP). */
export function apiRequestFor(pathname: string, ip: string, registrationId?: string | null): RateLimitRequest {
  if (pathname === "/api/webinar/heartbeat" && registrationId) return { route: "webinar_heartbeat", registrationId };
  if (pathname === "/api/webinar/state" && registrationId) return { route: "webinar_state", registrationId };
  if ((PER_IP_EXEMPT_PATHS as readonly string[]).includes(pathname)) {
    // Without a registration id the exempt routes reject the request themselves (Zod); count nothing per IP.
    return { route: pathname.endsWith("heartbeat") ? "webinar_heartbeat" : "webinar_state", registrationId: "unknown" };
  }
  if (pathname.startsWith("/api/public/forms/")) return { route: "forms", ip };
  return { route: "api", ip };
}

/** `429 Too Many Requests` with `Retry-After`. */
export function rateLimitResponse(retryAfter: number): Response {
  return Response.json(
    { error: { code: "rate_limited", message: "Too many requests" } },
    { status: 429, headers: { "retry-after": String(Math.max(1, Math.ceil(retryAfter))), "cache-control": "no-store" } },
  );
}

/** For route handlers: `null` to go on, or the 429 response. */
export async function limitApiRequest(
  tx: DbOrTx,
  input: { pathname: string; ip: string; registrationId?: string | null },
  now: Date = new Date(),
): Promise<Response | null> {
  const verdict = await checkRateLimits(tx, apiRequestFor(input.pathname, input.ip, input.registrationId), now);
  return verdict.ok ? null : rateLimitResponse(verdict.retryAfterSeconds);
}
