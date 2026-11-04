/**
 * Consent and suppression rules (crm rules 3.13 to 3.22, 3.53). Pure decisions; crm's api
 * performs the writes.
 */
import {
  MARKETING_PURPOSES,
  type ConsentMethod,
  type ConsentPurpose,
  type ConsentRecordLike,
  type ConsentState,
  type LawfulBasis,
  type MarketingPurpose,
  type SuppressionLike,
} from "./types";

/** Days a preference link may change more than an unsubscribe (crm 4.4). */
export const PREFERENCE_EDIT_WINDOW_DAYS = 365;

/** Methods whose newer grant lifts a scoped `unsubscribe` suppression (rule 3.19). */
export const LIFTING_METHODS: readonly ConsentMethod[] = ["form", "portal", "preference_centre"];

export function isMarketingPurpose(purpose: string): purpose is MarketingPurpose {
  return (MARKETING_PURPOSES as readonly string[]).includes(purpose);
}

const time = (d: Date | undefined) => (d ? d.getTime() : 0);

/** Sort key of rule 3.13: `recorded_at`, then `created_at`, then `id` (all descending). */
export function compareConsentRecords(a: ConsentRecordLike, b: ConsentRecordLike): number {
  return (
    time(b.recordedAt) - time(a.recordedAt) || time(b.createdAt) - time(a.createdAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
  );
}

/** The latest record of a list (one purpose), or null. */
export function latestConsentRecord<R extends ConsentRecordLike>(records: readonly R[]): R | null {
  return [...records].sort(compareConsentRecords)[0] ?? null;
}

/** The current consent state of one purpose (rule 3.13, `v_consent_current`). */
export function latestConsent(records: readonly ConsentRecordLike[]): ConsentState | null {
  const r = latestConsentRecord(records);
  if (!r) return null;
  return {
    status: r.status,
    method: r.method,
    source: r.source,
    wordingVersion: r.wordingVersion,
    recordedAt: r.recordedAt,
    ...(r.lawfulBasis ? { lawfulBasis: r.lawfulBasis } : {}),
  };
}

/** The current state per purpose. */
export function currentConsents(records: readonly ConsentRecordLike[]): Partial<Record<ConsentPurpose, ConsentState>> {
  const byPurpose = new Map<ConsentPurpose, ConsentRecordLike[]>();
  for (const r of records) byPurpose.set(r.purpose, [...(byPurpose.get(r.purpose) ?? []), r]);
  const out: Partial<Record<ConsentPurpose, ConsentState>> = {};
  for (const [purpose, list] of byPurpose) {
    const s = latestConsent(list);
    if (s) out[purpose] = s;
  }
  return out;
}

/**
 * Rule 3.19: does this suppression block marketing for its scope? Scope `all` and the reasons
 * `hard_bounce`, `complaint`, `manual` and `erased` block forever. A scoped `unsubscribe` stops
 * blocking once the current consent of that purpose is a grant through form, portal or the
 * preference centre recorded after the suppression.
 */
export function suppressionBlocks(input: { suppression: SuppressionLike; currentConsent: ConsentState | null | undefined }): boolean {
  const { suppression, currentConsent } = input;
  if (suppression.scope === "all" || suppression.reason !== "unsubscribe") return true;
  const c = currentConsent;
  const lifted = !!c && c.status === "granted" && LIFTING_METHODS.includes(c.method) && c.recordedAt.getTime() > suppression.createdAt.getTime();
  return !lifted;
}

/** Whether an address is suppressed for a marketing purpose given its suppressions (`v_suppression_status`). */
export function isSuppressedFor(input: {
  purpose: MarketingPurpose;
  suppressions: readonly SuppressionLike[];
  currentConsent: ConsentState | null | undefined;
}): boolean {
  return input.suppressions.some(
    (s) => (s.scope === "all" || s.scope === input.purpose) && suppressionBlocks({ suppression: s, currentConsent: input.currentConsent }),
  );
}

/**
 * Rule 3.20: an imported grant is skipped when the address is suppressed for that scope or
 * `all` (whatever the reason, imports never lift a suppression), or the person has any
 * `withdrawn` record for the purpose.
 */
export function importGrantDecision(input: {
  existingRecords: readonly ConsentRecordLike[];
  suppressions: readonly Pick<SuppressionLike, "scope">[];
  purpose: ConsentPurpose;
}): "record" | "skip" {
  const { purpose } = input;
  if (input.existingRecords.some((r) => r.purpose === purpose && r.status === "withdrawn")) return "skip";
  if (input.suppressions.some((s) => s.scope === "all" || s.scope === purpose)) return "skip";
  return "record";
}

const WORDING_RE = /^(newsletter|events|member_comms|b2b|assessment_result|sensitive_processing|ai_processing)@([1-9][0-9]*)$/;
const FORM_WORDING_RE = /^form:[a-z0-9][a-z0-9_-]*:v[1-9][0-9]*:[a-z0-9_]+$/;

/** A form wording version `form:<slug>:v<version>:<field_key>` (forms owns the wording). */
export function isFormWordingVersion(value: string): boolean {
  return FORM_WORDING_RE.test(value);
}

/** `<purpose>@<version>` parsed, or null. */
export function parseWordingVersion(value: string): { purpose: ConsentPurpose; version: number } | null {
  const m = WORDING_RE.exec(value);
  return m ? { purpose: m[1] as ConsentPurpose, version: Number(m[2]) } : null;
}

/**
 * Rule 3.14: which `wording_version` strings a grant may carry. `portal` and
 * `preference_centre` need `<purpose>@<version>` of the same purpose; `form` also accepts
 * `form:<slug>:v<version>:<field_key>`; `import` also accepts `legacy-import`; staff grants
 * are `b2b` with legitimate interest only, or, for staff-assisted form entry (forms ID10), a
 * form wording version with lawful basis `consent`. Withdrawals carry `unsubscribe`,
 * `complaint`, `restriction` or a wording version.
 */
export function validateConsentInput(input: {
  purpose: ConsentPurpose;
  status: "granted" | "withdrawn";
  method: ConsentMethod;
  wordingVersion: string;
  lawfulBasis?: LawfulBasis;
}): { ok: true } | { ok: false; reason: string } {
  const { purpose, status, method, wordingVersion } = input;
  const own = parseWordingVersion(wordingVersion);
  const ownMatches = !!own && own.purpose === purpose;
  if (status === "withdrawn") {
    if (ownMatches || ["unsubscribe", "complaint", "restriction", "legacy-import"].includes(wordingVersion) || FORM_WORDING_RE.test(wordingVersion)) return { ok: true };
    return { ok: false, reason: "invalid_wording_version" };
  }
  if (method === "staff") {
    if (FORM_WORDING_RE.test(wordingVersion)) {
      return (input.lawfulBasis ?? "consent") === "consent" ? { ok: true } : { ok: false, reason: "staff_form_grant_consent_only" };
    }
    if (purpose !== "b2b" || input.lawfulBasis !== "legitimate_interest") return { ok: false, reason: "staff_grant_b2b_legitimate_interest_only" };
    return ownMatches ? { ok: true } : { ok: false, reason: "invalid_wording_version" };
  }
  if (method === "portal" || method === "preference_centre") return ownMatches ? { ok: true } : { ok: false, reason: "invalid_wording_version" };
  if (method === "form") return ownMatches || FORM_WORDING_RE.test(wordingVersion) ? { ok: true } : { ok: false, reason: "invalid_wording_version" };
  if (method === "import") return ownMatches || wordingVersion === "legacy-import" ? { ok: true } : { ok: false, reason: "invalid_wording_version" };
  return { ok: false, reason: "method_cannot_grant" };
}

/**
 * Rule 3.21: a form grant for a purpose blocked by a scoped `unsubscribe` suppression is not
 * recorded directly; the person confirms through the preference centre.
 */
export function formGrantNeedsConfirmation(input: {
  purpose: MarketingPurpose;
  suppressions: readonly SuppressionLike[];
  currentConsent: ConsentState | null | undefined;
}): boolean {
  return input.suppressions.some(
    (s) => s.scope === input.purpose && s.reason === "unsubscribe" && suppressionBlocks({ suppression: s, currentConsent: input.currentConsent }),
  );
}

/** Rule 3.17: the purposes "unsubscribe from everything" withdraws (every currently granted one). */
export function purposesToWithdraw(current: Partial<Record<ConsentPurpose, ConsentState | null>>): MarketingPurpose[] {
  return MARKETING_PURPOSES.filter((p) => current[p]?.status === "granted");
}

/** The 365-day window in which a preference link may change more than an unsubscribe (crm 4.4). */
export function canEditPreferences(sentAt: Date, now: Date): boolean {
  return now.getTime() - sentAt.getTime() <= PREFERENCE_EDIT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
}
