/**
 * forms types named in the cross-module contract (02-data-model section 6.7). Wave 0 skeleton
 * by platform-P7; forms owns this file from forms-P1 on.
 */
import type { Locale } from "../i18n/locales";
import type { LocalizedText } from "../i18n/localized-text";

export type FormKind = "lead" | "intake" | "survey" | "assessment" | "registration";
export type SubmissionStatus = "started" | "partial" | "abandoned" | "completed";

export type PublicFormRef = { id: string; slug: string; kind: FormKind; name: LocalizedText; locales: Locale[] };

export type PersonSubmissionSummary = {
  submissionId: string;
  formId: string;
  formSlug: string;
  formName: LocalizedText;
  version: number;
  status: SubmissionStatus;
  outcomeKey: string | null;
  outcomeLabel: LocalizedText | null;
  total: number | null;
  source: string;
  campaign: string | null;
  startedAt: Date;
  completedAt: Date | null;
  hasSensitive: boolean;
};

export type LatestOutcome = { formSlug: string; outcomeKey: string; totalScore: number | null; completedAt: Date };

export type UtmParams = Partial<Record<"source" | "medium" | "campaign" | "term" | "content", string>>;

/** Props of forms' `FormEmbed` server component (site's published names). */
export type FormEmbedProps = {
  slug: string;
  locale: Locale;
  context: { pagePath: string; utm?: UtmParams; landingPath?: string; referrer?: string; partnerCompanyId?: string };
};
