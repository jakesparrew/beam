import Link from "next/link";
import { notFound } from "next/navigation";
import { EmptyState } from "@beam/ui";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { getForm, getFormVersion, localeNames, screenLabels } from "@/modules/forms/queries";
import { RestoreButton } from "@/modules/forms/ui/admin/form-list";
import { ScoringEditor } from "@/modules/forms/ui/admin/scoring-editor";

/** `/admin/forms/[formId]/scoring` (`forms.write`): dimensions, total and outcomes of the draft, saved through `saveDraft`. */
export default async function FormScoringPage({ params }: { params: Promise<{ formId: string }> }) {
  await requireStaff({ permission: "forms.write" });
  const { formId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(formId)) notFound();
  const locale = await adminLocale();
  const tr = translator(locale);
  const db = await getAppDb();
  const form = await getForm(db, formId);
  if (!form) notFound();
  const labels = screenLabels(locale, ["builder", "scoring", "versions"]);
  const header = (
    <header className="flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-2xl font-semibold">{tr("forms.scoring.title", { name: form.name[locale] || form.slug })}</h1>
      <Link className="text-sm underline" href={`/admin/forms/${form.id}`}>
        {tr("forms.builder.back_to_overview")}
      </Link>
    </header>
  );
  const draft = form.draft ? await getFormVersion(db, form.draft.id) : null;
  if (!draft) {
    return (
      <div className="grid gap-6">
        {header}
        <EmptyState
          title={tr("forms.builder.no_draft")}
          action={form.current ? <RestoreButton formId={form.id} versionId={form.current.id} labels={{ ...labels, "versions.restore": tr("forms.builder.create_draft_from", { n: form.current.version }) }} /> : undefined}
        />
      </div>
    );
  }
  return (
    <div className="grid gap-6">
      {header}
      <ScoringEditor
        draft={{ formId: form.id, versionId: draft.id, definition: draft.definition, scoring: draft.scoring, locales: draft.locales, hash: draft.definitionHash }}
        kind={form.kind}
        labels={labels}
        locale={locale}
        localeNames={localeNames(locale)}
      />
    </div>
  );
}
