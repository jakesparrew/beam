/** Customer portal queries (crm spec 4.3), implemented by crm-P3. crm-P1 stubs. */
import type { DbOrTx } from "@beam/db";
import { NotImplementedError } from "@beam/core/errors";
import type { EmergencyContact, MarketingPurpose, PostalAddress } from "@beam/core/crm";
import type { Locale, LocalizedText } from "@beam/core/i18n";

export type MyProfile = {
  version: number;
  customerNumber: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  address: PostalAddress | null;
  birthOn: string | null;
  locale: Locale;
  preferredChannel: "email" | "phone" | "whatsapp" | null;
  emergencyContact: EmergencyContact | null;
};

export type MyPreferences = {
  purposes: Record<MarketingPurpose, boolean>;
  wordings: Record<MarketingPurpose, LocalizedText | null>;
  suppressedAll: boolean;
  locale: Locale;
};

export function getMyProfile(_tx: DbOrTx, _personId: string): Promise<MyProfile | null> {
  return Promise.reject(new NotImplementedError("crm.getMyProfile"));
}

export function getMyPreferences(_tx: DbOrTx, _personId: string): Promise<MyPreferences | null> {
  return Promise.reject(new NotImplementedError("crm.getMyPreferences"));
}
