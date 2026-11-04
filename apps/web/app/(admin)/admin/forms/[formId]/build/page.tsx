import Link from "next/link";
import { notFound } from "next/navigation";
import { EmptyState } from "@beam/ui";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { getForm, getFormVersion, localeNames, screenLabels } from "@/modules/forms/queries";
import { FormBuilder } from "@/modules/forms/ui/admin/field-tree";
import { RestoreButton } from "@/modules/forms/ui/admin/form-list";

/** `/admin/forms/[formId]/build` (`forms.write`; Publish needs `forms.publish`): the three-pane builder of the draft. */
export default async function FormBuildPage({ params }: { params: Promise<{ formId: string }> }) {
  const actor = await requireStaff({ permission: "forms.write" });
  const { formId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(formId)) notFound();
  const locale = await adminLocale();
  const tr = translator(locale);
  const db = await getAppDb();
  const form = await getForm(db, formId);
  if (!form) notFound();
  const labels = screenLabels(locale, ["builder", "scoring", "versions"]);
  const title = (
    <header className="flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-2xl font-semibold">{tr("forms.builder.title", { name: form.name[locale] || form.slug })}</h1>
      <Link className="text-sm underline" href={`/admin/forms/${form.id}`}>
        {tr("forms.builder.back_to_overview")}
      </Link>
    </header>
  );
  if (!form.draft) {
    return (
      <div className="grid gap-6">
        {title}
        <EmptyState
          title={tr("forms.builder.no_draft")}
          action={form.current ? <RestoreButton formId={form.id} versionId={form.current.id} labels={{ ...labels, "versions.restore": tr("forms.builder.create_draft_from", { n: form.current.version }) }} /> : undefined}
        />
      </div>
    );
  }
  const draft = await getFormVersion(db, form.draft.id);
  if (!draft) notFound();
  return (
    <div className="grid gap-6">
      {title}
      <FormBuilder
        draft={{ formId: form.id, versionId: draft.id, definition: draft.definition, scoring: draft.scoring, locales: draft.locales, hash: draft.definitionHash }}
        kind={form.kind}
        labels={labels}
        locale={locale}
        localeNames={localeNames(locale)}
        canPublish={hasPermission(actor, "forms.publish")}
        ctaWarnings={form.ctaWarnings}
      />
    </div>
  );
}
