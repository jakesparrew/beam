/**
 * Identity normalisation (crm rules 3.1, 3.7, 3.28, 3.45; decision 38: a small in-house
 * Belgian-first phone normaliser, no dependency). Pure: no Node imports, so the sha256 used by
 * `emailHash` is implemented here.
 */

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Trimmed, lower-cased email, or null for an empty or malformed value (rule 3.1). */
export function normaliseEmail(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  if (!value || value.length > 254 || !EMAIL_RE.test(value)) return null;
  return value;
}

/** sha256 hex of the normalised email (`persons.email_hash`, `suppressions.email_hash`). */
export function emailHash(email: string): string {
  return sha256Hex(normaliseEmail(email) ?? email.trim().toLowerCase());
}

const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

/**
 * The comparison form for duplicate detection (rule 3.28): for gmail.com and googlemail.com the
 * local part loses its dots and `+tag` and the domain becomes gmail.com; other addresses are
 * only normalised. A malformed value is returned trimmed and lower-cased.
 */
export function gmailCanonical(email: string): string {
  const value = normaliseEmail(email) ?? email.trim().toLowerCase();
  const at = value.lastIndexOf("@");
  if (at < 1) return value;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (!GMAIL_DOMAINS.has(domain)) return value;
  const base = local.split("+")[0]!.replace(/\./g, "");
  return `${base}@gmail.com`;
}

/** Calling codes of the countries a BEAM customer most often has, for national `0…` numbers. */
const CALLING_CODES: Record<string, string> = { BE: "32", NL: "31", FR: "33", DE: "49", LU: "352", GB: "44" };

/** National significant number lengths (without the trunk 0) accepted per calling code. */
const NSN_LENGTHS: Record<string, readonly number[]> = { "32": [8, 9], "31": [9], "33": [9], "49": [6, 7, 8, 9, 10, 11], "352": [6, 7, 8, 9], "44": [9, 10] };

function e164(code: string, nsn: string): string | null {
  const lengths = NSN_LENGTHS[code];
  if (lengths && !lengths.includes(nsn.length)) return null;
  if (nsn.startsWith("0")) return null;
  const out = `+${code}${nsn}`;
  return /^\+[1-9][0-9]{6,14}$/.test(out) ? out : null;
}

/** Splits `+<digits>` into calling code and national number for the known codes. */
function fromInternational(digits: string): string | null {
  for (const code of ["352", "32", "31", "33", "49", "44"]) {
    if (digits.startsWith(code)) {
      const rest = digits.slice(code.length);
      return e164(code, rest.startsWith("0") ? rest.slice(1) : rest);
    }
  }
  const out = `+${digits}`;
  return /^\+[1-9][0-9]{6,14}$/.test(out) ? out : null;
}

/**
 * E.164 form of a phone number (rule 3.7), default country Belgium: `0470 12 34 56` →
 * `+32470123456`, `0032 470…` → `+32470…`, `+32 (0)470…` → `+32470…`. Returns null when the
 * value cannot be read as a number (the caller keeps `phone` as entered).
 */
export function normalisePhone(raw: string | null | undefined, country = "BE"): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  if (!s) return null;
  s = s.replace(/\(0\)/g, "");
  if (/[^0-9+\s.\-/()]/.test(s)) return null;
  const plus = s.startsWith("+");
  const digits = s.replace(/[^0-9]/g, "");
  if (!digits) return null;
  if (plus) return fromInternational(digits);
  if (digits.startsWith("00")) return fromInternational(digits.slice(2));
  const code = CALLING_CODES[country.toUpperCase()];
  if (!code) return null;
  if (digits.startsWith("0")) return e164(code, digits.slice(1));
  // Belgian mobile typed without the trunk zero (470 12 34 56).
  if (code === "32" && /^4[5-9][0-9]{7}$/.test(digits)) return `+32${digits}`;
  return null;
}

/**
 * Normalised VAT number (rule 3.45): spaces, dots, dashes and slashes removed, upper case;
 * a bare 9- or 10-digit number is Belgian (`0123.456.789` → `BE0123456789`). Null when the
 * result does not look like a VAT number.
 */
export function normaliseVat(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.replace(/[\s.\-/]/g, "").toUpperCase();
  if (!s) return null;
  if (/^[0-9]{9,10}$/.test(s)) s = `BE${s.padStart(10, "0")}`;
  if (s.startsWith("BE")) {
    const digits = s.slice(2);
    if (/^[0-9]{9}$/.test(digits)) s = `BE0${digits}`;
    return /^BE[01][0-9]{9}$/.test(s) ? s : null;
  }
  return /^[A-Z]{2}(?=[0-9A-Z]*[0-9])[0-9A-Z]{2,12}$/.test(s) ? s : null;
}

// ---------------------------------------------------------------------------
// sha256 (FIPS 180-4), UTF-8 input, hex output
// ---------------------------------------------------------------------------

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

/** sha256 of the UTF-8 bytes of `text`, as lower-case hex. */
export function sha256Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const bitLength = bytes.length * 8;
  const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(padded.length - 4, bitLength >>> 0);

  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
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
  return [...h].map((x) => x.toString(16).padStart(8, "0")).join("");
}
