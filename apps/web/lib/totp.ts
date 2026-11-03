/**
 * TOTP for staff (PL-3, PL-4): 6 digits, 30 s, SHA-1, ±1 step, issuer `BEAM`. `verifyTotp`
 * returns the time step the code matched, so the caller stores it and refuses the same code
 * again (`afterCounter`); a code is never accepted twice.
 */
import { Secret, TOTP } from "otpauth";

export const TOTP_ISSUER = "BEAM";
export const TOTP_PERIOD = 30;
export const TOTP_DIGITS = 6;
export const TOTP_WINDOW = 1;

/** A new random secret (160 bits) in base32. */
export function generateTotpSecret(): string {
  return new Secret({ size: 20 }).base32;
}

/** The time step of `now`. */
export function totpCounter(now: Date): number {
  return Math.floor(now.getTime() / 1000 / TOTP_PERIOD);
}

/** The code of `secret` at `now` (seed scripts, e2e support and tests). */
export function generateTotp(secret: string, now: Date = new Date()): string {
  return TOTP.generate({ secret: Secret.fromBase32(secret), algorithm: "SHA1", digits: TOTP_DIGITS, period: TOTP_PERIOD, timestamp: now.getTime() });
}

/**
 * Checks a 6-digit code at `now` with a window of ±1 step. Returns the matched step, or `null`
 * when the code is wrong, malformed, or its step is not after `opts.afterCounter` (replay).
 */
export function verifyTotp(secret: string, code: string, now: Date, opts: { afterCounter?: number | null } = {}): number | null {
  const token = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(token)) return null;
  let key: Secret;
  try {
    key = Secret.fromBase32(secret);
  } catch {
    return null;
  }
  const delta = TOTP.validate({
    token,
    secret: key,
    algorithm: "SHA1",
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD,
    timestamp: now.getTime(),
    window: TOTP_WINDOW,
  });
  if (delta === null) return null;
  const counter = totpCounter(now) + delta;
  if (opts.afterCounter !== undefined && opts.afterCounter !== null && counter <= opts.afterCounter) return null;
  return counter;
}

/** The `otpauth://` URI shown as a QR code at enrolment. */
export function totpUri(secret: string, label: string): string {
  return new TOTP({
    issuer: TOTP_ISSUER,
    label,
    secret: Secret.fromBase32(secret),
    algorithm: "SHA1",
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD,
  }).toString();
}
