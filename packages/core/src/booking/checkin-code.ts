/**
 * Check-in codes (booking spec `bookings.checkin_code`, R35): 10 characters of Crockford
 * base32 (50 random bits), unique per booking, encoded in the QR code.
 */

export const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const CHECKIN_CODE_LENGTH = 10;

const CODE_RE = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{10}$/;

/** A fresh random code; `random` is injectable for tests. */
export function newCheckinCode(random: (n: number) => Uint8Array = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))): string {
  const buf = random(CHECKIN_CODE_LENGTH);
  let out = "";
  for (let i = 0; i < CHECKIN_CODE_LENGTH; i++) out += CROCKFORD_ALPHABET[buf[i]! & 31];
  return out;
}

/** Reads a typed or scanned code the Crockford way: upper case, `O` -> `0`, `I`/`L` -> `1`, separators dropped. */
export function normaliseCheckinCode(input: string): string {
  return input
    .trim()
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}

export function isCheckinCode(code: string): boolean {
  return CODE_RE.test(code);
}
