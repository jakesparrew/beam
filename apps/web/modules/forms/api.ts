/**
 * forms' cross-module door (forms spec section 4 "Cross-module API", 02-data-model section 6.7).
 * Implemented by forms-P3 on top of `./service/*`; signatures are the Wave 0 contract.
 * `countLandingConversions` (R3) and `PartnerLinkCounts` are forms-P9's; `FormEmbed` is
 * forms-P4's server component; the dashboard sources are forms-P10's.
 */
import type { DbOrTx } from "@beam/db";
import type { Locale, LocalizedText } from "@beam/core/i18n";
import type { AcquisitionSource } from "@beam/core/crm";
import type { LatestOutcome, PersonSubmissionSummary, PublicFormRef, UtmParams } from "@beam/core/forms";
import { countLandingConversions as landingConversions } from "./queries";
import { getFormsHealth as formsHealth } from "./service/health";
import * as reads from "./service/public-queries";
import { createIdentityToken, hostedFormUrl, IDENTITY_TTL_DAYS, verifyIdentityToken } from "./service/tokens";

export type { FormEmbedProps, LatestOutcome, PersonSubmissionSummary, PublicFormRef } from "@beam/core/forms";

/** Site pages and pickers (site, automation, email). */
export function listPublishedForms(db: DbOrTx): Promise<PublicFormRef[]> {
  return reads.listPublishedForms(db);
}

/** Site publish check for `form_embed` blocks; null when the slug is not a published form. */
export function getPublishedFormMeta(db: DbOrTx, slug: string): Promise<{ formId: string; locales: Locale[] } | null> {
  return reads.getPublishedFormMeta(db, slug);
}

/** Outcome keys and labels of the current version. */
export function listOutcomes(db: DbOrTx, formSlug: string): Promise<{ key: string; label: LocalizedText }[]> {
  return reads.listOutcomes(db, formSlug);
}

/** Person page tab (crm) and portal. Never includes answer values. */
export function listPersonSubmissions(db: DbOrTx, personId: string): Promise<PersonSubmissionSummary[]> {
  return reads.listPersonSubmissions(db, personId);
}

/** Latest outcome per form for many persons. */
export function getLatestOutcomes(db: DbOrTx, personIds: string[]): Promise<Map<string, LatestOutcome[]>> {
  return reads.getLatestOutcomes(db, personIds);
}

/** Email's assessment outcome block: personId -> latest outcome key of that form. */
export function listLatestOutcomes(tx: DbOrTx, personIds: string[], formSlug: string): Promise<Map<string, string>> {
  return reads.listLatestOutcomes(tx, personIds, formSlug);
}

/** Reception check-in and booking: is there a completed, unexpired submission (ID11)? */
export function hasValidSubmission(
  db: DbOrTx,
  input: { personId: string; formSlug: string },
): Promise<{ valid: boolean; completedAt: Date | null; expiresAt: Date | null }> {
  return reads.hasValidSubmission(db, input);
}

/** Prefill links in emails and on result pages; identification only, never login (ID5, 30 days by default). */
export function createPersonToken(personId: string, opts?: { formSlug?: string; ttlDays?: number }): string {
  return createIdentityToken({ personId, formSlug: opts?.formSlug ?? null, ttlSeconds: (opts?.ttlDays ?? IDENTITY_TTL_DAYS) * 86_400 });
}

export function verifyPersonToken(token: string): { personId: string; formSlug: string | null; expiresAt: Date; staffUserId: string | null } | null {
  return verifyIdentityToken(token);
}

/** Absolute hosted-form URL with optional identity token and UTM. */
export function buildFormUrl(input: {
  slug: string;
  locale: Locale;
  personId?: string;
  src?: AcquisitionSource;
  utm?: UtmParams;
  linkKey?: string;
}): string {
  const utm = input.utm ?? {};
  return hostedFormUrl(input.slug, input.locale, {
    pt: input.personId ? createPersonToken(input.personId, { formSlug: input.slug }) : undefined,
    src: input.src,
    l: input.linkKey,
    utm_source: utm.source,
    utm_medium: utm.medium,
    utm_campaign: utm.campaign,
    utm_term: utm.term,
    utm_content: utm.content,
  });
}

/**
 * Site insights (R3, forms-P9): completed submissions with `completed_at` in `[from, to)` per
 * landing path and `utm_campaign`, and how many of them created their person.
 */
export function countLandingConversions(
  db: DbOrTx,
  input: { from: Date; to: Date },
): Promise<{ landingPath: string; utmCampaign: string | null; submissions: number; newPersons: number }[]> {
  return landingConversions(db, input);
}

/** Daily digest and alerts (ops, platform). */
export function getFormsHealth(
  db: DbOrTx,
  input: { day: string },
): Promise<{ completions: number; started: number; importFailed: number; importSkipped: number; deadJobs: number; formsWithBrokenCtas: number }> {
  return formsHealth(db, input);
}

/**
 * Server component for site page blocks: renders a published form inline (same origin) with the
 * site context signed into `embedContext` (forms-P4). Props `{ slug, locale, context }`.
 */
export { FormEmbed } from "./ui/public/form-embed";

/**
 * Server component for crm's partner area (R3, `partner.own`, forms-P9): the views, starts and
 * completions of the signed-in partner's own tracked links, counts only (no person data). Props
 * `{ locale }`; renders nothing for a caller without a partner scope.
 */
export { PartnerLinkCounts } from "./ui/partner/partner-link-counts";
export type { PartnerLinkCount } from "./queries";

/**
 * Custom dashboard widget sources (R4, forms-P10; `reports.read` on the consuming page):
 * `forms.funnel`, `forms.outcomes` and `forms.conversion`, aggregates only (no answers, no
 * sensitive data). `loadFormsDashboardSource(db, key, { from, to, formId? })` takes inclusive
 * Brussels days, at most `MAX_DASHBOARD_RANGE_DAYS`.
 */
export {
  FORMS_DASHBOARD_SOURCE_KEYS,
  FORMS_DASHBOARD_SOURCES,
  isFormsDashboardSourceKey,
  loadFormsDashboardSource,
  MAX_DASHBOARD_RANGE_DAYS,
} from "./dashboard-sources";
export type {
  ConversionCounts,
  FormsConversionValue,
  FormsDashboardRange,
  FormsDashboardSource,
  FormsDashboardSourceKey,
  FormsDashboardValues,
  FormsDashboardViz,
  FormsFunnelValue,
  FormsOutcomesValue,
  FunnelCounts,
} from "./dashboard-sources";
