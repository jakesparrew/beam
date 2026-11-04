/**
 * Consent and suppression api (crm spec 4.8, rules 3.13 to 3.22 and 3.53), crm-P3.
 * `addSuppression` is the only writer of `suppressions` (cross-module D8); it calls automation's
 * `requestSuppressionExit` in the caller's transaction, so running marketing sequences end within
 * seconds of the commit (scenario 2). `consent_records` is append-only: every change appends.
 */
import type { DbOrTx, Tx } from "@beam/db";
import { consentRecords, consentWordings, persons, suppressions } from "@beam/db/schema";
import { URL_SEGMENT, type Locale } from "@beam/core/i18n";
import {
  CONSENT_PURPOSES,
  emailHash,
  formGrantNeedsConfirmation,
  importGrantDecision,
  isMarketingConsentAllowed,
  isMarketingPurpose,
  isSuppressedFor,
  latestConsent,
  normaliseEmail,
  purposesToWithdraw,
  validateConsentInput,
  brusselsDay,
  type ConsentMethod,
  type ConsentOutcome,
  type ConsentPurpose,
  type ConsentRecordLike,
  type ConsentState,
  type LawfulBasis,
  type MarketingPurpose,
  type SuppressionLike,
  type SuppressionReason,
  type SuppressionScope,
} from "@beam/core/crm";
import { actorJson, and, desc, eq, isNotNull, isNull, NotFoundError, sql, ValidationError, type Ctx } from "@/lib/ctx";
import { requestSuppressionExit } from "@/modules/automation/api";
import { sendTransactional } from "@/modules/email/api";
import type { EventCtx } from "../api";
import { hasValidDeclaration } from "../declarations/api";
import { resolveCanonicalPersonId } from "../persons/api";

type PersonRow = typeof persons.$inferSelect;

export type RecordConsentInput = {
  personId: string;
  purpose: ConsentPurpose;
  status: "granted" | "withdrawn";
  method: ConsentMethod;
  source: string;
  wordingVersion: string;
  lawfulBasis?: "consent" | "legitimate_interest";
  ip?: string;
  userAgent?: string;
  recordedAt?: Date;
  ref?: { type: string; id: string };
};

/**
 * Appends one consent record when the rules allow it (rules 3.14 to 3.21, 3.53).
 * `unchanged` when the current state already is the requested one; `skipped_minor` for a
 * marketing grant of a person under 13 without a valid guardian consent; `skipped_suppressed`
 * for an import grant of rule 3.20 or a grant an address suppression blocks forever;
 * `needs_confirmation` for a form grant blocked by a scoped unsubscribe (rule 3.21: crm sends
 * `crm.confirm_resubscribe` instead). A withdrawal of a marketing purpose also suppresses the
 * address for that scope through `addSuppression` (rule 3.16), except imports and complaints.
 */
