/**
 * MFA recovery codes (PL-4, PL-5): 10 codes `xxxxx-xxxxx` in Crockford base32, shown once,
 * stored only as sha256 hashes. Uses WebCrypto (`globalThis.crypto`), no Node import.
 */
export const RECOVERY_CODE_COUNT = 10;
/** With this many codes left or fewer, the admin shows a "regenerate" banner. */
export const RECOVERY_CODES_LOW = 2;
export const CROCKFORD_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

const CODE_PATTERN = /^[0-9a-hjkmnp-tv-z]{5}-[0-9a-hjkmnp-tv-z]{5}$/;

export type RandomBytes = (n: number) => Uint8Array;

const defaultRandom: RandomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

/** One code from 50 random bits (10 base32 characters). */
export function generateRecoveryCode(randomBytes: RandomBytes = defaultRandom): string {
  const bytes = randomBytes(10);
  let out = "";
  for (let i = 0; i < 10; i++) out += CROCKFORD_ALPHABET[(bytes[i] ?? 0) & 31];
  return `${out.slice(0, 5)}-${out.slice(5)}`;
}

/** `count` distinct codes. */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT, randomBytes: RandomBytes = defaultRandom): string[] {
  const codes = new Set<string>();
  let guard = 0;
  while (codes.size < count) {
    codes.add(generateRecoveryCode(randomBytes));
    if (++guard > count * 100) throw new Error("random source does not produce distinct codes");
  }
  return [...codes];
}

/**
 * Normalises what a person typed: case, spaces and hyphens are ignored, and Crockford's
 * look-alikes map (`i`/`l` -> `1`, `o` -> `0`). Returns `xxxxx-xxxxx` or `null`.
 */
export function normalizeRecoveryCode(input: string): string | null {
  const raw = input
    .toLowerCase()
    .replace(/[\s-]/g, "")
    .replace(/[il]/g, "1")
    .replace(/o/g, "0");
  if (raw.length !== 10) return null;
  const code = `${raw.slice(0, 5)}-${raw.slice(5)}`;
  return CODE_PATTERN.test(code) ? code : null;
}

export function isRecoveryCodeFormat(code: string): boolean {
  return CODE_PATTERN.test(code);
}

/** sha256 hex of the normalised code. */
export async function hashRecoveryCode(code: string): Promise<string> {
  const normal = normalizeRecoveryCode(code);
  if (!normal) throw new RangeError("not a recovery code");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(normal));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The index of the stored hash that `input` matches, or -1. The caller removes it (one use only). */
export async function findRecoveryCode(input: string, hashes: readonly string[]): Promise<number> {
  if (!normalizeRecoveryCode(input)) return -1;
  const hash = await hashRecoveryCode(input);
  return hashes.indexOf(hash);
}
