/**
 * Fixed-window rate limit maths (PL-68, table `rate_limits`). `lib/rate-limit.ts` stores the
 * counter in Postgres; these helpers decide windows, verdicts and `Retry-After`.
 */
export type RateLimitRule = { limit: number; windowSeconds: number };

/** The application limits of PL-68. Bucket names are the key prefixes of `rate_limits.key`. */
export const RATE_LIMITS = {
  login_ip: { limit: 10, windowSeconds: 60 },
  login_account: { limit: 20, windowSeconds: 3600 },
  magic_link: { limit: 5, windowSeconds: 3600 },
  forms_ip: { limit: 20, windowSeconds: 60 },
  webinar_heartbeat: { limit: 8, windowSeconds: 60 },
  webinar_state: { limit: 30, windowSeconds: 60 },
  api_ip: { limit: 60, windowSeconds: 60 },
} as const satisfies Record<string, RateLimitRule>;

export type RateLimitBucket = keyof typeof RATE_LIMITS;

/** `rate_limits.key` per bucket. Emails are passed already hashed (sha256 hex), never in plain text. */
export const rateLimitKey = {
  loginIp: (ip: string) => `login:ip:${ip}`,
  loginAccount: (emailSha256: string) => `login:acct:${emailSha256}`,
  magicLink: (emailSha256: string) => `magic:${emailSha256}`,
  formsIp: (ip: string) => `forms:ip:${ip}`,
  webinarHeartbeat: (registrationId: string) => `webinar_heartbeat:${registrationId}`,
  webinarState: (registrationId: string) => `webinar_state:${registrationId}`,
  apiIp: (ip: string) => `api:ip:${ip}`,
} as const;

/** Paths exempt from the per-IP `/api/*` rule (a venue NAT would otherwise block a room of viewers). */
export const PER_IP_EXEMPT_PATHS = ["/api/webinar/heartbeat", "/api/webinar/state"] as const;

/** Start of the fixed window containing `now` (windows are aligned to the epoch). */
export function windowStart(now: Date, windowSeconds: number): Date {
  if (!(windowSeconds > 0)) throw new RangeError("windowSeconds must be positive");
  const size = windowSeconds * 1000;
  return new Date(Math.floor(now.getTime() / size) * size);
}

export function windowEnd(now: Date, windowSeconds: number): Date {
  return new Date(windowStart(now, windowSeconds).getTime() + windowSeconds * 1000);
}

/** Whole seconds until the window ends, at least 1 (the `Retry-After` value). */
export function retryAfterSeconds(now: Date, windowSeconds: number): number {
  return Math.max(1, Math.ceil((windowEnd(now, windowSeconds).getTime() - now.getTime()) / 1000));
}

export type RateVerdict = { ok: boolean; count: number; retryAfterSeconds: number; windowStart: Date };

/**
 * The verdict after counting one more hit. `stored` is the row as it was (or `null`); a row
 * from an older window starts again at 1 (the `on conflict` rule of `rate_limits`).
 */
export function countHit(
  stored: { windowStart: Date; count: number } | null,
  now: Date,
  rule: RateLimitRule,
): RateVerdict {
  const start = windowStart(now, rule.windowSeconds);
  const count = !stored || stored.windowStart.getTime() < start.getTime() ? 1 : stored.count + 1;
  const ok = count <= rule.limit;
  return { ok, count, retryAfterSeconds: ok ? 0 : retryAfterSeconds(now, rule.windowSeconds), windowStart: start };
}
