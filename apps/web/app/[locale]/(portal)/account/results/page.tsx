import type { Route } from "next";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { formatDate, localeFromSegment, URL_SEGMENT, type Locale, type LocalizedText } from "@beam/core/i18n";
import { action } from "@/lib/action";
import { requireCustomer } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { flag } from "@/lib/flags";
import { translator } from "@/lib/i18n";
import { featuredAssessment, listPortalResults, openPortalResult } from "@/modules/forms/service/submissions";
import { ResultsList } from "@/modules/forms/ui/portal/results-list";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string }>; searchParams: Promise<{ error?: string }> };

/**
 * "View result": the customer's own completed submission only (`not_found` otherwise); a fresh
 * result token, then the result page. Audience `customer`, so no staff audit row.
 */
const openMyResult = action(
  { name: "forms.open_my_result", audience: "customer", input: z.object({ submissionId: z.uuid() }) },
  (ctx, input) => openPortalResult(ctx.tx, ctx, input),
);

/** The customer-facing form name in the page locale; the slug when that locale is missing (no fallback language). */
const nameIn = (name: LocalizedText, slug: string, locale: Locale): string => name[locale]?.trim() || slug;

/**
 * `/[locale]/account/results` (forms spec section 5 "Customer portal", R2, behind
 * `ff_forms_portal_results`): the logged-in customer's completed submissions (form, date, outcome
 * label, "View result" through a fresh result token) and open submissions with "Continue" (the
 * hosted form continues the same submission for the session, U5). Filtered on
 * `actor.personId`. Empty: "You have not completed an assessment yet" with a link to the newest
 * published assessment.
 */
export default async function MyResultsPage({ params, searchParams }: Props) {
  const { locale: seg } = await params;
  const locale = localeFromSegment(seg);
  if (!locale) notFound();
  const actor = await requireCustomer(locale);
  if (!(await flag("ff_forms_portal_results", actor))) notFound();
  const tr = translator(locale);
  const { error } = await searchParams;
  const db = await getAppDb();
  const now = new Date();
  const results = await listPortalResults(db, actor.personId, now);
  const featured = results.completed.length || results.open.length ? null : await featuredAssessment(db, locale);
  const prefix = `/${URL_SEGMENT[locale]}`;
  const here = `${prefix}/account/results`;

  async function view(formData: FormData) {
    "use server";
    const id = formData.get("submissionId");
    const r = await openMyResult({ submissionId: typeof id === "string" ? id : "" });
    if (r.ok) redirect(r.data.url as Route);
    redirect(`${here}?error=1` as Route);
  }

  const date = (d: Date) => formatDate(d, locale, "long");
  return (
    <section aria-labelledby="my-results-title" className="space-y-6">
      <header className="space-y-2">
        <h1 id="my-results-title" className="text-2xl font-semibold">
          {tr("forms.portal.results.title")}
        </h1>
        <p className="text-muted-foreground">{tr("forms.portal.results.intro")}</p>
      </header>
      <div aria-live="polite">
        {error ? (
          <p role="status" className="rounded-md border border-destructive p-3 text-sm">
            {tr("forms.portal.results.error")}
          </p>
        ) : null}
      </div>
      <ResultsList
        labels={{
          completedHeading: tr("forms.portal.results.completed_heading"),
          openHeading: tr("forms.portal.results.open_heading"),
          viewResult: tr("forms.portal.results.view_result"),
          continue: tr("forms.portal.results.continue"),
          noResultPage: tr("forms.portal.results.no_result_page"),
          empty: tr("forms.portal.results.empty"),
        }}
        completed={results.completed.map((c) => {
          const title = nameIn(c.formName, c.formSlug, locale);
          const outcome = c.outcomeLabel?.[locale]?.trim();
          return {
            submissionId: c.submissionId,
            title,
            when: tr("forms.portal.results.completed_on", { date: date(c.completedAt) }),
            outcome: outcome ? tr("forms.portal.results.outcome", { outcome }) : null,
            hasResultPage: c.hasResultPage,
            viewLabel: tr("forms.portal.results.view_result_for", { form: title }),
          };
        })}
        open={results.open.map((o) => {
          const title = nameIn(o.formName, o.formSlug, locale);
          return {
            submissionId: o.submissionId,
            title,
            when: tr("forms.portal.results.last_activity", { date: date(o.lastActivityAt) }),
            href: `${prefix}/f/${o.formSlug}`,
            continueLabel: tr("forms.portal.results.continue_for", { form: title }),
          };
        })}
        viewAction={view}
        emptyAction={
          featured ? (
            <a href={`${prefix}/f/${featured.slug}`} className="inline-flex min-h-11 items-center underline underline-offset-2">
              {tr("forms.portal.results.empty_cta", { form: nameIn(featured.name, featured.slug, locale) })}
            </a>
          ) : undefined
        }
      />
    </section>
  );
}
