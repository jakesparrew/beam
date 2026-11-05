/**
 * `/admin/forms/[formId]/submissions` (`forms.write` and `persons.read`; forms spec section 5):
 * the submissions of a form with filters (status, outcome, version, source, funnel, dates, person)
 * and cursor paging, the CSV export of the filtered rows (non-sensitive columns only) and a link to
 * the report.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { getForm, getSubmissionFilterOptions, listSubmissions, parseSubmissionFilter, screenLabels } from "@/modules/forms/queries";
import { filterQuery, SubmissionTable } from "@/modules/forms/ui/admin/submission-table";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f-]{36}$/i;

export default async function SubmissionsPage({ params, searchParams }: { params: Promise<{ formId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const actor = await requireStaff({ permission: "forms.write" });
  if (!hasPermission(actor, "persons.read")) notFound();
  const { formId } = await params;
  if (!UUID.test(formId)) notFound();
  const locale = await adminLocale();
  const tr = translator(locale);
  const db = await getAppDb();
  const form = await getForm(db, formId);
  if (!form) notFound();
  const filter = parseSubmissionFilter(await searchParams);
  const [page, options] = await Promise.all([listSubmissions(db, { formId, ...filter }), getSubmissionFilterOptions(db, formId)]);
  const outcomeLabels = Object.fromEntries(options.outcomes.map((o) => [o.key, o.label[locale] || o.key]));
  const { cursor: _cursor, ...exportFilter } = filter;
  return (
    <div className="grid gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{tr("forms.submissions.title", { name: form.name[locale] || form.slug })}</h1>
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <a className="underline" href={`/admin/forms/${form.id}/submissions/export${filterQuery(exportFilter)}`} title={tr("forms.submissions.export_hint")} download>
            {tr("forms.submissions.export_csv")}
          </a>
          <Link className="underline" href={`/admin/forms/${form.id}/report` as never}>
            {tr("forms.submissions.report_link")}
          </Link>
          <Link className="underline" href={`/admin/forms/${form.id}`}>
            {tr("forms.submissions.back_to_overview")}
          </Link>
        </div>
      </header>
      <SubmissionTable
        formId={form.id}
        rows={page.rows}
        nextCursor={page.nextCursor}
        filter={filter}
        options={options}
        outcomeLabels={outcomeLabels}
        locale={locale}
        labels={screenLabels(locale, ["submissions", "list"])}
      />
    </div>
  );
}