export async function recordConsent(tx: Tx, ctx: EventCtx, input: RecordConsentInput): Promise<{ recordId: string | null; outcome: ConsentOutcome }> {
  const lawfulBasis: LawfulBasis = input.lawfulBasis ?? "consent";
  const valid = validateConsentInput({ purpose: input.purpose, status: input.status, method: input.method, wordingVersion: input.wordingVersion, lawfulBasis });
  if (!valid.ok) throw new ValidationError(valid.reason, { wordingVersion: valid.reason });
  if (input.status === "granted" && (input.method === "portal" || input.method === "preference_centre" || input.method === "staff")) {
    await assertPublishedWording(tx, input.wordingVersion);
  }
  const person = await activePerson(tx, input.personId);
  const recordedAt = input.recordedAt ?? ctx.now;
  const records = await recordsOf(tx, person.id, input.purpose);
  const current = latestConsent(records);
  const marketing = isMarketingPurpose(input.purpose);

  if (input.status === "withdrawn") {
    if (current?.status === "withdrawn") return { recordId: null, outcome: "unchanged" };
    const recordId = await appendConsent(tx, ctx, person.id, { ...input, lawfulBasis, recordedAt });
    if (marketing && withdrawalSuppresses(input.method)) await suppressScope(tx, ctx, person, input.purpose as MarketingPurpose, input.source);
    return { recordId, outcome: "recorded" };
  }

  if (marketing) {
    const purpose = input.purpose as MarketingPurpose;
    if (!isMarketingConsentAllowed({ birthOn: person.birthOn, at: recordedAt }) && !(await hasValidDeclaration(tx, { personId: person.id, kind: "guardian_consent" }))) {
      return { recordId: null, outcome: "skipped_minor" };
    }
    const supp = await personSuppressions(tx, person);
    if (input.method === "import") {
      if (importGrantDecision({ existingRecords: records, suppressions: supp, purpose }) === "skip") return { recordId: null, outcome: "skipped_suppressed" };
    }
    const forever = supp.some((s) => (s.scope === "all" || s.scope === purpose) && (s.scope === "all" || s.reason !== "unsubscribe"));
    if (forever) return { recordId: null, outcome: "skipped_suppressed" };
    const blocked = isSuppressedFor({ purpose, suppressions: supp, currentConsent: current });
    if (blocked && input.method === "form" && formGrantNeedsConfirmation({ purpose, suppressions: supp, currentConsent: current })) {
      await sendResubscribeConfirmation(tx, ctx, person, purpose);
      return { recordId: null, outcome: "needs_confirmation" };
    }
    if (blocked && !["portal", "preference_centre"].includes(input.method)) return { recordId: null, outcome: "skipped_suppressed" };
    if (current?.status === "granted" && !blocked) return { recordId: null, outcome: "unchanged" };
  } else if (current?.status === "granted") {
    return { recordId: null, outcome: "unchanged" };
  }
  const recordId = await appendConsent(tx, ctx, person.id, { ...input, lawfulBasis, recordedAt });
  return { recordId, outcome: "recorded" };
}

/** The current state of every purpose of the (canonical) person; null where nothing was recorded. */
export async function getCurrentConsents(tx: DbOrTx, personId: string): Promise<Record<ConsentPurpose, ConsentState | null>> {
  const id = await resolveCanonicalPersonId(tx, personId);
  const rows = await recordsOf(tx, id);
  const out = Object.fromEntries(CONSENT_PURPOSES.map((p) => [p, null])) as Record<ConsentPurpose, ConsentState | null>;
  for (const p of CONSENT_PURPOSES) out[p] = latestConsent(rows.filter((r) => r.purpose === p));
  return out;
}

/**
 * Inserts the suppression `on conflict (email_hash, scope) do nothing` and always calls
 * `requestSuppressionExit` with its id (an existing one too: the job key dedupes, edge case 8).
 * Reason `complaint` also withdraws every granted marketing purpose of every active person with
 * the address, method `complaint` (rule 3.18).
 */
export async function addSuppression(
  tx: Tx,
  ctx: EventCtx,
  input: { email: string; scope: SuppressionScope; reason: SuppressionReason; source: string; personId?: string },
): Promise<{ suppressionId: string; created: boolean }> {
  const email = normaliseEmail(input.email);
  if (!email) throw new ValidationError("invalid_email", { email: "invalid_email" });
  const hash = emailHash(email);
  const owners = await activePersonsByHash(tx, hash);
  const personId = input.personId ? await resolveCanonicalPersonId(tx, input.personId) : (owners[0]?.id ?? null);
  const [inserted] = await tx
    .insert(suppressions)
    .values({ emailHash: hash, email, scope: input.scope, reason: input.reason, source: input.source, personId, actor: actorJson(ctx.actor) })
    .onConflictDoNothing({ target: [suppressions.emailHash, suppressions.scope] })
    .returning({ id: suppressions.id });
  let suppressionId = inserted?.id;
  if (!suppressionId) {
    const [existing] = await tx
      .select({ id: suppressions.id })
      .from(suppressions)
      .where(and(eq(suppressions.emailHash, hash), eq(suppressions.scope, input.scope)));
    if (!existing) throw new Error("suppression vanished");
    suppressionId = existing.id;
  }
  const created = !!inserted;
  if (created && personId) {
    await ctx.recordEvent({ kind: "suppression.added", personId, data: { scope: input.scope, reason: input.reason }, dedupeKey: `suppression:${suppressionId}` });
  }
  if (input.reason === "complaint") {
    for (const owner of owners) {
      const current = await getCurrentConsents(tx, owner.id);
      for (const purpose of purposesToWithdraw(current)) {
        await appendConsent(tx, ctx, owner.id, { purpose, status: "withdrawn", method: "complaint", source: input.source, wordingVersion: "complaint", lawfulBasis: "consent", recordedAt: ctx.now });
      }
    }
  }
  await requestSuppressionExit(tx, { suppressionId });
  return { suppressionId, created };
}

