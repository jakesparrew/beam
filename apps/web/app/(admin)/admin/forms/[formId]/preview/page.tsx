import Link from "next/link";
import { notFound } from "next/navigation";
import { validateForPublish } from "@beam/core/forms";
import { isLocale } from "@beam/core/i18n";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { getForm, getFormVersion, localeNames, screenLabels } from "@/modules/forms/queries";
import { IssuesPanel } from "@/modules/forms/ui/admin/issues-panel";
import { PreviewFrame } from "@/modules/forms/ui/admin/preview-frame";
import { publicLabels } from "@/modules/forms/ui/public/form-embed";

type Search = { version?: string; locale?: string };

/** `/admin/forms/[formId]/preview?version=&locale=` (`forms.write`): the public inputs and engine, nothing saved. */
export default async function FormPreviewPage({ params, searchParams }: { params: Promise<{ formId: string }>; searchParams: Promise<Search> }) {
  await requireStaff({ permission: "forms.write" });
  const { formId } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(formId)) notFound();
  const staffLocale = await adminLocale();
  const tr = translator(staffLocale);
  const db = await getAppDb();
  const form = await getForm(db, formId);
  if (!form) notFound();
  const versionId = sp.version && /^[0-9a-f-]{36}$/i.test(sp.version) ? sp.version : (form.draft?.id ?? form.current?.id);
  const version = versionId ? await getFormVersion(db, versionId) : null;
  if (!version || version.formId !== form.id) notFound();
  const locale = isLocale(sp.locale) && version.locales.includes(sp.locale) ? sp.locale : (version.locales.includes(staffLocale) ? staffLocale : version.locales[0]!);
  const labels = screenLabels(staffLocale, ["preview", "builder", "scoring"]);
  const issues = validateForPublish(form.kind, version.definition, version.scoring, version.locales).filter((i) => i.level === "error");
  const names = localeNames(staffLocale);
  const versionLabel = version.publishedAt ? tr("forms.preview.version_n", { n: version.version }) : tr("forms.preview.draft", { n: version.version });

  return (
    <div className="grid gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{tr("forms.preview.title", { name: form.name[staffLocale] || form.slug })}</h1>
        <nav aria-label={tr("forms.preview.locale")} className="flex gap-2 text-sm">
          {version.locales.map((l) => (
            <Link key={l} aria-current={l === locale ? "true" : undefined} className={l === locale ? "font-semibold underline" : "underline"} href={`/admin/forms/${form.id}/preview?version=${version.id}&locale=${l}`}>
              {names[l]}
            </Link>
          ))}
          <Link className="underline" href={`/admin/forms/${form.id}`}>
            {tr("forms.builder.back_to_overview")}
          </Link>
        </nav>
      </header>
      {issues.length ? (
        <section className="grid gap-2 rounded-md border p-3">
          <h2 className="font-medium">{tr("forms.preview.invalid")}</h2>
          <IssuesPanel issues={issues} labels={labels} builderHref={`/admin/forms/${form.id}/build`} />
        </section>
      ) : null}
      <PreviewFrame key={`${version.id}:${locale}`} definition={version.definition} scoring={version.scoring} locale={locale} labels={labels} publicLabels={publicLabels(locale)} versionLabel={versionLabel} />
    </div>
  );
}
