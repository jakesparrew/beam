/**
 * crm's cross-module door. Forward stub written by platform-P5 (runbook DR-10): platform's
 * customer sign-up (PL-12) calls `findOrCreatePersonByEmail`. platform-P7 rewrites this file
 * with the full stub set and keeps this export unchanged; crm-P2 implements it.
 */
import type { Tx } from "@beam/db";
import { NotImplementedError } from "@beam/core/errors";
import type { Locale } from "@beam/core/i18n";
import type { Ctx } from "@/lib/ctx";

/** crm spec 4.8: the context crm functions need from the caller. */
export type EventCtx = Pick<Ctx, "actor" | "now" | "requestId" | "enqueue" | "recordEvent">;

/** crm spec section 2 (`AcquisitionSchema` in `@beam/core/crm`). */
export type AcquisitionSource =
  | "website"
  | "landing_page"
  | "paid_meta"
  | "paid_google"
  | "paid_other"
  | "organic_search"
  | "social_media"
  | "webinar"
  | "event"
  | "referral"
  | "partner"
  | "customer_introduction"
  | "guest"
  | "walk_in"
  | "qr_code"
  | "b2b_campaign"
  | "import"
  | "manual"
  | "other";

export type Acquisition = {
  source: AcquisitionSource;
  campaign?: string;
  medium?: string;
  funnel?: string;
  utm?: { source?: string; medium?: string; campaign?: string; term?: string; content?: string };
  referrer_person_id?: string;
  referral_code?: string;
  partner_company_id?: string;
  event_session_id?: string;
  webinar_id?: string;
  form_slug?: string;
  captured_at: string;
};

export function findOrCreatePersonByEmail(
  tx: Tx,
  ctx: EventCtx,
  input: {
    email: string;
    firstName?: string;
    lastName?: string;
    phone?: string;
    locale: Locale;
    acquisition?: Omit<Acquisition, "captured_at">;
    isTester?: boolean;
  },
): Promise<{ personId: string; created: boolean }> {
  void tx;
  void ctx;
  void input;
  return Promise.reject(new NotImplementedError("crm.findOrCreatePersonByEmail"));
}