/**
 * Rules 3.16 and 3.17: withdraws the purpose (or every granted marketing purpose for `all`) and
 * suppresses the address for that scope, in the caller's transaction. A second call is a no-op
 * that returns the same suppression.
 */
export async function unsubscribe(
  tx: Tx,
  ctx: EventCtx,
  input: { personId: string; purpose: MarketingPurpose | "all"; method: ConsentMethod; source: string },
): Promise<{ suppressionId: string }> {
  const person = await activePerson(tx, input.personId);
  if (!person.email) throw new ValidationError("person_has_no_email", { personId: "no_email" });
  const current = await getCurrentConsents(tx, person.id);
  const purposes = input.purpose === "all" ? purposesToWithdraw(current) : current[input.purpose]?.status === "granted" ? [input.purpose] : [];
  for (const purpose of purposes) {
    await appendConsent(tx, ctx, person.id, { purpose, status: "withdrawn", method: input.method, source: input.source, wordingVersion: "unsubscribe", lawfulBasis: "consent", recordedAt: ctx.now });
  }
  const { suppressionId } = await addSuppression(tx, ctx, { email: person.email, scope: input.purpose, reason: "unsubscribe", source: input.source, personId: person.id });
  return { suppressionId };
}

/** Whether the address may not receive marketing of `purpose` (`v_suppression_status` for one address). */
export async function isSuppressed(tx: DbOrTx, email: string, purpose: MarketingPurpose): Promise<boolean> {
  const normalised = normaliseEmail(email);
  if (!normalised) return true;
  const hash = emailHash(normalised);
  const [owner] = await activePersonsByHash(tx, hash);
  if (owner?.processingRestrictedAt) return true;
  const supp = await suppressionsOf(tx, hash);
  if (!supp.length) return false;
  const current = owner ? latestConsent(await recordsOf(tx, owner.id, purpose)) : null;
  return isSuppressedFor({ purpose, suppressions: supp, currentConsent: current });
}

/** Pure: the three crm links of an email message, built from its link token. */
export function buildPreferenceUrls(linkToken: string, locale: Locale): { unsubscribeUrl: string; oneClickPostUrl: string; preferencesUrl: string } {
  const base = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const token = encodeURIComponent(linkToken);
  const preferencesUrl = `${base}/${URL_SEGMENT[locale]}/preferences/${token}`;
  return { unsubscribeUrl: `${preferencesUrl}?confirm=unsubscribe`, oneClickPostUrl: `${base}/api/public/unsubscribe/${token}`, preferencesUrl };
}

// ---------------------------------------------------------------------------
// helpers shared with the consent actions and queries of this area
// ---------------------------------------------------------------------------

/** `<purpose>@<version>` of the latest published wording, or null. */
export async function currentWordingVersion(tx: DbOrTx, purpose: ConsentPurpose): Promise<string | null> {
  const [row] = await tx
    .select({ version: consentWordings.version })
    .from(consentWordings)
    .where(and(eq(consentWordings.purpose, purpose), isNotNull(consentWordings.publishedAt)))
    .orderBy(desc(consentWordings.version))
    .limit(1);
  return row ? `${purpose}@${row.version}` : null;
}

/** The active suppressions of an address as the pure rules need them. */
export async function suppressionsOf(tx: DbOrTx, hash: string): Promise<SuppressionLike[]> {
  const rows = await tx.select({ scope: suppressions.scope, reason: suppressions.reason, createdAt: suppressions.createdAt }).from(suppressions).where(eq(suppressions.emailHash, hash));
  return rows;
}

/** The suppressions of the person's current address (none without an address). */
export async function personSuppressions(tx: DbOrTx, person: { email: string | null; emailHash: string | null }): Promise<SuppressionLike[]> {
  const hash = person.emailHash ?? (person.email ? emailHash(person.email) : null);
  return hash ? suppressionsOf(tx, hash) : [];
}

