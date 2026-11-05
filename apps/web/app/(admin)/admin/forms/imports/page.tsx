/**
 * `/admin/forms/imports` (`forms.publish`; forms spec section 5, rules I1 to I5): the ScoreApp
 * and Typeform import sources with provider, name, mirror form, last delivery and counts per
 * status; the wizard creates a source (its mirror form is published at once) and each row can be
 * deactivated or opened.
 */
import Link from "next/link";
import { Badge, EmptyState, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { formatDateTime } from "@beam/core/i18n";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { listImportSources, screenLabels } from "@/modules/forms/queries";
import { ImportSourceToggle, ImportWizard } from "@/modules/forms/ui/admin/import-wizard";

export const dynamic = "force-dynamic";

export default async function ImportSourcesPage() {
  await requireStaff({ permission: "forms.publish" });
  const locale = await adminLocale();
  const tr = translator(locale);
  const labels = screenLabels(locale, ["imports"]);
  const rows = await listImportSources(await getAppDb());
  return (
    <div className="grid gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="grid gap-1">
          <h1 className="text-2xl font-semibold">{tr("forms.imports.title")}</h1>
          <p className="text-sm text-muted-foreground">{tr("forms.imports.intro")}</p>
        </div>
        <Link className="text-sm underline" href="/admin/forms">
          {tr("forms.nav.forms")}
        </Link>
      </header>
      <ImportWizard labels={labels} />
      {rows.length === 0 ? (
        <EmptyState title={tr("forms.imports.empty")} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{tr("forms.imports.name")}</TableHead>
              <TableHead>{tr("forms.imports.provider")}</TableHead>
              <TableHead>{tr("forms.imports.mirror_form")}</TableHead>
              <TableHead>{tr("forms.imports.last_received")}</TableHead>
              <TableHead>{tr("forms.imports.events")}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <Link className="font-medium underline" href={`/admin/forms/imports/${r.id}`}>
                      {r.name}
                    </Link>
                    {r.isActive ? null : <Badge variant="outline">{tr("forms.imports.inactive")}</Badge>}
                  </div>
                </TableCell>
                <TableCell>{tr(`forms.imports.provider_${r.provider}`)}</TableCell>
                <TableCell>
                  <Link className="text-sm underline" href={`/admin/forms/${r.formId}`}>
                    {r.formSlug}
                  </Link>
                </TableCell>
                <TableCell className="whitespace-nowrap text-sm">{r.lastReceivedAt ? formatDateTime(r.lastReceivedAt, locale) : tr("forms.imports.never")}</TableCell>
                <TableCell className="text-sm">{tr("forms.imports.counts", { ...r.counts })}</TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-2">
                    <ImportSourceToggle sourceId={r.id} isActive={r.isActive} labels={labels} />
                    <Link className="text-sm underline" href={`/admin/forms/imports/${r.id}`}>
                      {tr("forms.imports.open")}
                    </Link>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
