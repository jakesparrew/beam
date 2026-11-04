/** Consent queries (crm spec 4.3, 4.4), implemented by crm-P3. crm-P1 stubs. */
import type { DbOrTx } from "@beam/db";
import { NotImplementedError } from "@beam/core/errors";
import type { ConsentPurpose, MarketingPurpose } from "@beam/core/crm";
import type { Locale, LocalizedText } from "@beam/core/i18n";

export type PreferenceState = {
  firstNameInitial: string | null;
  locale: Locale;
  purposes: Record<MarketingPurpose, boolean>;
  suppressedAll: boolean;
  confirmPurpose: MarketingPurpose | null;
  canEdit: boolean;
};

/** The public preference centre's state for a link token; null for an unknown token. */
export function getPreferenceState(_tx: DbOrTx, _token: string): Promise<PreferenceState | null> {
  return Promise.reject(new NotImplementedError("crm.getPreferenceState"));
}

export function listConsentWordings(_tx: DbOrTx): Promise<Array<{ purpose: ConsentPurpose; version: number; text: LocalizedText; publishedAt: Date | null }>> {
  return Promise.reject(new NotImplementedError("crm.listConsentWordings"));
}