/** True when the address is blocked for every purpose for good (scope `all`: unsubscribe all, bounce, complaint, erased). */
export function blocksForever(supp: readonly SuppressionLike[]): boolean {
  return supp.some((s) => s.scope === "all");
}

/** The canonical, non-erased person row; `not_found` otherwise. */
export async function activePerson(tx: DbOrTx, personId: string): Promise<PersonRow> {
  const id = await resolveCanonicalPersonId(tx, personId);
  const [row] = await tx.select().from(persons).where(eq(persons.id, id));
  if (!row || row.erasedAt) throw new NotFoundError("person_not_found");
  return row;
}

/** The full Ctx a cross-module call needs from an `EventCtx` and the caller's transaction. */
export function withTx(tx: Tx, ctx: EventCtx): Ctx {
  return ("tx" in ctx && (ctx as Ctx).tx ? ctx : { ...(ctx as Ctx), tx }) as Ctx;
}

async function assertPublishedWording(tx: DbOrTx, wordingVersion: string): Promise<void> {
  const m = /^([a-z0-9_]+)@([1-9][0-9]*)$/.exec(wordingVersion);
  if (!m) throw new ValidationError("invalid_wording_version", { wordingVersion: "invalid_wording_version" });
  const [row] = await tx
    .select({ id: consentWordings.id })
    .from(consentWordings)
    .where(and(sql`${consentWordings.purpose}::text = ${m[1]}`, eq(consentWordings.version, Number(m[2])), isNotNull(consentWordings.publishedAt)));
  if (!row) throw new ValidationError("wording_not_published", { wordingVersion: "wording_not_published" });
}

async function recordsOf(tx: DbOrTx, personId: string, purpose?: ConsentPurpose): Promise<ConsentRecordLike[]> {
  const rows = await tx
    .select()
    .from(consentRecords)
    .where(purpose ? and(eq(consentRecords.personId, personId), eq(consentRecords.purpose, purpose)) : eq(consentRecords.personId, personId));
  return rows.map((r) => ({
    id: r.id,
    personId: r.personId,
    purpose: r.purpose,
    status: r.status,
    method: r.method,
    source: r.source,
    wordingVersion: r.wordingVersion,
    lawfulBasis: r.lawfulBasis,
    recordedAt: r.recordedAt,
    createdAt: r.createdAt,
  }));
}

async function activePersonsByHash(tx: DbOrTx, hash: string): Promise<PersonRow[]> {
  return tx
    .select()
    .from(persons)
    .where(and(eq(persons.emailHash, hash), isNull(persons.erasedAt), isNull(persons.mergedIntoPersonId)))
    .orderBy(persons.createdAt);
}

/** Appends one record and its timeline event; no rule checks (callers decided). */
async function appendConsent(
  tx: Tx,
  ctx: EventCtx,
  personId: string,
  input: Omit<RecordConsentInput, "personId" | "lawfulBasis" | "recordedAt"> & { lawfulBasis: LawfulBasis; recordedAt: Date },
): Promise<string> {
  const [row] = await tx
    .insert(consentRecords)
    .values({
      personId,
      purpose: input.purpose,
      status: input.status,
      lawfulBasis: input.lawfulBasis,
      source: input.source,
      method: input.method,
      wordingVersion: input.wordingVersion,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      recordedAt: input.recordedAt,
      actor: actorJson(ctx.actor),
      refType: input.ref?.type ?? null,
      refId: input.ref?.id ?? null,
    })
    .returning({ id: consentRecords.id });
  await ctx.recordEvent({
    kind: input.status === "granted" ? "consent.granted" : "consent.withdrawn",
    personId,
    occurredAt: input.recordedAt,
    data: { purpose: input.purpose, method: input.method, lawful_basis: input.lawfulBasis },
    ref: { type: "consent_record", id: row!.id },
  });
  return row!.id;
}

/** Imports never write suppressions (rule 3.20); complaints are written by `addSuppression` itself. */
const withdrawalSuppresses = (method: ConsentMethod): boolean => method !== "import" && method !== "complaint";

async function suppressScope(tx: Tx, ctx: EventCtx, person: PersonRow, purpose: MarketingPurpose, source: string): Promise<void> {
  if (!person.email) return;
  await addSuppression(tx, ctx, { email: person.email, scope: purpose, reason: "unsubscribe", source, personId: person.id });
}

