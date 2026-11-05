/**
 * The personalised result page `/[locale]/f/[slug]/r/[token]` (forms spec section 5, rules ID6 to
 * ID8, SE3). Unknown or revoked token -> 404; expired (180 days) -> "This link has expired" with
 * the `requestResultLink` email box (forms-P6), which always answers "If we know this address, we
 * sent you a new link" (no address enumeration); otherwise the result in the submission locale. Sensitive dimension values the ending shows are decrypted for the subject
 * through `readSensitive(ctx, personId, 'subject_result', { submissionIds })` (system actor,
 * audited with keys only). CTAs go through the `go` route, which adds a fresh identity token (ID7).
 */
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { findRange } from "@beam/core/forms";
import { localeFromSegment, type Locale, type LocalizedText } from "@beam/core/i18n";
import { createCtx, getAppDb } from "@/lib/ctx";
import { translator } from "@/lib/i18n";
import { reportError } from "@/lib/logger";
import { loadCurrentKeyVersion } from "@/lib/sensitive";
import { requestResultLink } from "@/modules/forms/actions";
import { getResultByToken, type PublicResult } from "@/modules/forms/service/public-queries";
import { readSubmissionAnswers, scoreKey } from "@/modules/forms/service/sensitive";
import { ctaRedirectUrl } from "@/modules/forms/service/tokens";
import { ResultView, type ResultDimensionView } from "@/modules/forms/ui/public/result-view";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { robots: { index: false, follow: false }, referrer: "no-referrer" };

type Params = Promise<{ locale: string; slug: string; token: string }>;
type Search = Promise<Record<string, string | string[] | undefined>>;

const text = (t: LocalizedText | undefined, locale: Locale): string | null => (t ? (t[locale] ?? null) : null);

/** SE3: the subject's own sensitive dimension values, `score:<key>` -> value. */
async function sensitiveDimensions(r: PublicResult): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  if (!r.personId || !r.sensitiveDimensionKeys.length) return out;
  const db = await getAppDb();
  await db.transaction(async (tx) => {
    await loadCurrentKeyVersion(tx);
    const ctx = createCtx({ tx, actor: { kind: "system", jobId: "" } });
    const answers = await readSubmissionAnswers(ctx, r.personId!, "subject_result", [r.submissionId]);
    for (const a of answers) {
      if (!a.fieldKey.startsWith("score:")) continue;
      const v = a.value as { value?: unknown } | number | null;
      const n = typeof v === "number" ? v : typeof v?.value === "number" ? v.value : null;
      out.set(a.fieldKey, n);
    }
  });
  return out;
}

export default async function ResultPage({ params, searchParams }: { params: Params; searchParams: Search }) {
  const { locale: seg, slug, token } = await params;
  if (!localeFromSegment(seg)) notFound();
  const r = await getResultByToken(await getAppDb(), token);
  if (!r || r.formSlug !== slug) notFound();
  if ("expired" in r) {
    const expiredLocale = r.locale;
    const tr = translator(expiredLocale);
    const sent = (await searchParams).sent;
    const self = `/${seg}/f/${slug}/r/${token}`;
    // ID8: the same answer for a known and an unknown address; only the rate limit is told apart.
    async function sendLink(formData: FormData) {
      "use server";
      const raw = formData.get("email");
      const email = (typeof raw === "string" ? raw : "").slice(0, 254);
      const res = await requestResultLink({ slug, email, locale: expiredLocale });
      redirect(`${self}?sent=${!res.ok && res.error.code === "rate_limited" ? "limited" : "1"}` as never);
    }
    return (
      <div lang={expiredLocale} className="mx-auto max-w-xl space-y-4 px-4 py-16" data-result-state="expired">
        <h1 className="text-3xl font-bold">{tr("forms.public.expired_title")}</h1>
        <p className="text-muted-foreground">{tr("forms.public.expired_body")}</p>
        {sent === "1" || sent === "limited" ? (
          <p role="status" className="rounded-md border p-3" data-link-request={sent}>
            {tr(sent === "limited" ? "forms.public.rate_limited" : "forms.public.link_sent")}
          </p>
        ) : (
          <form action={sendLink} className="grid gap-3">
            <label htmlFor="result-link-email" className="font-medium">
              {tr("forms.public.email_label")}
            </label>
            <input id="result-link-email" name="email" type="email" required autoComplete="email" maxLength={254} className="min-h-11 rounded-md border bg-background px-3 text-base" />
            <button type="submit" className="min-h-11 rounded-md bg-primary px-4 font-medium text-primary-foreground">
              {tr("forms.public.send_link")}
            </button>
          </form>
        )}
      </div>
    );
  }
  const locale = r.locale;
  const tr = translator(locale);
  let decrypted = new Map<string, number | null>();
  try {
    decrypted = await sensitiveDimensions(r);
  } catch (error) {
    reportError(error, { tags: { module: "forms", step: "subject_result", form_slug: slug } });
  }
  const dims: ResultDimensionView[] = [];
  for (const key of r.ending.showDimensions) {
    const d = r.scoring.dimensions.find((x) => x.key === key);
    if (!d) continue;
    const value = r.score?.dimensions[key]?.value ?? decrypted.get(scoreKey(key)) ?? null;
    if (value === null || value === undefined) continue; // edge case 5: a null dimension is hidden
    const range = findRange(d.ranges, value);
    dims.push({ key, label: text(d.label, locale) ?? key, value, rangeLabel: range ? text(range.label, locale) : null, explanation: range ? text(range.explanation, locale) : null });
  }
  const total = r.ending.showScore ? (r.score?.total ?? null) : null;
  const totalRange = total !== null && r.scoring.total ? findRange(r.scoring.total.ranges, total) : null;
  return (
    <div className="px-4 py-10 sm:px-6" data-result-state="ok">
      <ResultView
        token={token}
        locale={locale}
        formTitle={text(r.title, locale) ?? slug}
        endingTitle={text(r.ending.title, locale) ?? ""}
        endingBody={text(r.ending.body, locale) ?? ""}
        total={total}
        totalRangeLabel={totalRange ? text(totalRange.label, locale) : null}
        dimensions={dims}
        outcome={r.outcome ? { label: text(r.outcome.label, locale) ?? r.outcome.key, explanation: text(r.outcome.explanation, locale), recommendation: text(r.outcome.recommendation, locale) } : null}
        ctas={r.ending.ctas.slice(0, 4).map((c) => ({ key: c.key, label: text(c.label, locale) ?? c.key, url: ctaRedirectUrl(token, c.key) }))}
        labels={{
          your_score: tr("forms.result.your_score"),
          your_profile: tr("forms.result.your_profile"),
          recommended_for_you: tr("forms.result.recommended_for_you"),
          next_steps: tr("forms.result.next_steps"),
        }}
      />
    </div>
  );
}
