/**
 * Duplicate scoring (crm rule 3.28): fixed scores per reason; the highest reason counts, scores
 * never add up. Pairs scoring 50 or more become `open` candidates.
 */
import { gmailCanonical } from "./normalise";
import type { DuplicateReason } from "./types";

export const DUPLICATE_SCORES = {
  external_id: 95,
  email_variant: 90,
  phone: 80,
  name_birth: 70,
  name_postal: 50,
} as const satisfies Record<string, number>;

export type DuplicateReasonKey = keyof typeof DUPLICATE_SCORES;

/** Pairs at or above this score are stored and shown before a create (rules 3.28, 3.29). */
export const DUPLICATE_MIN_SCORE = 50;

export type DupInput = {
  id?: string;
  email?: string | null;
  phoneE164?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  birthOn?: string | null;
  postalCode?: string | null;
  externalIds?: Record<string, string | null | undefined> | null;
};

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

function sameName(a: DupInput, b: DupInput): boolean {
  const [af, al, bf, bl] = [norm(a.firstName), norm(a.lastName), norm(b.firstName), norm(b.lastName)];
  return !!af && !!al && af === bf && al === bl;
}

function sameExternalId(a: DupInput, b: DupInput): boolean {
  const ea = a.externalIds ?? {};
  const eb = b.externalIds ?? {};
  return Object.entries(ea).some(([k, v]) => !!v && eb[k] === v);
}

/** Score and reasons of a pair (reasons ordered by score, highest first). */
export function scorePair(a: DupInput, b: DupInput): { score: number; reasons: DuplicateReason[] } {
  const reasons: DuplicateReasonKey[] = [];
  if (sameExternalId(a, b)) reasons.push("external_id");
  if (a.email && b.email && gmailCanonical(a.email) === gmailCanonical(b.email)) reasons.push("email_variant");
  if (a.phoneE164 && b.phoneE164 && a.phoneE164 === b.phoneE164) reasons.push("phone");
  if (sameName(a, b) && a.birthOn && a.birthOn === b.birthOn) reasons.push("name_birth");
  if (sameName(a, b) && norm(a.postalCode) && norm(a.postalCode) === norm(b.postalCode)) reasons.push("name_postal");
  const score = reasons.reduce((max, r) => Math.max(max, DUPLICATE_SCORES[r]), 0);
  return { score, reasons };
}

/** `[person_a_id, person_b_id]` with `person_a_id < person_b_id` (the table's check). */
export function orderPair(x: string, y: string): [string, string] {
  const [a, b] = [x.toLowerCase(), y.toLowerCase()];
  return a < b ? [a, b] : [b, a];
}
