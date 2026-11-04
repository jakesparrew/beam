/**
 * Gift voucher codes and payment-link tokens (commerce rules 41 and 45), with Web Crypto only,
 * so the same code runs in Node, the edge and tests.
 *
 * A voucher code is `BEAM-XXXX-XXXX-XXXX`: 12 Crockford base32 characters (60 bits) of
 * `HMAC-SHA256(VOUCHER_CODE_SECRET, 'voucher:' + voucher_id)`. It is derived again whenever it
 * is needed and stored only as `sha256(normalised code)` plus its last four characters.
 */

/** Crockford base32 (no I, L, O, U). */
export const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const VOUCHER_CODE_PREFIX = "BEAM";
const CODE_LENGTH = 12;
const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{12}$/;

const encoder = new TextEncoder();

async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  if (!secret) throw new Error("hmac: an empty secret is not allowed");
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

/** Lower-case hex sha256 of a string. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The first `chars * 5` bits of `bytes` in Crockford base32. */
export function crockfordBits(bytes: Uint8Array, chars: number): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  let i = 0;
  while (out.length < chars) {
    if (bits < 5) {
      if (i >= bytes.length) throw new RangeError("crockfordBits: not enough bytes");
      buffer = ((buffer << 8) | bytes[i++]!) & 0xffff;
      bits += 8;
    }
    out += CROCKFORD_ALPHABET[(buffer >> (bits - 5)) & 31];
    bits -= 5;
  }
  return out;
}

/** `BEAM-XXXX-XXXX-XXXX` from the 12 code characters. */
export function formatVoucherCode(code12: string): string {
  return `${VOUCHER_CODE_PREFIX}-${code12.slice(0, 4)}-${code12.slice(4, 8)}-${code12.slice(8, 12)}`;
}

/** The voucher's code, derived from the secret and its id (rule 45). */
export async function deriveVoucherCode(secret: string, voucherId: string): Promise<string> {
  const mac = await hmacSha256(secret, `voucher:${voucherId}`);
  return formatVoucherCode(crockfordBits(mac, CODE_LENGTH));
}

/**
 * What a person typed, in the canonical 12-character form: upper case, spaces and dashes
 * removed, `O` read as `0`, `I` and `L` as `1`, and the `BEAM` prefix dropped.
 */
export function normaliseVoucherCode(input: string): string {
  let code = input
    .toUpperCase()
    .replace(/[\s\-_]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  if (code.length === CODE_LENGTH + VOUCHER_CODE_PREFIX.length && code.startsWith(VOUCHER_CODE_PREFIX)) {
    code = code.slice(VOUCHER_CODE_PREFIX.length);
  }
  return code;
}

/** True when the normalised input can be a voucher code at all (12 Crockford characters). */
export function isVoucherCodeFormat(input: string): boolean {
  return CODE_RE.test(normaliseVoucherCode(input));
}

/** `vouchers.code_hash`: sha256 of the normalised code. */
export function hashVoucherCode(code: string): Promise<string> {
  return sha256Hex(normaliseVoucherCode(code));
}

/** `vouchers.code_last4`. */
export function voucherCodeLast4(code: string): string {
  return normaliseVoucherCode(code).slice(-4);
}

/** Constant-time comparison of two strings of equal length (edge case 19). */
export function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * The payment-link token of rule 41: `base64url(HMAC-SHA256(secret, 'pay:' + order_id + ':' +
 * expiry epoch seconds))`. Derived, so the same order and expiry always give the same URL.
 */
export async function derivePayToken(secret: string, orderId: string, expiresAt: Date): Promise<string> {
  const seconds = Math.floor(expiresAt.getTime() / 1000);
  return base64url(await hmacSha256(secret, `pay:${orderId}:${seconds}`));
}
