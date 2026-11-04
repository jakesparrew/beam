/**
 * Stateless forms tokens (forms spec rules ID5, ID6, A1, U5 and the `fsid` ownership cookie).
 * Every key is derived by HKDF-SHA256 from `AUTH_SECRET` with its own `info`, so a token of one
 * kind can never be replayed as another:
 *
 * - identity token `pt` = `base64url(payload).base64url(hmac)`, payload `{ p, f, e, s? }` (ID5);
 * - result token = `base64url(HMAC(submission_id ':' version))`, 43 chars, only its sha256 stored (ID6);
 * - `embedContext` = the signed site context `FormEmbed` renders (A1); tampering voids it;
 * - `fsid` = HMAC of a submission id (proof of ownership on save and submit);
 * - the client IP is stored only as an HMAC (`ip_hash`, decision 29).
 */
import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { URL_SEGMENT, type Locale } from "@beam/core/i18n";

const DEV_SECRET = "beam-forms-insecure-development-secret";

const keys = new Map<string, Buffer>();

/** The HKDF key for one token kind; outside production a missing `AUTH_SECRET` uses a fixed dev secret. */
function keyFor(info: string): Buffer {
  const secret = process.env.AUTH_SECRET || (process.env.NODE_ENV === "production" ? "" : DEV_SECRET);
  if (!secret) throw new Error("AUTH_SECRET is not set");
  const cacheKey = `${info}\u0000${secret}`;
  let key = keys.get(cacheKey);
  if (!key) {
    key = Buffer.from(hkdfSync("sha256", secret, "", info, 32));
    keys.set(cacheKey, key);
  }
  return key;
}

const b64 = (b: Buffer | string): string => Buffer.from(b).toString("base64url");
const mac = (info: string, data: string): Buffer => createHmac("sha256", keyFor(info)).update(data).digest();

