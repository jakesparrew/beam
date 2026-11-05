import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { getForm, listLinks, screenLabels } from "@/modules/forms/queries";
import { LinkTable } from "@/modules/forms/ui/admin/link-table";

/** `/admin/forms/[formId]/links` (`forms.write`): tracked links with URL, counts and QR downloads. */
export default async function FormLinksPage({ params }: { params: Promise<{ formId: string }> }) {
  await requireStaff({ permission: "forms.write" });
  const { formId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(formId)) notFound();
  const locale = await adminLocale();
  const tr = translator(locale);
  const db = await getAppDb();
  const form = await getForm(db, formId);
  if (!form) notFound();
  const rows = await listLinks(db, formId);
  return (
    <div className="grid gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{tr("forms.links.title", { name: form.name[locale] || form.slug })}</h1>
        <Link className="text-sm underline" href={`/admin/forms/${form.id}`}>
          {tr("forms.builder.back_to_overview")}
        </Link>
      </header>
      <LinkTable formId={form.id} rows={rows} labels={screenLabels(locale, ["links", "builder"])} />
    </div>
  );
}
