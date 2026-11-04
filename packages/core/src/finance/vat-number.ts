/**
 * VAT number validation (finance rule 17, edge case 18). Belgian numbers are normalised to
 * `BE` + 10 digits and must pass the mod-97 check (`97 - (first 8 digits mod 97) = last 2
 * digits`); other EU numbers must match their country format. No VIES call in V1.
 */

/** Format of each EU VAT number after the country prefix (VIES formats; `EL` is Greece, `XI` Northern Ireland). */
export const VAT_NUMBER_FORMATS: Readonly<Record<string, RegExp>> = {
  AT: /^U\d{8}$/,
  BE: /^[01]\d{9}$/,
  BG: /^\d{9,10}$/,
  CY: /^\d{8}[A-Z]$/,
  CZ: /^\d{8,10}$/,
  DE: /^\d{9}$/,
  DK: /^\d{8}$/,
  EE: /^\d{9}$/,
  EL: /^\d{9}$/,
  ES: /^[0-9A-Z]\d{7}[0-9A-Z]$/,
  FI: /^\d{8}$/,
  FR: /^[0-9A-HJ-NP-Z]{2}\d{9}$/,
  HR: /^\d{11}$/,
  HU: /^\d{8}$/,
  IE: /^\d[0-9A-Z+*]\d{5}[A-W][A-I]?$/,
  IT: /^\d{11}$/,
  LT: /^(\d{9}|\d{12})$/,
  LU: /^\d{8}$/,
  LV: /^\d{11}$/,
  MT: /^\d{8}$/,
  NL: /^\d{9}B\d{2}$/,
  PL: /^\d{10}$/,
  PT: /^\d{9}$/,
  RO: /^\d{2,10}$/,
  SE: /^\d{12}$/,
  SI: /^\d{8}$/,
  SK: /^\d{10}$/,
  XI: /^(\d{9}|\d{12}|GD\d{3}|HA\d{3})$/,
};

/** True when ten Belgian digits pass the mod-97 check. */
export function isBelgianChecksumValid(digits: string): boolean {
  if (!/^\d{10}$/.test(digits)) return false;
  return 97 - (Number(digits.slice(0, 8)) % 97) === Number(digits.slice(8));
}

/**
 * `"be 0123.456.749"` -> `{ ok: true, value: "BE0123456749" }`. Spaces, dots, dashes and slashes
 * are removed and letters upper-cased. Bare digits are Belgian (nine-digit legacy numbers get
 * their leading 0). `GR` is accepted for Greece and stored as `EL`.
 */
export function normaliseVatNumber(input: string): { ok: true; value: string } | { ok: false; reason: "format" | "checksum" } {
  let s = input.replace(/[\s.\-/]/g, "").toUpperCase();
  if (/^\d{9,10}$/.test(s)) s = `BE${s}`;
  const m = /^([A-Z]{2})([0-9A-Z+*]+)$/.exec(s);
  if (!m) return { ok: false, reason: "format" };
  const country = m[1] === "GR" ? "EL" : m[1]!;
  let rest = m[2]!;
  if (country === "BE" && /^\d{9}$/.test(rest)) rest = `0${rest}`;
  const format = VAT_NUMBER_FORMATS[country];
  if (!format || !format.test(rest)) return { ok: false, reason: "format" };
  if (country === "BE" && !isBelgianChecksumValid(rest)) return { ok: false, reason: "checksum" };
  return { ok: true, value: `${country}${rest}` };
}

/** The Peppol participant id of a Belgian VAT number (`0208:` + enterprise number); `null` otherwise. */
export function peppolIdFromVatNumber(vatNumber: string | null | undefined): string | null {
  if (!vatNumber) return null;
  const n = normaliseVatNumber(vatNumber);
  return n.ok && n.value.startsWith("BE") ? `0208:${n.value.slice(2)}` : null;
}