/** Rule 3.21: `crm.confirm_resubscribe`, key `resubscribe:<person_id>:<purpose>:<YYYY-MM-DD>`. */
async function sendResubscribeConfirmation(tx: Tx, ctx: EventCtx, person: PersonRow, purpose: MarketingPurpose): Promise<void> {
  if (!person.email) return;
  await sendTransactional(withTx(tx, ctx), {
    template: "crm.confirm_resubscribe",
    personId: person.id,
    locale: person.locale,
    data: { purpose, firstName: person.firstName ?? null },
    key: `resubscribe:${person.id}:${purpose}:${brusselsDay(ctx.now)}`,
  });
}

// ---------------------------------------------------------------------------
// preference changes (portal, preference centre)
// ---------------------------------------------------------------------------

export type PreferenceChange = {
  purposes: Record<MarketingPurpose, boolean>;
  unsubscribeAll?: boolean;
  method: "portal" | "preference_centre";
  source: string;
  ip?: string | null;
  userAgent?: string | null;
};

const MARKETING_PURPOSE_LIST: readonly MarketingPurpose[] = ["newsletter", "events", "member_comms", "b2b"];

/**
 * Applies a set of switches: grants with the purpose's current published wording, withdrawals
 * (each suppresses that scope, rule 3.16), or "unsubscribe from everything" (rule 3.17).
 * Returns the purposes whose state changed and, per purpose, a grant the rules did not record.
 */
export async function applyPreferences(
  tx: Tx,
  ctx: EventCtx,
  personId: string,
  change: PreferenceChange,
): Promise<{ changed: MarketingPurpose[]; skipped: Partial<Record<MarketingPurpose, ConsentOutcome>> }> {
  const person = await activePerson(tx, personId);
  const consents = await getCurrentConsents(tx, person.id);
  const supp = await personSuppressions(tx, person);
  const effective = (p: MarketingPurpose) => consents[p]?.status === "granted" && !isSuppressedFor({ purpose: p, suppressions: supp, currentConsent: consents[p] });
  const meta = { ...(change.ip ? { ip: change.ip } : {}), ...(change.userAgent ? { userAgent: change.userAgent } : {}) };
  if (change.unsubscribeAll) {
    const changed = purposesToWithdraw(consents);
    if (person.email) {
      await unsubscribe(tx, ctx, { personId: person.id, purpose: "all", method: change.method, source: change.source });
    } else {
      for (const purpose of changed) {
        await recordConsent(tx, ctx, { personId: person.id, purpose, status: "withdrawn", method: change.method, source: change.source, wordingVersion: "unsubscribe", ...meta });
      }
    }
    return { changed, skipped: {} };
  }
  const changed: MarketingPurpose[] = [];
  const skipped: Partial<Record<MarketingPurpose, ConsentOutcome>> = {};
  for (const purpose of MARKETING_PURPOSE_LIST) {
    const want = change.purposes[purpose];
    if (want === effective(purpose)) continue;
    if (want) {
      const wordingVersion = await currentWordingVersion(tx, purpose);
      if (!wordingVersion) throw new ValidationError("wording_not_published", { [purpose]: "wording_not_published" });
      const { outcome } = await recordConsent(tx, ctx, { personId: person.id, purpose, status: "granted", method: change.method, source: change.source, wordingVersion, ...meta });
      if (outcome === "recorded") changed.push(purpose);
      else skipped[purpose] = outcome;
    } else {
      const { outcome } = await recordConsent(tx, ctx, { personId: person.id, purpose, status: "withdrawn", method: change.method, source: change.source, wordingVersion: "unsubscribe", ...meta });
      if (outcome === "recorded") changed.push(purpose);
    }
  }
  return { changed, skipped };
}

/** Rule 3.5: only the person (portal, preference centre) or staff change `locale`; writes `person.locale_changed`. */
export async function changePersonLocale(tx: Tx, ctx: EventCtx, personId: string, locale: Locale): Promise<boolean> {
  const person = await activePerson(tx, personId);
  if (person.locale === locale) return false;
  await tx
    .update(persons)
    .set({ locale, version: sql`${persons.version} + 1` })
    .where(eq(persons.id, person.id));
  await ctx.recordEvent({ kind: "person.locale_changed", personId: person.id, data: { from: person.locale, to: locale } });
  return true;
}

