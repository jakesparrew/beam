/**
 * Minors and guardian consent (crm rules 3.53 and 3.54, cross-module D15, decisions 42 and 43).
 * Ages are counted on the Brussels calendar date of `at`.
 */
import type { DeclarationKind, DeclarationStatus } from "./types";

/** The one declaration kind crm stores (cross-module D15). */
export const guardian_consent = "guardian_consent" satisfies DeclarationKind;
export const DECLARATION_KINDS = [guardian_consent] as const;

/** Belgian age of digital consent (law of 30 July 2018, art. 7). */
export const MARKETING_CONSENT_MIN_AGE = 13;
/** Below this age a person is a minor on the reception card. */
export const ADULT_AGE = 18;

const brusselsDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Brussels", year: "numeric", month: "2-digit", day: "2-digit" });

/** `YYYY-MM-DD` of `at` in Europe/Brussels. */
export function brusselsDay(at: Date): string {
  return brusselsDate.format(at);
}

/** Full years between a `YYYY-MM-DD` birth date and the Brussels date of `at`. */
export function ageOn(birthOn: string, at: Date): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthOn);
  if (!m) throw new Error(`ageOn: invalid birth date ${birthOn}`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const [ty, tmo, td] = brusselsDay(at).split("-").map(Number) as [number, number, number];
  let age = ty - y;
  if (tmo < mo || (tmo === mo && td < d)) age -= 1;
  return age;
}

/** Rule 3.53: a marketing grant needs 13 years on `at`; without a birth date the person is an adult. */
export function isMarketingConsentAllowed(input: { birthOn: string | null | undefined; at: Date }): boolean {
  if (!input.birthOn) return true;
  return ageOn(input.birthOn, input.at) >= MARKETING_CONSENT_MIN_AGE;
}

/** Reception card flag: under 18 on `at` (unknown birth date is not a minor). */
export function isMinor(birthOn: string | null | undefined, at: Date): boolean {
  return !!birthOn && ageOn(birthOn, at) < ADULT_AGE;
}

export type LatestDeclaration = {
  status: DeclarationStatus;
  documentVersionId: string;
  expiresAt: Date | null;
};

/**
 * Rule 3.54: the latest declaration is valid when it is accepted, not expired, and either for
 * the current published version or the current version does not require re-acceptance.
 * A revoked latest row is never valid.
 */
export function declarationIsValid(input: {
  latest: LatestDeclaration | null | undefined;
  currentVersionId: string | null | undefined;
  requiresReacceptance: boolean;
  now: Date;
}): boolean {
  const { latest } = input;
  if (!latest || latest.status !== "accepted") return false;
  if (latest.expiresAt && latest.expiresAt.getTime() <= input.now.getTime()) return false;
  if (!input.currentVersionId) return false;
  return latest.documentVersionId === input.currentVersionId || !input.requiresReacceptance;
}
