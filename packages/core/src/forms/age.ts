/**
 * Age on a Brussels calendar day (forms spec rule C5): the marketing age of digital consent is
 * 13 (crm rule 53) and forms refuses the `sensitive_processing` consent under 16. Dates are ISO
 * `YYYY-MM-DD` calendar days; no time zone arithmetic is needed once the day is known.
 */
import { TIME_ZONE } from "../i18n/locales";

/** C5: under this age forms records no marketing consent. */
export const MARKETING_CONSENT_AGE = 13;
/** C5: under this age the `sensitive_processing` consent fails with the guardian message. */
export const SENSITIVE_CONSENT_AGE = 16;

function parts(day: string): [number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) throw new RangeError(`not an ISO date: ${day}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * Completed years on `day`. A person born on 29 February has their birthday on 1 March in a
 * common year (on 28 February they are still a year younger).
 */
export function ageOn(birthOn: string, day: string): number {
  const [by, bm, bd] = parts(birthOn);
  const [y, m, d] = parts(day);
  const beforeBirthday = m < bm || (m === bm && d < bd);
  return y - by - (beforeBirthday ? 1 : 0);
}

/** The Brussels calendar day of an instant, as `YYYY-MM-DD`. */
export function brusselsDay(at: Date): string {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });
  return f.format(at);
}

/** True when the person born on `birthOn` is younger than `years` on `day`. */
export function isUnder(birthOn: string, day: string, years: number): boolean {
  return ageOn(birthOn, day) < years;
}
