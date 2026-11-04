/**
 * Personal access tokens (webinar spec rule 19) and CTA click signatures (rule 36).
 *
 * token = `<registration_id>.<token_version>.<mac>` with
 * `mac = base64url(HMAC-SHA256(k, registration_id + '.' + token_version))[0..32]` and
 * `k = HKDF-SHA256(AUTH_SECRET, 'beam-webinar-access-v1')`. `webinar_registrations` stores only
 * `sha256(token)` hex (`hashAccessToken`); verification recomputes the MAC and compares it in
 * constant time, then the caller looks the hash up and checks `token_version` (bumping it
 * revokes old links). Raw tokens are never stored or logged.
 *
 * `@beam/core` may not import `node:crypto`; SHA-256, HMAC and HKDF come from booking's pure
 * implementation (tested against the published vectors there).
 */
import { hkdfSha256, hmacSha256, sha256, toBase64Url, toHex } from "../booking/claim-token";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAC_LENGTH = 32;
const CTA_SIG_LENGTH = 22;

/**
 * Constant-time string comparison: the time depends only on the lengths, never on where the
 * first difference is. Called through `tokenInternals.equal` so a test can prove it is used.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/** Indirection for the comparison (tests spy on it; production never replaces it). */
export const tokenInternals = { equal: constantTimeEqual };

/** `k = HKDF-SHA256(AUTH_SECRET, 'beam-webinar-access-v1')`, 32 bytes. */
export function deriveAccessKey(authSecret: string): Uint8Array {
  return hkdfSha256(authSecret, "", "beam-webinar-access-v1", 32);
}

/** `k_cta = HKDF-SHA256(AUTH_SECRET, 'beam-webinar-cta-v1')`, 32 bytes (rule 36). */
export function deriveCtaKey(authSecret: string): Uint8Array {
  return hkdfSha256(authSecret, "", "beam-webinar-cta-v1", 32);
}

function accessMac(key: Uint8Array, registrationId: string, version: number): string {
  return toBase64Url(hmacSha256(key, `${registrationId}.${version}`)).slice(0, MAC_LENGTH);
}

/** The personal access token of a registration at `version` (rule 19). */
export function signAccessToken(key: Uint8Array, registrationId: string, version: number): string {
  if (!UUID.test(registrationId)) throw new Error("signAccessToken: registrationId must be a lower-case uuid");
  if (!Number.isInteger(version) || version < 1) throw new Error("signAccessToken: version must be a positive integer");
  return `${registrationId}.${version}.${accessMac(key, registrationId, version)}`;
}

/**
 * The registration id and version of a well-formed token whose MAC matches, or `null`. The
 * caller still checks the stored hash and that `version` equals `token_version` (an old
 * version is a revoked link).
 */
export function verifyAccessToken(key: Uint8Array, token: string): { registrationId: string; version: number } | null {
  if (typeof token !== "string" || token.length > 128) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [registrationId, versionText, mac] = parts as [string, string, string];
  if (!UUID.test(registrationId) || !/^[1-9][0-9]{0,4}$/.test(versionText)) return null;
  const version = Number(versionText);
  if (!tokenInternals.equal(mac, accessMac(key, registrationId, version))) return null;
  return { registrationId, version };
}

/** `sha256(token)` hex, the value stored in `webinar_registrations.access_token_hash`. */
export function hashAccessToken(token: string): string {
  return toHex(sha256(token));
}

/** Whether a verified token is the registration's current link (rule 19: old versions are revoked). */
export function isCurrentToken(verified: { version: number }, row: { tokenVersion: number; accessTokenHash: string }, token: string): boolean {
  return verified.version === row.tokenVersion && tokenInternals.equal(hashAccessToken(token), row.accessTokenHash);
}

/** The CTA click signature `base64url(HMAC-SHA256(k_cta, registration_id.cta_id.mode))[0..22]` (rule 36). */
export function signCtaClick(key: Uint8Array, registrationId: string, ctaId: string, mode: string): string {
  return toBase64Url(hmacSha256(key, `${registrationId}.${ctaId}.${mode}`)).slice(0, CTA_SIG_LENGTH);
}

/** Whether `sig` is the click signature of these parameters (constant-time). */
export function verifyCtaClick(key: Uint8Array, registrationId: string, ctaId: string, mode: string, sig: string): boolean {
  if (typeof sig !== "string" || sig.length !== CTA_SIG_LENGTH) return false;
  return tokenInternals.equal(sig, signCtaClick(key, registrationId, ctaId, mode));
}