function sameBytes(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** sha256 hex of a token (what the database stores for result and resume tokens). */
export function hashToken(t: string): string {
  return createHash("sha256").update(t).digest("hex");
}

/** A random 32-byte token (resume tokens). */
export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

// ---------------------------------------------------------------------------
// Identity tokens (ID5, ID7, ID10)
// ---------------------------------------------------------------------------

export const IDENTITY_TTL_DAYS = 30;
export const STAFF_ENTRY_TTL_SECONDS = 2 * 60 * 60;

const IdentityPayload = z.object({
  p: z.uuid(),
  f: z.string().max(64).nullable(),
  e: z.number().int().positive(),
  s: z.uuid().optional(),
});

export type IdentityClaims = { personId: string; formSlug: string | null; expiresAt: Date; staffUserId: string | null };

/** ID5: `base64url(payload).base64url(hmac)`; `staffUserId` only for staff-assisted entry (ID10). */
export function createIdentityToken(i: { personId: string; formSlug?: string | null; ttlSeconds: number; staffUserId?: string; now?: Date }): string {
  const now = i.now ?? new Date();
  const payload = {
    p: i.personId,
    f: i.formSlug ?? null,
    e: Math.floor(now.getTime() / 1000) + Math.max(1, Math.floor(i.ttlSeconds)),
    ...(i.staffUserId ? { s: i.staffUserId } : {}),
  };
  const body = b64(JSON.stringify(payload));
  return `${body}.${b64(mac("beam-forms-identity", body))}`;
}

/** The claims of a valid, unexpired identity token, or null (tampered, malformed or expired). */
export function verifyIdentityToken(token: string | null | undefined, now: Date = new Date()): IdentityClaims | null {
  if (!token || typeof token !== "string" || token.length > 1000) return null;
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  if (!sameBytes(parts[1], b64(mac("beam-forms-identity", parts[0])))) return null;
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const parsed = IdentityPayload.safeParse(json);
  if (!parsed.success) return null;
  const expiresAt = new Date(parsed.data.e * 1000);
  if (expiresAt.getTime() <= now.getTime()) return null;
  return { personId: parsed.data.p, formSlug: parsed.data.f, expiresAt, staffUserId: parsed.data.s ?? null };
}

// ---------------------------------------------------------------------------
// Result tokens (ID6)
// ---------------------------------------------------------------------------

export const RESULT_TOKEN_DAYS = 180;

/** ID6: deterministic per submission and `result_token_version`; bumping the version revokes it. */
export function createResultToken(submissionId: string, version: number): string {
  return b64(mac("beam-forms-result", `${submissionId}:${version}`));
}

// ---------------------------------------------------------------------------
// fsid cookie and IP hash
// ---------------------------------------------------------------------------

/** The signed `fsid` cookie value for a submission (set by `start`, 24 hours). */
export function signSubmissionId(submissionId: string): string {
  return `${submissionId}.${b64(mac("beam-forms-fsid", submissionId))}`;
}

/** The submission id of a valid `fsid` value, or null. */
export function verifySubmissionCookie(value: string | null | undefined): string | null {
  if (!value || typeof value !== "string") return null;
  const i = value.lastIndexOf(".");
  if (i <= 0) return null;
  const id = value.slice(0, i);
  return sameBytes(value.slice(i + 1), b64(mac("beam-forms-fsid", id))) ? id : null;
}

/** `ip_hash`: HMAC of the client IP (never stored in plain form). */
export function hashIp(ip: string): string {
  return mac("beam-forms-ip", ip.trim().toLowerCase()).toString("hex");
}

// ---------------------------------------------------------------------------
// Embed context (A1)
// ---------------------------------------------------------------------------

const UtmShape = z
  .object({ source: z.string(), medium: z.string(), campaign: z.string(), term: z.string(), content: z.string() })
  .partial();

export const EmbedContextSchema = z.object({
  pagePath: z.string().max(2000),
  landingPath: z.string().max(2000).optional(),
  referrer: z.string().max(2000).optional(),
  partnerCompanyId: z.uuid().optional(),
  utm: UtmShape.optional(),
});
export type EmbedContext = z.infer<typeof EmbedContextSchema>;

/** Signs the site context of `FormEmbed` (key info `beam-forms-embed`). */
export function signEmbedContext(context: EmbedContext): string {
  const body = b64(JSON.stringify(EmbedContextSchema.parse(context)));
  return `${body}.${b64(mac("beam-forms-embed", body))}`;
}

/** The context of a valid signature, or null: unsigned or tampered context is ignored (A1). */
export function verifyEmbedContext(token: string | null | undefined): EmbedContext | null {
  if (!token || typeof token !== "string" || token.length > 10_000) return null;
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  if (!sameBytes(parts[1], b64(mac("beam-forms-embed", parts[0])))) return null;
  try {
    const parsed = EmbedContextSchema.safeParse(JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

/** The app origin (`APP_URL`, no trailing slash). */
export function appOrigin(): string {
  return (process.env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}

/** `/<nl|fr|en>` for a locale. */
export function localeSegment(locale: Locale): string {
  return URL_SEGMENT[locale];
}

/** The absolute hosted form URL `/<seg>/f/<slug>`. */
export function hostedFormUrl(slug: string, locale: Locale, params?: Record<string, string | undefined>): string {
  const url = new URL(`${appOrigin()}/${localeSegment(locale)}/f/${slug}`);
  for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined && v !== "") url.searchParams.set(k, v);
  return url.toString();
}

/** The absolute result page URL `/<seg>/f/<slug>/r/<token>`. */
export function resultPageUrl(slug: string, locale: Locale, token: string): string {
  return `${appOrigin()}/${localeSegment(locale)}/f/${slug}/r/${token}`;
}

/** The CTA redirect route of a result (`go/[ctaKey]`). */
export function ctaRedirectUrl(token: string, ctaKey: string): string {
  return `${appOrigin()}/api/public/forms/result/${token}/go/${ctaKey}`;
}
