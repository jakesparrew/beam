/**
 * Claim tokens (booking spec R43, decision 24): `base64url(HMAC-SHA256(key, 'claim:<entry_id>:<offers_count>'))`
 * with a key derived by HKDF from `AUTH_SECRET` (info `beam-claim-v1`). Only `sha256` hex of the
 * token is stored (`waitlist_entries.claim_token_hash`). `@beam/core` is pure and may not import
 * `node:crypto`, and WebCrypto is async, so SHA-256, HMAC and HKDF are implemented here (FIPS
 * 180-4, RFC 2104, RFC 5869); the tests check them against the published vectors.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const encoder = new TextEncoder();
const bytes = (input: Uint8Array | string): Uint8Array => (typeof input === "string" ? encoder.encode(input) : input);

/** SHA-256 digest (32 bytes). */
export function sha256(input: Uint8Array | string): Uint8Array {
  const msg = bytes(input);
  const bitLen = msg.length * 8;
  const padded = new Uint8Array(((msg.length + 9 + 63) >> 6) << 6);
  padded.set(msg);
  padded[msg.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000));
  view.setUint32(padded.length - 4, bitLen >>> 0);

  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
    h[5] = (h[5]! + f) >>> 0;
    h[6] = (h[6]! + g) >>> 0;
    h[7] = (h[7]! + hh) >>> 0;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i]!);
  return out;
}

/** HMAC-SHA256 (RFC 2104). */
export function hmacSha256(key: Uint8Array | string, message: Uint8Array | string): Uint8Array {
  let k = bytes(key);
  if (k.length > 64) k = sha256(k);
  const ipad = new Uint8Array(64);
  const opad = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    const kb = k[i] ?? 0;
    ipad[i] = kb ^ 0x36;
    opad[i] = kb ^ 0x5c;
  }
  const msg = bytes(message);
  const inner = new Uint8Array(64 + msg.length);
  inner.set(ipad);
  inner.set(msg, 64);
  const innerHash = sha256(inner);
  const outer = new Uint8Array(96);
  outer.set(opad);
  outer.set(innerHash, 64);
  return sha256(outer);
}

/** HKDF-SHA256 (RFC 5869). */
export function hkdfSha256(ikm: Uint8Array | string, salt: Uint8Array | string, info: Uint8Array | string, length = 32): Uint8Array {
  const saltBytes = bytes(salt);
  const prk = hmacSha256(saltBytes.length ? saltBytes : new Uint8Array(32), ikm);
  const infoBytes = bytes(info);
  const out = new Uint8Array(length);
  let prev = new Uint8Array(0);
  for (let i = 1, pos = 0; pos < length; i++) {
    const block = new Uint8Array(prev.length + infoBytes.length + 1);
    block.set(prev);
    block.set(infoBytes, prev.length);
    block[block.length - 1] = i;
    prev = hmacSha256(prk, block) as Uint8Array<ArrayBuffer>;
    out.set(prev.subarray(0, Math.min(32, length - pos)), pos);
    pos += 32;
  }
  return out;
}

export function toHex(data: Uint8Array): string {
  let s = "";
  for (const b of data) s += b.toString(16).padStart(2, "0");
  return s;
}

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Unpadded base64url. */
export function toBase64Url(data: Uint8Array): string {
  let out = "";
  for (let i = 0; i < data.length; i += 3) {
    const n = (data[i]! << 16) | ((data[i + 1] ?? 0) << 8) | (data[i + 2] ?? 0);
    out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]!;
    if (i + 1 < data.length) out += B64URL[(n >> 6) & 63]!;
    if (i + 2 < data.length) out += B64URL[n & 63]!;
  }
  return out;
}

/** The claim-token key: `HKDF(AUTH_SECRET, info 'beam-claim-v1')`, 32 bytes. */
export function deriveClaimKey(authSecret: string): Uint8Array {
  return hkdfSha256(authSecret, "", "beam-claim-v1", 32);
}

/** R43: the claim token of an entry's current offer (43 base64url characters). */
export function claimToken(key: Uint8Array, entryId: string, offersCount: number): string {
  return toBase64Url(hmacSha256(key, `claim:${entryId}:${offersCount}`));
}

/** `claim_token_hash`: sha256 hex (64 characters) of the token. */
export function hashToken(token: string): string {
  return toHex(sha256(token));
}
