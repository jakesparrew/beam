/**
 * Reads without a permission: the hosted page and result page (forms spec section 4 "Public"),
 * and the cross-module reads of `api.ts` (listPublishedForms, getPublishedFormMeta, listOutcomes,
 * listPersonSubmissions, getLatestOutcomes, listLatestOutcomes, hasValidSubmission). None of
 * them returns an answer value; sensitive values are never read here (SE3, SE4).
 */
import type { DbOrTx } from "@beam/db";
import { forms, formSensitiveAnswers, formSubmissions, formVersions, vFormLatestResults } from "@beam/db/schema";
import { isScored, type Ending, type FormDefinition, type FormKind, type FormScoring, type LatestOutcome, type Outcome, type PersonSubmissionSummary, type PublicFormRef } from "@beam/core/forms";
import type { Locale, LocalizedText } from "@beam/core/i18n";
import { and, desc, eq, inArray, isNotNull } from "@/lib/ctx";
import { createResultToken, hashToken } from "./tokens";
import { parseVersion } from "./versions";

export type PublicForm = {
  formId: string;
  slug: string;
  kind: FormKind;
  versionId: string;
  version: number;
  locale: Locale;
  locales: Locale[];
  definition: FormDefinition;
  scoring: FormScoring;
};

/** The hosted page's form: published current version, `closed` when archived, `unavailableLocale` outside its locales. */
export async function getPublishedForm(
  db: DbOrTx,
  slug: string,
  locale: Locale,
): Promise<PublicForm | { closed: true } | { unavailableLocale: true; locales: Locale[] } | null> {
  const [row] = await db
    .select({ form: forms, v: formVersions })
    .from(forms)
    .innerJoin(formVersions, eq(formVersions.id, forms.currentVersionId))
    .where(eq(forms.slug, slug));
  if (!row || row.form.status === "draft") return null;
  if (row.form.status === "archived") return { closed: true };
  const c = parseVersion(row.v);
  if (!c.locales.includes(locale)) return { unavailableLocale: true, locales: c.locales };
  return { formId: row.form.id, slug, kind: row.form.kind, versionId: row.v.id, version: row.v.version, locale, locales: c.locales, definition: c.definition, scoring: c.scoring };
}

export type PublicResult = {
  submissionId: string;
  /** Server-side only (subject_result reads); never rendered. */
  personId: string | null;
  formSlug: string;
  formKind: FormKind;
  locale: Locale;
  token: string;
  title: LocalizedText;
  ending: Ending;
  score: { total: number | null; totalRangeKey: string | null; dimensions: Record<string, { value: number | null; rangeKey: string | null }> } | null;
  outcome: Pick<Outcome, "key" | "label" | "explanation" | "recommendation"> | null;
  scoring: FormScoring;
  /** Dimensions the ending shows whose values are sensitive (read with `subject_result`). */
  sensitiveDimensionKeys: string[];
};

/** The result page of a token: `expired` after 180 days; null for an unknown or revoked token. */
export async function getResultByToken(db: DbOrTx, token: string, now: Date = new Date()): Promise<PublicResult | { expired: true; formSlug: string; locale: Locale } | null> {
  if (!token || token.length > 100) return null;
  const [row] = await db
    .select({ s: formSubmissions, slug: forms.slug, kind: forms.kind, v: formVersions })
    .from(formSubmissions)
    .innerJoin(forms, eq(forms.id, formSubmissions.formId))
    .innerJoin(formVersions, eq(formVersions.id, formSubmissions.formVersionId))
    .where(and(eq(formSubmissions.resultTokenHash, hashToken(token)), eq(formSubmissions.status, "completed")));
  if (!row) return null;
  const s = row.s;
  if (createResultToken(s.id, s.resultTokenVersion) !== token) return null;
  const locale = s.locale as Locale;
  if (s.resultTokenExpiresAt && s.resultTokenExpiresAt.getTime() <= now.getTime()) return { expired: true, formSlug: row.slug, locale };
  const c = parseVersion(row.v);
  const ending = c.definition.endings.find((e) => e.key === s.endingKey) ?? c.definition.endings[0]!;
  const outcome = c.scoring.outcomes.find((o) => o.key === s.outcomeKey) ?? null;
  const plainDims = new Set(Object.keys(s.score?.dimensions ?? {}));
  return {
    submissionId: s.id,
    personId: s.personId,
    formSlug: row.slug,
    formKind: row.kind,
    locale,
    token,
    title: c.definition.title,
    ending,
    score: s.score ?? null,
    outcome: outcome ? { key: outcome.key, label: outcome.label, explanation: outcome.explanation, recommendation: outcome.recommendation } : null,
    scoring: c.scoring,
    sensitiveDimensionKeys: ending.showDimensions.filter((k) => !plainDims.has(k) && c.scoring.dimensions.some((d) => d.key === k)),
  };
}

// ---------------------------------------------------------------------------
// Cross-module reads (api.ts)
// ---------------------------------------------------------------------------

export async function listPublishedForms(db: DbOrTx): Promise<PublicFormRef[]> {
  const rows = await db
    .select({ id: forms.id, slug: forms.slug, kind: forms.kind, name: forms.name, locales: formVersions.locales })
    .from(forms)
    .innerJoin(formVersions, eq(formVersions.id, forms.currentVersionId))
    .where(eq(forms.status, "published"))
    .orderBy(forms.slug);
  return rows.map((r) => ({ id: r.id, slug: r.slug, kind: r.kind, name: r.name as LocalizedText, locales: r.locales as Locale[] }));
}

