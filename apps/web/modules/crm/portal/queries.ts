/** Customer portal queries (crm spec 4.3), crm-P3. Always for the signed-in customer's own person. */
import type { DbOrTx } from "@beam/db";
import { persons } from "@beam/db/schema";
import { formatCustomerNumber, onboardingProgress, type EmergencyContact, type MarketingPurpose, type OnboardingProgress, type PostalAddress } from "@beam/core/crm";
import type { Locale, LocalizedText } from "@beam/core/i18n";
import { eq } from "@/lib/ctx";
import { getCorporateCompany } from "../companies/api";
import { getCurrentMarketingWordings, marketingState } from "../consent/queries";

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

async function ownRow(tx: DbOrTx, personId: string) {
  const [row] = await tx.select().from(persons).where(eq(persons.id, personId));
  if (!row || row.erasedAt || row.mergedIntoPersonId) return null;
  return row;
}

export async function getMyProfile(tx: DbOrTx, personId: string): Promise<MyProfile | null> {
  const row = await ownRow(tx, personId);
  if (!row) return null;
  return {
    version: row.version,
    customerNumber: formatCustomerNumber(row.customerNumber),
    firstName: row.firstName,
    lastName: row.lastName,
    email: row.email,
    phone: row.phone,
    address: row.address ?? null,
    birthOn: row.birthOn,
    locale: row.locale,
    preferredChannel: row.preferredChannel,
    emergencyContact: row.emergencyContact ?? null,
  };
}

export async function getMyPreferences(tx: DbOrTx, personId: string): Promise<MyPreferences | null> {
  const row = await ownRow(tx, personId);
  if (!row) return null;
  const state = await marketingState(tx, row.id);
  const current = await getCurrentMarketingWordings(tx);
  const wordings = Object.fromEntries(Object.entries(current).map(([p, w]) => [p, w?.text ?? null])) as Record<MarketingPurpose, LocalizedText | null>;
  return { purposes: state.purposes, wordings, suppressedAll: state.suppressedAll, locale: state.locale };
}

/** The onboarding progress alone (the portal home's "Complete your profile" card); `null` for an inactive person. */
export async function getMyOnboardingProgress(tx: DbOrTx, personId: string): Promise<OnboardingProgress | null> {
  const [row] = await tx.select({ onboarding: persons.onboarding, erasedAt: persons.erasedAt, merged: persons.mergedIntoPersonId }).from(persons).where(eq(persons.id, personId));
  if (!row || row.erasedAt || row.merged) return null;
  return onboardingProgress(row.onboarding);
}

export type MyOnboarding = {
  progress: OnboardingProgress;
  profile: MyProfile;
  preferences: MyPreferences;
  /** The company the client already gets invoices for (a current contact of a company with a VAT number). */
  company: { name: string; vatNumber: string; address: PostalAddress | null } | null;
};

/** Everything the onboarding screens prefill: the current answers, so nothing is pre-ticked that the client did not choose. */
export async function getMyOnboarding(tx: DbOrTx, personId: string): Promise<MyOnboarding | null> {
  const row = await ownRow(tx, personId);
  if (!row) return null;
  const [profile, preferences, company] = await Promise.all([getMyProfile(tx, personId), getMyPreferences(tx, personId), getCorporateCompany(tx, personId)]);
  if (!profile || !preferences) return null;
  return { progress: onboardingProgress(row.onboarding), profile, preferences, company: company ? { name: company.name, vatNumber: company.vatNumber, address: company.address } : null };
}
