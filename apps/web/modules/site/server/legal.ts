/**
 * Legal versions and terms acceptance (site rules 33-35, 61-62, 67; api.ts section 4). Stubs by
 * site-P1 with the final signatures; site-P5 implements them over `v_legal_versions`,
 * `terms_acceptances` and `crm.resolvePersonIds`.
 */
import type { DbOrTx, Tx } from "@beam/db";
import { NotImplementedError } from "@beam/core/errors";
import type { Locale, LocalizedText } from "@beam/core/i18n";
import type { LegalKey, TermsContext } from "@beam/core/site";
import type { Ctx } from "@/lib/ctx";

const notYet = <T>(fn: string): Promise<T> => Promise.reject(new NotImplementedError(`site.${fn}`));

export type CurrentLegalVersion = {
  versionId: string;
  /** Published ordinal from `v_legal_versions` ("Version n"). */
  version: number;
  publishedAt: Date;
  /** The live version's `is_material_change`. */
  requiresReacceptance: boolean;
  /** `richDocToPlainText` of the live blocks per live locale (crm's reception print and declarations). */
  text: LocalizedText;
  urlByLocale: Partial<Record<Locale, string>>;
};

export type RecordTermsAcceptanceInput = {
  personId: string;
  versionId: string;
  context: TermsContext;
  refType?: "order" | "booking" | "user";
  refId?: string;
  ip?: string | null;
};

/** The live version of a legal page, or null when none is published. */
export function getCurrentLegalVersion(_db: DbOrTx, _key: LegalKey): Promise<CurrentLegalVersion | null> {
  return notYet("getCurrentLegalVersion");
}

/** Idempotent on `terms:<person>:<version>:<context>:<ref_id|none>`; writes event `site.terms_accepted`. */
export function recordTermsAcceptance(_tx: Tx, _ctx: Ctx, _input: RecordTermsAcceptanceInput): Promise<{ acceptanceId: string; created: boolean }> {
  return notYet("recordTermsAcceptance");
}

/** Over `crm.resolvePersonIds`; true when the latest acceptance is at or after the latest material terms version; false when no terms version is published. */
export function hasAcceptedCurrentTerms(_db: DbOrTx, _personId: string): Promise<boolean> {
  return notYet("hasAcceptedCurrentTerms");
}

/** Absolute URLs for email footers and checkout. */
export function getLegalLinks(_locale: Locale): Promise<{ privacy: string | null; terms: string | null; cookies: string | null; accessibility: string | null }> {
  return notYet("getLegalLinks");
}