export async function getPublishedFormMeta(db: DbOrTx, slug: string): Promise<{ formId: string; locales: Locale[] } | null> {
  const [r] = await db
    .select({ id: forms.id, locales: formVersions.locales })
    .from(forms)
    .innerJoin(formVersions, eq(formVersions.id, forms.currentVersionId))
    .where(and(eq(forms.slug, slug), eq(forms.status, "published")));
  return r ? { formId: r.id, locales: r.locales as Locale[] } : null;
}

export async function listOutcomes(db: DbOrTx, formSlug: string): Promise<{ key: string; label: LocalizedText }[]> {
  const [r] = await db
    .select({ v: formVersions })
    .from(forms)
    .innerJoin(formVersions, eq(formVersions.id, forms.currentVersionId))
    .where(eq(forms.slug, formSlug));
  if (!r) return [];
  return parseVersion(r.v).scoring.outcomes.map((o) => ({ key: o.key, label: o.label }));
}

/** Never includes answer values (crm's person tab, the portal). */
export async function listPersonSubmissions(db: DbOrTx, personId: string): Promise<PersonSubmissionSummary[]> {
  const rows = await db
    .select({ s: formSubmissions, slug: forms.slug, name: forms.name, v: formVersions })
    .from(formSubmissions)
    .innerJoin(forms, eq(forms.id, formSubmissions.formId))
    .innerJoin(formVersions, eq(formVersions.id, formSubmissions.formVersionId))
    .where(eq(formSubmissions.personId, personId))
    .orderBy(desc(formSubmissions.startedAt));
  const ids = rows.map((r) => r.s.id);
  const withSensitive = new Set(
    ids.length
      ? (await db.selectDistinct({ id: formSensitiveAnswers.submissionId }).from(formSensitiveAnswers).where(inArray(formSensitiveAnswers.submissionId, ids))).map((r) => r.id)
      : [],
  );
  return rows.map(({ s, slug, name, v }) => {
    const scoring = parseVersion(v).scoring;
    const outcome = scoring.outcomes.find((o) => o.key === s.outcomeKey);
    return {
      submissionId: s.id,
      formId: s.formId,
      formSlug: slug,
      formName: name as LocalizedText,
      version: v.version,
      status: s.status,
      outcomeKey: s.outcomeKey,
      outcomeLabel: outcome?.label ?? null,
      total: isScored(scoring) ? (s.score?.total ?? null) : null,
      source: s.source,
      campaign: s.campaign,
      startedAt: s.startedAt,
      completedAt: s.completedAt,
      hasSensitive: withSensitive.has(s.id),
    };
  });
}

/** Latest outcome per form for many persons (forms without an outcome are left out). */
export async function getLatestOutcomes(db: DbOrTx, personIds: string[]): Promise<Map<string, LatestOutcome[]>> {
  const out = new Map<string, LatestOutcome[]>();
  if (!personIds.length) return out;
  const rows = await db
    .select()
    .from(vFormLatestResults)
    .where(and(inArray(vFormLatestResults.personId, personIds), isNotNull(vFormLatestResults.outcomeKey)))
    .orderBy(vFormLatestResults.personId, vFormLatestResults.formSlug);
  for (const r of rows) {
    const total = r.totalScore === null || r.totalScore === undefined ? null : Number(r.totalScore);
    const list = out.get(r.personId) ?? [];
    list.push({ formSlug: r.formSlug, outcomeKey: r.outcomeKey!, totalScore: total, completedAt: new Date(r.completedAt as unknown as string | Date) });
    out.set(r.personId, list);
  }
  return out;
}

/** Email's assessment block: personId -> outcome key of the latest completed submission of that form. */
export async function listLatestOutcomes(tx: DbOrTx, personIds: string[], formSlug: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!personIds.length) return out;
  const rows = await tx
    .select({ personId: vFormLatestResults.personId, outcomeKey: vFormLatestResults.outcomeKey })
    .from(vFormLatestResults)
    .where(and(inArray(vFormLatestResults.personId, personIds), eq(vFormLatestResults.formSlug, formSlug)));
  for (const r of rows) if (r.outcomeKey) out.set(r.personId, r.outcomeKey);
  return out;
}

const DAY_MS = 86_400_000;

/** ID11: a completed submission of any version within `validityDays` (no `validityDays` = no expiry). */
export async function hasValidSubmission(
  db: DbOrTx,
  input: { personId: string; formSlug: string },
  now: Date = new Date(),
): Promise<{ valid: boolean; completedAt: Date | null; expiresAt: Date | null }> {
  const [form] = await db.select().from(forms).where(eq(forms.slug, input.formSlug));
  if (!form) return { valid: false, completedAt: null, expiresAt: null };
  const [latest] = await db
    .select({ completedAt: formSubmissions.completedAt })
    .from(formSubmissions)
    .where(and(eq(formSubmissions.formId, form.id), eq(formSubmissions.personId, input.personId), eq(formSubmissions.status, "completed")))
    .orderBy(desc(formSubmissions.completedAt))
    .limit(1);
  if (!latest?.completedAt) return { valid: false, completedAt: null, expiresAt: null };
  const [v] = form.currentVersionId
    ? await db.select().from(formVersions).where(eq(formVersions.id, form.currentVersionId))
    : await db.select().from(formVersions).where(eq(formVersions.formId, form.id)).orderBy(desc(formVersions.version)).limit(1);
  const days = v ? parseVersion(v).definition.settings.validityDays : undefined;
  const expiresAt = days ? new Date(latest.completedAt.getTime() + days * DAY_MS) : null;
  return { valid: !expiresAt || expiresAt.getTime() > now.getTime(), completedAt: latest.completedAt, expiresAt };
}

