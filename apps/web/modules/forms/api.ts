/**
 * forms' cross-module door (02-data-model section 6.7). Wave 0 stubs by platform-P7 with the
 * owner's final signatures: each throws `NotImplementedError('forms.<fn>')` until forms
 * implements it. `FormEmbed` moves to `./ui/public/form-embed` when forms builds it; the Wave 0
 * stand-in renders nothing visible and throws.
 */
import type { DbOrTx } from "@beam/db";
import { NotImplementedError } from "@beam/core/errors";
import type { Locale, LocalizedText } from "@beam/core/i18n";
import type { AcquisitionSource } from "@beam/core/crm";
import type { FormEmbedProps, LatestOutcome, PersonSubmissionSummary, PublicFormRef, UtmParams } from "@beam/core/forms";

export type { FormEmbedProps, LatestOutcome, PersonSubmissionSummary, PublicFormRef } from "@beam/core/forms";

const notYet = <T>(fn: string): Promise<T> => Promise.reject(new NotImplementedError(`forms.${fn}`));

/** Site pages and pickers (site, automation, email). */
export function listPublishedForms(_db: DbOrTx): Promise<PublicFormRef[]> {
  return notYet("listPublishedForms");
}

/** Site publish check for `form_embed` blocks; null when the slug is not a published form. */
export function getPublishedFormMeta(_db: DbOrTx, _slug: string): Promise<{ formId: string; locales: Locale[] } | null> {
  return notYet("getPublishedFormMeta");
}

/** Outcome keys and labels of the current version. */
export function listOutcomes(_db: DbOrTx, _formSlug: string): Promise<{ key: string; label: LocalizedText }[]> {
  return notYet("listOutcomes");
}

/** Person page tab (crm) and portal. Never includes answer values. */
export function listPersonSubmissions(_db: DbOrTx, _personId: string): Promise<PersonSubmissionSummary[]> {
  return notYet("listPersonSubmissions");
}

/** Latest outcome per form for many persons. */
export function getLatestOutcomes(_db: DbOrTx, _personIds: string[]): Promise<Map<string, LatestOutcome[]>> {
  return notYet("getLatestOutcomes");
}

/** Email's assessment outcome block: personId -> latest outcome key of that form. */
export function listLatestOutcomes(_tx: DbOrTx, _personIds: string[], _formSlug: string): Promise<Map<string, string>> {
  return notYet("listLatestOutcomes");
}

/** Reception check-in and booking: is there a completed, unexpired submission? */
export function hasValidSubmission(
  _db: DbOrTx,
  _input: { personId: string; formSlug: string },
): Promise<{ valid: boolean; completedAt: Date | null; expiresAt: Date | null }> {
  return notYet("hasValidSubmission");
}

/** Prefill links in emails and on result pages; identification only, never login. */
export function createPersonToken(_personId: string, _opts?: { formSlug?: string; ttlDays?: number }): string {
  throw new NotImplementedError("forms.createPersonToken");
}

export function verifyPersonToken(_token: string): { personId: string; formSlug: string | null; expiresAt: Date; staffUserId: string | null } | null {
  throw new NotImplementedError("forms.verifyPersonToken");
}

/** Absolute hosted-form URL with optional identity token and UTM. */
export function buildFormUrl(_input: {
  slug: string;
  locale: Locale;
  personId?: string;
  src?: AcquisitionSource;
  utm?: UtmParams;
  linkKey?: string;
}): string {
  throw new NotImplementedError("forms.buildFormUrl");
}

/** Site insights (R3). */
export function countLandingConversions(
  _db: DbOrTx,
  _input: { from: Date; to: Date },
): Promise<{ landingPath: string; utmCampaign: string | null; submissions: number; newPersons: number }[]> {
  return notYet("countLandingConversions");
}

/** Daily digest and alerts (ops, platform). */
export function getFormsHealth(
  _db: DbOrTx,
  _input: { day: string },
): Promise<{ completions: number; started: number; importFailed: number; importSkipped: number; deadJobs: number; formsWithBrokenCtas: number }> {
  return notYet("getFormsHealth");
}

/** Server component for site page blocks (Wave 0 stand-in; forms replaces it with its re-export). */
export function FormEmbed(_props: FormEmbedProps): never {
  throw new NotImplementedError("forms.FormEmbed");
}
