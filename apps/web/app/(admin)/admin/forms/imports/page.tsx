/**
 * `/admin/forms/imports` (`forms.publish`; forms spec section 5, rules I1 to I5), the Imports tab of
 * the forms page (owner review, November 2026): the ScoreApp and Typeform import sources with
 * provider, name, mirror form, last delivery and counts per status; the wizard creates a source
 * (its mirror form is published at once) and each row can be deactivated or opened.
 */
import Link from "next/link";
import { cn, EmptyState } from "@beam/ui";
import { formatDateTime } from "@beam/core/i18n";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { listImportSources, screenLabels } from "@/modules/forms/queries";
import { ImportSourceToggle, ImportWizard } from "@/modules/forms/ui/admin/import-wizard";
import { StatusPill, Surface, td, th } from "@/modules/platform/ui/admin-kit";
import { aboveRow, rowClass, rowLink } from "@/modules/platform/ui/admin-list-kit";
import { FormsHeader } from "../forms-header";

export const dynamic = "force-dynamic";

export default async function ImportSourcesPage() {
  await requireStaff({ permission: "forms.publish" });
  const locale = await adminLocale();
  const tr = translator(locale);
  const labels = screenLabels(locale, ["imports"]);
  const rows = await listImportSources(await getAppDb());
  return (
    <div className="grid gap-4">
      <FormsHeader active="imports" canImports tr={tr} />
      <p className="max-w-2xl text-[0.8125rem] text-muted-foreground">{tr("forms.imports.intro")}</p>
      <ImportWizard labels={labels} />
      {rows.length === 0 ? (
        <EmptyState title={tr("forms.imports.empty")} />
      ) : (
        <Surface flush>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[52rem] text-[0.8125rem]">
              <caption className="sr-only">{tr("forms.imports.title")}</caption>
              <thead className="bg-[#faf9f6]">
                <tr className="border-b border-border">
                  <th scope="col" className={th}>{tr("forms.imports.name")}</th>
                  <th scope="col" className={cn(th, "w-32")}>{tr("forms.imports.provider")}</th>
                  <th scope="col" className={cn(th, "w-44")}>{tr("forms.imports.mirror_form")}</th>
                  <th scope="col" className={cn(th, "w-40")}>{tr("forms.imports.last_received")}</th>
                  <th scope="col" className={th}>{tr("forms.imports.events")}</th>
                  <th scope="col" className={cn(th, "w-32")}>
                    <span className="sr-only">{tr("forms.imports.status")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={rowClass}>
                    <td className={td}>
                      <span className="flex items-center gap-2">
                        <Link className={cn(rowLink, "font-semibold hover:underline")} href={`/admin/forms/imports/${r.id}`}>
                          {r.name}
                        </Link>
                        {r.isActive ? null : <StatusPill tone="muted">{tr("forms.imports.inactive")}</StatusPill>}
                      </span>
                    </td>
                    <td className={td}>{tr(`forms.imports.provider_${r.provider}`)}</td>
                    <td className={td}>
                      <Link className={cn(aboveRow, "font-mono text-[0.75rem] hover:underline")} href={`/admin/forms/${r.formId}`}>
                        {r.formSlug}
                      </Link>
                    </td>
                    <td className={cn(td, "whitespace-nowrap text-muted-foreground")}>{r.lastReceivedAt ? formatDateTime(r.lastReceivedAt, locale) : tr("forms.imports.never")}</td>
                    <td className={cn(td, "text-muted-foreground")}>{tr("forms.imports.counts", { ...r.counts })}</td>
                    <td className={cn(td, "text-right")}>
                      <span className={aboveRow}>
                        <ImportSourceToggle sourceId={r.id} isActive={r.isActive} labels={labels} />
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Surface>
      )}
    </div>
  );
}
