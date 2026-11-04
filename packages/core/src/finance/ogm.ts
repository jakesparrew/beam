/**
 * Belgian structured communication (OGM/VCS, "gestructureerde mededeling") for bank-transfer
 * invoices (finance rule 2, decision 10). Twelve digits: a ten-digit base, here the two-digit
 * fiscal year followed by the invoice sequence number on eight digits, plus a two-digit check
 * `base mod 97` (a remainder of 0 becomes 97). Printed as `+++DDD/DDDD/DDDDD+++`:
 * year 2026, number 123 -> `+++260/0000/12395+++`.
 */

/** The check digits of a ten-digit base: `base mod 97`, with 0 written as 97. */
export function ogmCheckDigits(base: string): string {
  if (!/^\d{10}$/.test(base)) throw new RangeError(`ogmCheckDigits: ten digits expected, got ${base}`);
  const remainder = Number(BigInt(base) % 97n);
  return String(remainder === 0 ? 97 : remainder).padStart(2, "0");
}

/** `+++DDD/DDDD/DDDDD+++` from twelve digits. */
export function formatStructuredCommunication(digits: string): string {
  if (!/^\d{12}$/.test(digits)) throw new RangeError(`formatStructuredCommunication: twelve digits expected, got ${digits}`);
  return `+++${digits.slice(0, 3)}/${digits.slice(3, 7)}/${digits.slice(7)}+++`;
}

/** The structured communication of invoice `n` of fiscal year `year`. */
export function structuredCommunication(year: number, n: number): string {
  if (!Number.isInteger(year) || year < 2000 || year > 2099) throw new RangeError(`structuredCommunication: bad year ${year}`);
  if (!Number.isInteger(n) || n < 1 || n > 99_999_999) throw new RangeError(`structuredCommunication: bad number ${n}`);
  const base = `${String(year % 100).padStart(2, "0")}${String(n).padStart(8, "0")}`;
  return formatStructuredCommunication(base + ogmCheckDigits(base));
}

/** True for a well-formed structured communication with a correct check (`+++` or `***` delimiters, or bare digits). */
export function isValidStructuredCommunication(value: string): boolean {
  const digits = value.replace(/^(\+{3}|\*{3})|(\+{3}|\*{3})$/g, "").replace(/[\s/]/g, "");
  if (!/^\d{12}$/.test(digits)) return false;
  return ogmCheckDigits(digits.slice(0, 10)) === digits.slice(10);
}
