"use server";
/**
 * Consent and suppression actions (crm spec 4.1), implemented by crm-P3. crm-P1 stubs with the
 * final names, audiences, permissions and inputs.
 */
import { z } from "zod";
import { NotImplementedError } from "@beam/core/errors";
import { CONSENT_PURPOSES, MARKETING_PURPOSES, SUPPRESSION_SCOPES, type MarketingPurpose } from "@beam/core/crm";
import { LOCALES, LocalizedTextSchema } from "@beam/core/i18n";
import { action } from "@/lib/action";

const todo =
  <O>(name: string) =>
  (): Promise<O> =>
    Promise.reject(new NotImplementedError(name));

const Purposes = z.object(Object.fromEntries(MARKETING_PURPOSES.map((p) => [p, z.boolean()])) as Record<MarketingPurpose, z.ZodBoolean>);

export const recordStaffConsent = action(
  {
    name: "crm.record_staff_consent",
    audience: "staff",
    permission: "persons.write",
    input: z.object({ personId: z.uuid(), purpose: z.enum(CONSENT_PURPOSES), status: z.enum(["granted", "withdrawn"]) }),
  },
  todo<{ recordId: string | null }>("crm.record_staff_consent"),
);

export const addManualSuppression = action(
  {
    name: "crm.add_suppression",
    audience: "staff",
    permission: "persons.write",
    input: z.object({ email: z.string().trim().toLowerCase().email().max(254), scope: z.enum(SUPPRESSION_SCOPES), note: z.string().trim().min(3).max(500) }),
  },
  todo<{ suppressionId: string }>("crm.add_suppression"),
);

export const publishConsentWording = action(
  { name: "crm.publish_consent_wording", audience: "staff", permission: "settings.write", input: z.object({ purpose: z.enum(CONSENT_PURPOSES), text: LocalizedTextSchema }) },
  todo<{ version: number }>("crm.publish_consent_wording"),
);

/** Public: the token is the only credential (crm spec 4.4). */
export const updatePreferencesByToken = action(
  {
    name: "crm.update_preferences_by_token",
    audience: "public",
    input: z.object({ token: z.string().min(16).max(200), purposes: Purposes, locale: z.enum(LOCALES).optional(), unsubscribeAll: z.boolean().optional() }),
  },
  todo<{ changed: MarketingPurpose[] }>("crm.update_preferences_by_token"),
);
