/** Consent queries (crm spec 4.3, 4.4), crm-P3. */
import type { DbOrTx } from "@beam/db";
import { consentRecords, consentWordings, persons, suppressions } from "@beam/db/schema";
import { MARKETING_PURPOSES, canEditPreferences, isSuppressedFor, type ConsentPurpose, type MarketingPurpose } from "@beam/core/crm";
import type { Locale, LocalizedText } from "@beam/core/i18n";
import { asc, desc, eq, isNotNull } from "@/lib/ctx";
import { resolveLinkToken } from "@/modules/email/api";
import { resolveCanonicalPersonId } from "../persons/api";
import { blocksForever, getCurrentConsents, personSuppressions } from "./api";

export type PreferenceState = {
  firstNameInitial: string | null;
  locale: Locale;
  purposes: Record<MarketingPurpose, boolean>;
  suppressedAll: boolean;
  confirmPurpose: MarketingPurpose | null;
  canEdit: boolean;
};

/** A link token resolved to the canonical, non-erased person (rule 3.30: a merged loser's token lands on the winner). */
export type ResolvedLink = { personId: string; emailMessageId: string; purpose: MarketingPurpose | null; sentAt: Date; locale: Locale };

export async function resolvePreferenceToken(tx: DbOrTx, token: string): Promise<ResolvedLink | null> {
  const link = await resolveLinkToken(tx, token);
  if (!link) return null;
  let personId: string;
  try {
    personId = await resolveCanonicalPersonId(tx, link.personId);
  } catch {
    return null;
  }
  const [row] = await tx.select({ erasedAt: persons.erasedAt }).from(persons).where(eq(persons.id, personId));
  if (!row || row.erasedAt) return null;
  return { personId, emailMessageId: link.emailMessageId, purpose: link.purpose, sentAt: link.sentAt, locale: link.locale };
}

/** Per marketing purpose: granted and not blocked by a suppression of the address. */
export async function marketingState(tx: DbOrTx, personId: string): Promise<{ purposes: Record<MarketingPurpose, boolean>; suppressedAll: boolean; locale: Locale; firstName: string | null }> {
  const [person] = await tx.select().from(persons).where(eq(persons.id, personId));
  if (!person) throw new Error("person_not_found");
  const consents = await getCurrentConsents(tx, personId);
  const supp = await personSuppressions(tx, person);
  const purposes = Object.fromEntries(
    MARKETING_PURPOSES.map((p) => [p, consents[p]?.status === "granted" && !isSuppressedFor({ purpose: p, suppressions: supp, currentConsent: consents[p] })]),
  ) as Record<MarketingPurpose, boolean>;
  return { purposes, suppressedAll: blocksForever(supp), locale: person.locale, firstName: person.firstName };
}

/** The public preference centre's state for a link token; null for an unknown token. */
export async function getPreferenceState(tx: DbOrTx, token: string, now: Date = new Date()): Promise<PreferenceState | null> {
  const link = await resolvePreferenceToken(tx, token);
  if (!link) return null;
  const state = await marketingState(tx, link.personId);
  const initial = state.firstName?.trim().charAt(0).toUpperCase() ?? "";
  return {
    firstNameInitial: initial || null,
    locale: state.locale,
    purposes: state.purposes,
    suppressedAll: state.suppressedAll,
    confirmPurpose: link.purpose,
    canEdit: canEditPreferences(link.sentAt, now),
  };
}

export type ConsentPanelData = {
  current: Record<ConsentPurpose, { status: "granted" | "withdrawn"; method: string; recordedAt: Date } | null>;
  history: Array<{ id: string; purpose: ConsentPurpose; status: "granted" | "withdrawn"; method: string; source: string; wordingVersion: string; recordedAt: Date }>;
  suppressions: Array<{ id: string; scope: string; reason: string; source: string; createdAt: Date }>;
  reachable: Record<MarketingPurpose, boolean>;
};

/** The 360 consent panel (crm spec 5.1): current state per purpose, the full history and the address's suppressions. */
export async function getPersonConsentPanel(tx: DbOrTx, personId: string): Promise<ConsentPanelData> {
  const id = await resolveCanonicalPersonId(tx, personId);
  const [person] = await tx.select().from(persons).where(eq(persons.id, id));
  const rows = await tx.select().from(consentRecords).where(eq(consentRecords.personId, id)).orderBy(desc(consentRecords.recordedAt), desc(consentRecords.createdAt));
  const current = await getCurrentConsents(tx, id);
  const hash = person?.emailHash ?? null;
  const supp = hash ? await tx.select().from(suppressions).where(eq(suppressions.emailHash, hash)).orderBy(desc(suppressions.createdAt)) : [];
  const state = await marketingState(tx, id);
  return {
    current: Object.fromEntries(Object.entries(current).map(([p, c]) => [p, c ? { status: c.status, method: c.method, recordedAt: c.recordedAt } : null])) as ConsentPanelData["current"],
    history: rows.map((r) => ({ id: r.id, purpose: r.purpose, status: r.status, method: r.method, source: r.source, wordingVersion: r.wordingVersion, recordedAt: r.recordedAt })),
    suppressions: supp.map((s) => ({ id: s.id, scope: s.scope, reason: s.reason, source: s.source, createdAt: s.createdAt })),
    reachable: state.purposes,
  };
}

export type ConsentWordingRow ={ purpose: ConsentPurpose; version: number; text: LocalizedText; publishedAt: Date | null };

/** Every wording version, by purpose and newest version first (the consent-wordings page). */
export async function listConsentWordings(tx: DbOrTx): Promise<ConsentWordingRow[]> {
  const rows = await tx
    .select({ purpose: consentWordings.purpose, version: consentWordings.version, text: consentWordings.text, publishedAt: consentWordings.publishedAt })
    .from(consentWordings)
    .orderBy(asc(consentWordings.purpose), desc(consentWordings.version));
  return rows.map((r) => ({ ...r, text: r.text }));
}

/** The latest published wording of each marketing purpose (portal and preference centre switches). */
export async function getCurrentMarketingWordings(tx: DbOrTx): Promise<Record<MarketingPurpose, { version: number; text: LocalizedText } | null>> {
  const rows = await tx
    .select({ purpose: consentWordings.purpose, version: consentWordings.version, text: consentWordings.text })
    .from(consentWordings)
    .where(isNotNull(consentWordings.publishedAt))
    .orderBy(desc(consentWordings.version));
  const out = Object.fromEntries(MARKETING_PURPOSES.map((p) => [p, null])) as Record<MarketingPurpose, { version: number; text: LocalizedText } | null>;
  for (const r of rows) {
    const p = r.purpose as MarketingPurpose;
    if ((MARKETING_PURPOSES as readonly string[]).includes(p) && !out[p]) out[p] = { version: r.version, text: r.text };
  }
  return out;
}
