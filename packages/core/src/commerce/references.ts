/**
 * Customer-facing order references (`orders.reference`): `BO-` plus 8 Crockford base32
 * characters, about 40 bits. Uniqueness is the database's (unique index); a collision is retried
 * by the caller with a new reference.
 */
import { CROCKFORD_ALPHABET } from "./vouchers";

export const ORDER_REFERENCE_RE = /^BO-[0-9A-HJKMNP-TV-Z]{8}$/;

/** A random number in [0, 1) from Web Crypto. */
export function cryptoRandom(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0]! / 2 ** 32;
}

/** A new order reference; `random` returns numbers in [0, 1) (a seeded PRNG in seeds and tests). */
export function newOrderReference(random: () => number = cryptoRandom): string {
  let out = "BO-";
  for (let i = 0; i < 8; i++) {
    const r = random();
    const index = Math.min(31, Math.max(0, Math.floor(r * 32)));
    out += CROCKFORD_ALPHABET[index];
  }
  return out;
}

export function isOrderReference(value: string): boolean {
  return ORDER_REFERENCE_RE.test(value);
}
